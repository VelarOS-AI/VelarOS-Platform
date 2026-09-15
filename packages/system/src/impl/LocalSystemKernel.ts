/**
 * 本地内核：`LocalSystemKernel`，宿主端口 `ctx.system` 在本机上的实现。接口见 `contract/host.ts` 的 `LocalSystemKernelApi`。
 * 它只做转接：命令与后台任务交给命令执行器，搜索交给全局搜索，进程、端口、指标跑平台命令读出来。
 */

import { cpus, freemem, homedir, loadavg, platform, release, totalmem } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { isEmpty, Log, toNullable } from '@velaros-ai/core'

import type { ResolvedSystemShell } from '../contract/commands.js'
import type { CommandSpec } from '../contract/platform.js'
import type {
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandResult,
  SystemCommandRunQueryOptions,
  SystemCommandRunRecord,
  SystemEnvironmentInspection,
  SystemGlobalSearchOptions,
  SystemGlobalSearchResult,
  SystemMetricsSnapshot,
  SystemOpenPortInfo,
  SystemOpenPortQueryOptions,
  SystemProcessInfo,
  SystemProcessQueryOptions,
  SystemRunCommandOptions,
  SystemShellEnvironmentRefreshResult,
} from '../contract/system.js'
import type { SystemCommandRunnerApi, SystemShellResolverApi } from '../interface/internal.js'
import type { SystemGlobalSearchApi } from '../interface/internal.js'
import type { LocalSystemKernelApi } from '../interface/provides.js'
import type { SystemPlatformCompatibilityApi } from '../interface/provides.js'
import type { LocalSystemKernelOptions } from '../interface/requires.js'
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

import { SystemCommandRunner } from './SystemCommandRunner.js'
import { SystemGlobalSearch } from './SystemGlobalSearch.js'
import { SystemPlatformCompatibility } from './SystemPlatformCompatibility.js'
import { systemProcessManager } from './SystemProcessManager.js'
import { systemShellResolver } from './SystemShellResolver.js'

const log = Log.tag('LocalSystemKernel')

/** 按构造选项创建一个本地内核。 */
export function createLocalSystemKernel(options: LocalSystemKernelOptions): LocalSystemKernelApi {
  return new LocalSystemKernel(options)
}

export class LocalSystemKernel implements LocalSystemKernelApi {
  private readonly homeDir: string
  private readonly hostPlatform: NodeJS.Platform
  private readonly platformTools: SystemPlatformCompatibilityApi
  private readonly workingDirectory: string
  private readonly shells: SystemShellResolverApi = systemShellResolver
  private readonly commands: SystemCommandRunnerApi
  private readonly search: SystemGlobalSearchApi
  /** 跑平台命令（ps、lsof、netstat 等）读进程、端口和指标。做成字段是为了测试能换成假输出。 */
  private readonly runPlatformCommand = runPlatformCommand

  constructor(options: LocalSystemKernelOptions) {
    const root = resolve(options.cwd)
    this.homeDir = options.homeDir ?? homedir()
    this.hostPlatform = options.platform ?? platform()
    this.platformTools = new SystemPlatformCompatibility({ platform: this.hostPlatform, env: process.env })
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
      this.listProcesses({ limit: 5 }),
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
        cpu: metricLevel(cpuUsagePercent, 60, 85),
        memory: metricLevel(totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0),
        swap: metricLevel(swapUsagePercent, 35, 60),
        disk: metricLevel(diskUsagePercent, 80, 90),
        load: metricLevel((oneMinute / cpuCoreCount) * 100, 80, 120),
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

    const output = await this.runPlatformCommand(commandSpec)
    return selectSystemProcesses(parseProcessRows(output.stdout, this.hostPlatform), options)
  }

  public async listOpenPorts(options: SystemOpenPortQueryOptions = {}): Promise<SystemOpenPortInfo[]> {
    const commandSpec = this.platformTools.getOpenPortInspectionCommandSpec()
    if (!commandSpec) return []

    const output = await this.runPlatformCommand(commandSpec, { tolerateLsofEmptyResult: true })
    const entries = parseOpenPortEntries(output.stdout, this.hostPlatform)
    const pids = collectPortPids(entries)
    const owners = isEmpty(pids)
      ? []
      : await this.listProcesses({ pids, includeCwd: !!options.includeCwd, limit: pids.length })
    return selectOpenPorts(entries, new Map(owners.map((processInfo) => [processInfo.pid, processInfo])), options)
  }

  public listCommandRuns(_options: SystemCommandRunQueryOptions = {}): SystemCommandRunRecord[] {
    return []
  }

  public async listBackgroundTasks(options: SystemBackgroundTaskQueryOptions = {}): Promise<SystemBackgroundTaskRecord[]> {
    return this.commands.listTasks(options)
  }

  public terminateBackgroundTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult> {
    return this.commands.terminateTask(request)
  }

  public async refreshShellEnvironment(): Promise<SystemShellEnvironmentRefreshResult> {
    const shell = await this.resolveShell()
    return {
      shell: shell.shellPath,
      runtime: toShellDescriptor(shell),
      variableCount: Object.keys(shell.env).length,
      refreshedAt: Date.now(),
    }
  }

  public runCommand(
    command: string,
    options: SystemRunCommandOptions = {},
    _allowDangerous = false,
    abortSignal?: AbortSignal
  ): Promise<SystemCommandResult> {
    return this.commands.run(command, this.resolvePath(options.cwd ?? this.workingDirectory), options, abortSignal)
  }

  public canRefreshShellEnvironment(): boolean {
    return true
  }

  public canStartBackgroundCommands(): boolean {
    return true
  }

  public dispose(): Promise<void> {
    return this.commands.dispose()
  }

  /** 把路径变成绝对路径：`~` 展开到家目录，相对路径相对构造时给的 cwd。 */
  private resolvePath(path: string): string {
    const normalizedPath = path.startsWith('~') ? join(this.homeDir, path.slice(1)) : path
    return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(this.workingDirectory, normalizedPath)
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
      const output = await this.runPlatformCommand(commandSpec)
      return parse(output.stdout, this.hostPlatform)
    } catch (error) {
      log.debug(`failed to read local kernel ${label}`, { error })
      return null
    }
  }
}
