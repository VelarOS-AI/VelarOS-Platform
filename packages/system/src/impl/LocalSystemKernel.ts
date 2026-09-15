/**
 * 本地内核：`LocalSystemKernel`，宿主端口 `ctx.system` 在本机上的实现。接口见 `interface/provides.ts` 的 `LocalSystemKernelApi`。
 * 它只做转接：命令、后台任务与交互式任务的控制台交给命令执行器，演练沙箱交给沙箱登记表（cwd 落在镜像根内的命令走沙箱专属执行器），搜索交给全局搜索，进程、端口、指标跑平台命令读出来。
 */

import { cpus, freemem, homedir, loadavg, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { isEmpty, Log, toNullable } from '@velaros-ai/core'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import { createPlatform } from '@velaros-ai/platform'
import type { CommandSpec } from '@velaros-ai/platform/contracts'

import type { LocalSystemKernelOptions, SystemToolSystemApi } from '../contract/requires.js'
import type { ResolvedSystemShell } from '../types/commands.js'
import type { SystemBackgroundTaskQueryOptions, SystemBackgroundTaskRecord, SystemBackgroundTaskTerminateRequest, SystemBackgroundTaskTerminateResult, SystemCommandResult, SystemConsoleControlResult, SystemConsoleInputRequest, SystemConsoleInterruptRequest, SystemConsoleOutputChunk, SystemConsoleOutputRequest, SystemEnvironmentInspection, SystemGlobalSearchOptions, SystemGlobalSearchResult, SystemMetricsSnapshot, SystemOpenPortInfo, SystemOpenPortQueryOptions, SystemProcessInfo, SystemProcessQueryOptions, SystemRunCommandOptions, SystemSandboxApplyOptions, SystemSandboxApplyResult, SystemSandboxCreateOptions, SystemSandboxDiff, SystemSandboxDiffOptions, SystemSandboxDiscardResult, SystemSandboxRecord, SystemShellEnvironmentRefreshResult } from '../types/system.js'
import { runPlatformCommand } from '../utils/process.js'
import { toShellDescriptor } from '../utils/shell.js'
import {
  collectPortPids,
  metricLevel,
  parseCpuUsagePercent,
  parseDiskStats,
  parseOpenPortEntries,
  parseProcessRows,
  parseSwapStats,
  selectOpenPorts,
  selectSystemProcesses,
} from '../utils/system-info.js'
import { SystemTuning } from '../utils/tuning.js'

import type { SystemCommandRunnerApi } from './SystemCommandRunner.js'
import { SystemCommandRunner } from './SystemCommandRunner.js'
import type { SystemGlobalSearchApi } from './SystemGlobalSearch.js'
import { SystemGlobalSearch } from './SystemGlobalSearch.js'
import { systemProcessManager } from './SystemProcessManager.js'
import type { SystemSandboxesApi } from './SystemSandboxes.js'
import { SystemSandboxes } from './SystemSandboxes.js'
import type { SystemShellResolverApi } from './SystemShellResolver.js'
import { systemShellResolver } from './SystemShellResolver.js'

const log = Log.tag('LocalSystemKernel')

/** 按构造选项创建一个本地内核。 */
export function createLocalSystemKernel(options: LocalSystemKernelOptions): LocalSystemKernelApi {
  return new LocalSystemKernel(options)
}

/**
 * 本地内核：宿主端口 `ctx.system` 在本机上的实现，产品壳创建一个交给工具用。
 *
 * 实现是 `LocalSystemKernel`，只做转接：命令与后台任务交给命令执行器，搜索交给全局搜索，
 * 进程、端口、指标跑平台命令读出来。相对路径都相对构造时给的 cwd，`~` 展开到家目录。
 * 宿主端口本身的方法见 `requires.ts` 的 `SystemToolSystemApi`；这里另给产品壳十一个方法：环境检查、指标、释放、沙箱列表，
 * 全局搜索、进程、端口、终止后台任务，以及交互式任务的控制台三件事（写输入、读增量输出、发中断）。
 * 这些方法都没有工具在调（模型改用 `system:run` 跑系统命令，控制台归用户），是宿主自己的界面要的。由 `createLocalSystemKernel(options)` 创建。
 */
export interface LocalSystemKernelApi extends SystemToolSystemApi {
  /** 环境检查：操作系统、经过自检的 shell 和它的 PATH，以及给定的每个命令在不在、在哪。 */
  inspectEnvironment(commands?: string[]): Promise<SystemEnvironmentInspection>
  /** 系统指标快照：CPU、内存、交换区、系统盘、负载各自的用量和告警级别，外加占用最高的 5 个进程；读不到的项为 null。 */
  getSystemMetrics(): Promise<SystemMetricsSnapshot>
  /** 释放：停掉这个内核启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
  /** 在一棵目录树里按路径名或文件内容搜索，跳过隐藏项、依赖目录、gitignore 忽略项和受保护目录，最多 limit 条。 */
  globalSearch(options: SystemGlobalSearchOptions, abortSignal?: AbortSignal): Promise<SystemGlobalSearchResult>
  /** 列出本机进程（名称、命令行、用户、CPU、内存），可按 pid、名字、命令行片段、用户、资源占用筛选，最多 limit 条（默认 50）。 */
  listProcesses(options?: SystemProcessQueryOptions): Promise<SystemProcessInfo[]>
  /** 列出正在监听的 TCP 端口和占用它们的进程，可按端口、端口范围、进程筛选，最多 limit 条（默认 50）。 */
  listOpenPorts(options?: SystemOpenPortQueryOptions): Promise<SystemOpenPortInfo[]>
  /** 登记着的演练沙箱，给宿主界面列沙箱、展示差量用。 */
  listSandboxes(): SystemSandboxRecord[]
  /** 终止一个后台任务：核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号并等它退出；返回终止前后的状态。 */
  terminateBackgroundTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult>
  /**
   * 往交互式任务的控制台写一段用户输入，缺省在末尾补一个换行（相当于用户按回车）。
   * 任务不存在、不属于请求里的会话时抛错；进程已经退出或这条任务不是交互式的，不抛错，结果里 `accepted` 为 false 并说明原因。
   */
  writeConsoleInput(request: SystemConsoleInputRequest): Promise<SystemConsoleControlResult>
  /**
   * 读控制台从 `cursor` 起的增量输出，返回新文本和下一次的 cursor；不给 cursor 就从缓冲区里留着的最早一段开始。
   * 缓冲区只留最近的一段，被挤掉的字符数如实写在 `droppedChars` 里，不假装输出是连续的。任务不存在或不属于该会话时抛错。
   */
  readConsoleOutput(request: SystemConsoleOutputRequest): Promise<SystemConsoleOutputChunk>
  /**
   * 给控制台发中断，相当于用户按 Ctrl+C：POSIX 上向整个进程组发 SIGINT，Windows 上退回按进程树终止。
   * 任务不存在、不属于请求里的会话时抛错；进程已经退出时不抛错，结果里 `accepted` 为 false。
   */
  interruptConsole(request: SystemConsoleInterruptRequest): Promise<SystemConsoleControlResult>
}

export class LocalSystemKernel implements LocalSystemKernelApi {
  private readonly homeDir: string
  private readonly hostPlatform: NodeJS.Platform
  private readonly platformTools: PlatformCompatibilityApi
  private readonly workingDirectory: string
  private readonly shells: SystemShellResolverApi = systemShellResolver
  private readonly commands: SystemCommandRunnerApi
  private readonly search: SystemGlobalSearchApi
  private readonly sandboxes: SystemSandboxesApi

  constructor(options: LocalSystemKernelOptions) {
    const root = resolve(options.cwd)
    this.homeDir = options.homeDir ?? homedir()
    this.hostPlatform = options.platform ?? platform()
    this.platformTools = createPlatform({ platform: this.hostPlatform, env: process.env })
    this.workingDirectory = root
    const confinement: NonNullable<LocalSystemKernelOptions['processConfinement']> =
      options.processConfinement ?? { mode: 'danger-full-access', workspaceRoot: root }
    this.commands = new SystemCommandRunner({
      platform: this.hostPlatform,
      platformTools: this.platformTools,
      confinement: {
        mode: confinement.mode,
        workspaceRoot: confinement.workspaceRoot ?? root,
        writeRoots: confinement.writeRoots,
        network: confinement.network,
      },
      confinementProvider: confinement.provider,
      shells: this.shells,
      processes: systemProcessManager,
    })
    this.search = new SystemGlobalSearch({ platform: this.hostPlatform, homeDir: this.homeDir })
    this.sandboxes = new SystemSandboxes({
      platform: this.hostPlatform,
      platformTools: this.platformTools,
      confinementProvider: confinement.provider,
      shells: this.shells,
      processes: systemProcessManager,
    })
  }

  public async inspectEnvironment(commands: string[] = []): Promise<SystemEnvironmentInspection> {
    const shell = await this.resolveShell()
    const commandAvailability = await Promise.all(commands.map((name) => this.shells.resolveCommand(name, shell)))

    return {
      os: {
        platform: this.hostPlatform,
        arch: process.arch,
        release: release(),
        homeDir: homedir(),
      },
      shell: {
        path: shell.shellPath,
        kind: shell.kind, name: shell.name, readiness: shell.readiness,
        version: shell.version, recommendation: shell.recommendation,
        variableCount: Object.keys(shell.env).length,
        pathEntries: this.platformTools.getPathEntries(shell.env),
      },
      commands: commandAvailability,
    }
  }

  public async getSystemMetrics(): Promise<SystemMetricsSnapshot> {
    const totalMemory = totalmem()
    const usedMemory = totalMemory - freemem()
    const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg()
    const cpuCoreCount = Math.max(cpus().length, 1)
    const [cpuUsagePercent, diskStats, swapStats, topProcesses] = await Promise.all([
      this.readPlatformStat(this.platformTools.getCpuUsageCommandSpec(), parseCpuUsagePercent, 'CPU usage'),
      this.readPlatformStat(this.platformTools.getDiskStatsCommandSpec(), parseDiskStats, 'disk stats'),
      this.readPlatformStat(this.platformTools.getSwapStatsCommandSpec(), parseSwapStats, 'swap stats'),
      this.listProcesses({ limit: SystemTuning.systemInfo.topProcesses }),
    ])
    const swapUsagePercent = swapStats && swapStats.totalBytes > 0
      ? (swapStats.usedBytes / swapStats.totalBytes) * 100
      : null
    const diskUsagePercent = diskStats && diskStats.totalBytes > 0
      ? (diskStats.usedBytes / diskStats.totalBytes) * 100
      : null

    return {
      sampledAt: Date.now(),
      cpuUsagePercent,
      cpuCoreCount,
      memoryUsedBytes: usedMemory,
      memoryTotalBytes: totalMemory,
      memoryUsagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0,
      swapUsedBytes: toNullable(swapStats?.usedBytes),
      swapTotalBytes: toNullable(swapStats?.totalBytes),
      swapUsagePercent,
      diskUsedBytes: toNullable(diskStats?.usedBytes),
      diskTotalBytes: toNullable(diskStats?.totalBytes),
      diskUsagePercent,
      loadAverage: { oneMinute, fiveMinutes, fifteenMinutes },
      levels: {
        cpu: metricLevel(cpuUsagePercent, SystemTuning.systemInfo.levels.cpu),
        memory: metricLevel(totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0, SystemTuning.systemInfo.levels.memory),
        swap: metricLevel(swapUsagePercent, SystemTuning.systemInfo.levels.swap),
        disk: metricLevel(diskUsagePercent, SystemTuning.systemInfo.levels.disk),
        load: metricLevel((oneMinute / cpuCoreCount) * 100, SystemTuning.systemInfo.levels.load),
      },
      topProcesses,
    }
  }

  public async globalSearch(
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    abortSignal?.throwIfAborted()
    return this.search.search(this.resolvePath(options.rootPath ?? this.workingDirectory), options, abortSignal)
  }

  public async listProcesses(options: SystemProcessQueryOptions = {}): Promise<SystemProcessInfo[]> {
    const commandSpec = this.platformTools.getProcessListCommandSpec()
    if (!commandSpec) return []

    const output = await runPlatformCommand(commandSpec)
    return selectSystemProcesses(parseProcessRows(output.stdout, this.hostPlatform), options)
  }

  public async listOpenPorts(options: SystemOpenPortQueryOptions = {}): Promise<SystemOpenPortInfo[]> {
    const commandSpec = this.platformTools.getOpenPortInspectionCommandSpec()
    if (!commandSpec) return []

    const output = await runPlatformCommand(commandSpec, { tolerateLsofEmptyResult: true })
    const entries = parseOpenPortEntries(output.stdout, this.hostPlatform)
    const pids = collectPortPids(entries)
    const owners = isEmpty(pids)
      ? []
      : await this.listProcesses({ pids, includeCwd: !!options.includeCwd, limit: pids.length })
    return selectOpenPorts(entries, new Map(owners.map((processInfo) => [processInfo.pid, processInfo])), options)
  }

  public async listBackgroundTasks(options: SystemBackgroundTaskQueryOptions = {}): Promise<SystemBackgroundTaskRecord[]> {
    const tasks = [this.commands, ...this.sandboxes.runners()].flatMap((runner) => runner.listTasks(options))
    return tasks.sort((a, b) => b.startedAt - a.startedAt).slice(0, options.limit ?? SystemTuning.command.taskListItems)
  }

  public terminateBackgroundTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult> {
    return this.runnerOwning(request.taskId).terminateTask(request)
  }

  public writeConsoleInput(request: SystemConsoleInputRequest): Promise<SystemConsoleControlResult> {
    return this.runnerOwning(request.taskId).writeConsoleInput(request)
  }

  public readConsoleOutput(request: SystemConsoleOutputRequest): Promise<SystemConsoleOutputChunk> {
    return this.runnerOwning(request.taskId).readConsoleOutput(request)
  }

  public interruptConsole(request: SystemConsoleInterruptRequest): Promise<SystemConsoleControlResult> {
    return this.runnerOwning(request.taskId).interruptConsole(request)
  }

  public async refreshShellEnvironment(): Promise<SystemShellEnvironmentRefreshResult> {
    // Windows 上重读用户与系统环境变量并写回本进程，之后起的子进程才看得到新装的命令；其他平台每条命令都经登录 shell 重读配置，这里只重新选 shell。
    const refreshed = await this.shells.refreshWindowsEnvironment(process.env, this.hostPlatform)
    if (this.hostPlatform === 'win32' && refreshed.refreshed) {
      for (const key of Object.keys(process.env)) if (!(key in refreshed.env)) delete process.env[key]
      Object.assign(process.env, refreshed.env)
    }
    const shell = await this.resolveShell()
    const result: SystemShellEnvironmentRefreshResult = {
      shell: shell.shellPath,
      runtime: toShellDescriptor(shell),
      variableCount: Object.keys(shell.env).length,
      refreshedAt: Date.now(),
      revision: refreshed.revision,
    }
    if (refreshed.reason) result.reason = refreshed.reason
    return result
  }

  public runCommand(
    command: string,
    options: SystemRunCommandOptions = {},
    _allowDangerous = false,
    abortSignal?: AbortSignal
  ): Promise<SystemCommandResult> {
    const cwd = this.resolvePath(options.cwd)
    // cwd 落在某个沙箱根之内，就交给那个沙箱专属的执行器：约束钉死在镜像根，写不到源目录。
    return this.sandboxes.runnerFor(cwd).then((runner) => (runner ?? this.commands).run(command, cwd, options, abortSignal))
  }

  public resolvePath(path?: string): string {
    const given = path ?? this.workingDirectory
    const expanded = given === '~' ? this.homeDir : /^~[\\/]/.test(given) ? join(this.homeDir, given.slice(2)) : given
    return isAbsolute(expanded) ? resolve(expanded) : resolve(this.workingDirectory, expanded)
  }

  public createSandbox(options: SystemSandboxCreateOptions = {}): Promise<SystemSandboxRecord> {
    return this.sandboxes.create(this.resolvePath(options.source), { network: !!options.network, ignored: options.ignored ?? 'link' })
  }

  public diffSandbox(options: SystemSandboxDiffOptions): Promise<SystemSandboxDiff> {
    return this.sandboxes.diff(options)
  }

  public applySandbox(options: SystemSandboxApplyOptions): Promise<SystemSandboxApplyResult> {
    return this.sandboxes.apply(options)
  }

  public discardSandbox(sandboxId: string): Promise<SystemSandboxDiscardResult> {
    return this.sandboxes.discard(sandboxId)
  }

  public listSandboxes(): SystemSandboxRecord[] {
    return this.sandboxes.list()
  }

  public async dispose(): Promise<void> {
    await this.sandboxes.dispose()
    await this.commands.dispose()
  }

  /** 哪个执行器登记着这条任务：沙箱执行器里都找不到就交给主执行器，它会按自己的规则报不存在。 */
  private runnerOwning(taskId: string): SystemCommandRunnerApi {
    return this.sandboxes.runners().find((runner) => !isEmpty(runner.listTasks({ taskId }))) ?? this.commands
  }

  /** 选出本机经过自检、真能工作的 shell。 */
  private resolveShell(): Promise<ResolvedSystemShell> {
    return this.shells.resolveReady({ platform: this.hostPlatform, env: process.env })
  }

  /** 跑一条读指标的平台命令并解析；平台不支持或读失败时返回 null，指标里对应项留空。 */
  private async readPlatformStat<T>(
    commandSpec: Nullable<CommandSpec>,
    parse: (stdout: string, platform: NodeJS.Platform) => Nullable<T>,
    label: string
  ): Promise<Nullable<T>> {
    if (!commandSpec) return null
    try {
      const output = await runPlatformCommand(commandSpec)
      return parse(output.stdout, this.hostPlatform)
    } catch (error) {
      log.debug(`failed to read local kernel ${label}`, { error })
      return null
    }
  }
}
