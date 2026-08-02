import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { cpus, freemem, homedir, loadavg, platform, release, totalmem } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { isEmpty, isPlainObject, isPresent, isString, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { readSystemTextFile } from '../atomic/Filesystem.js'
import { createSystemSearchIgnorePolicy } from '../atomic/SystemSearchIgnorePolicy.js'
import {
  shouldSkipSystemSearchEntry,
  shouldSkipSystemSearchProtectedDirectory,
} from '../atomic/SystemSearchVisibility.js'
import { shouldReapForegroundProcessGroupAfterExit } from '../SystemCommandExecutionPolicy.js'
import type {
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskStatus,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandResult,
  SystemCommandRunQueryOptions,
  SystemCommandRunRecord,
  SystemEnvironmentInspection,
  SystemFileEntry,
  SystemGlobalSearchOptions,
  SystemGlobalSearchResult,
  SystemMetricsSnapshot,
  SystemOpenApplicationOptions,
  SystemOpenApplicationResult,
  SystemOpenPathResult,
  SystemOpenPortInfo,
  SystemOpenPortQueryOptions,
  SystemProcessInfo,
  SystemProcessQueryOptions,
  SystemRevealPathResult,
  SystemRunCommandOptions,
  SystemSearchMatch,
  SystemShellEnvironmentRefreshResult,
} from '../SystemContracts.js'
import {
  type CommandSpec,
  SystemPlatformCompatibility,
} from '../SystemPlatformCompatibility.js'
import {
  type ByteStats,
  parseCpuUsagePercent,
  parseDiskStats,
  parseOpenPortEntries,
  parseProcessRows,
  parseSwapStats,
  type RawPortEntry,
} from '../SystemProcessParsers.js'
import type { SystemToolSystemApi } from '../Types.js'

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_CHARS = 50_000
const DEFAULT_SEARCH_LIMIT = 60
const DEFAULT_SEARCH_MAX_DEPTH = 6
const FORCE_KILL_DELAY_MS = 1_000
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_PLATFORM_COMMAND_BUFFER = 8 * 1024 * 1024
const log = Log.tag('LocalSystemKernel')
const execFileAsync = promisify(execFile)

export interface LocalSystemKernelOptions {
  cwd: string
  homeDir?: string
  platform?: NodeJS.Platform
}

export function createLocalSystemKernel(options: LocalSystemKernelOptions): LocalSystemKernel {
  return new LocalSystemKernel(options)
}

export class LocalSystemKernel implements SystemToolSystemApi {
  private readonly backgroundTasks = new Map<string, SystemBackgroundTaskRecord>()
  private readonly homeDir: string
  private readonly hostPlatform: NodeJS.Platform
  private readonly platformTools: SystemPlatformCompatibility
  private readonly workingDirectory: string

  constructor(options: LocalSystemKernelOptions) {
    const root = resolve(options.cwd)
    this.homeDir = options.homeDir ?? homedir()
    this.hostPlatform = options.platform ?? platform()
    this.platformTools = new SystemPlatformCompatibility({
      platform: this.hostPlatform,
      env: process.env,
    })
    this.workingDirectory = root
  }

  public async inspectEnvironment(commands: string[] = []): Promise<SystemEnvironmentInspection> {
    const pathEntries = this.platformTools.getPathEntries(process.env)
    const commandAvailability = await Promise.all(
      commands.map(async (name) => ({
        name,
        ...(await this.resolveCommandAvailability(name)),
      }))
    )

    return {
      os: {
        platform: this.hostPlatform,
        arch: process.arch,
        release: release(),
        homeDir: homedir(),
      },
      shell: {
        path: this.getShellPath(),
        variableCount: Object.keys(process.env).length,
        pathEntries,
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
      this.readCpuUsagePercent(),
      this.readDiskStats(),
      this.readSwapStats(),
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
        cpu: this.metricLevel(cpuUsagePercent, 60, 85),
        memory: this.metricLevel(totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0),
        swap: this.metricLevel(swapUsagePercent, 35, 60),
        disk: this.metricLevel(diskUsagePercent, 80, 90),
        load: this.metricLevel((oneMinute / cpuCoreCount) * 100, 80, 120),
      },
      topProcesses,
    }
  }

  public async globalSearch(
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    abortSignal?.throwIfAborted()
    const mode = options.mode ?? 'paths'
    const rootPath = this.resolvePath(options.rootPath ?? this.workingDirectory ?? this.homeDir)
    const rootStats = await lstat(rootPath).catch(() => null)
    if (!rootStats) {
      throw new AppError('NOT_FOUND', `Search root not found: ${rootPath}`)
    }

    if (mode === 'content') return this.searchContent(rootPath, options, abortSignal)
    return this.searchPaths(rootPath, options, abortSignal)
  }

  public async listProcesses(options: SystemProcessQueryOptions = {}): Promise<SystemProcessInfo[]> {
    const commandSpec = this.platformTools.getProcessListCommandSpec()
    if (!commandSpec) return []

    const output = await this.runPlatformCommand(commandSpec)
    const limit = options.limit ?? 50
    const pids = new Set(options.pids ?? [])
    const currentUser = this.getCurrentUsername()

    return parseProcessRows(output.stdout, this.hostPlatform)
      .map((row): SystemProcessInfo => ({
        ...row,
        cwd: null,
        startTime: row.startTime || null,
      }))
      .filter((processInfo) => {
        if (options.pid && processInfo.pid !== options.pid) return false
        if (pids.size > 0 && !pids.has(processInfo.pid)) return false
        if (options.name && !processInfo.name.includes(options.name)) return false
        if (options.commandContains && !processInfo.command.includes(options.commandContains)) return false
        if (options.user && processInfo.user !== options.user) return false
        if (options.onlyCurrentUser && !this.isCurrentUser(processInfo.user, currentUser)) return false
        if (options.minCpuPercent && processInfo.cpuPercent < options.minCpuPercent) return false
        if (options.minMemoryBytes && processInfo.memoryBytes < options.minMemoryBytes) return false
        return true
      })
      .slice(0, limit)
  }

  public async listOpenPorts(options: SystemOpenPortQueryOptions = {}): Promise<SystemOpenPortInfo[]> {
    const commandSpec = this.platformTools.getOpenPortInspectionCommandSpec()
    if (!commandSpec) return []

    const output = await this.runPlatformCommand(commandSpec, { tolerateLsofEmptyResult: true })
    const limit = options.limit ?? 50
    const ports = new Set(options.ports ?? [])
    const rawEntries = parseOpenPortEntries(output.stdout, this.hostPlatform)
    const processInfoByPid = await this.loadPortProcessInfo(rawEntries, !!options.includeCwd)

    return rawEntries
      .map((entry) => this.toOpenPortInfo(entry, processInfoByPid))
      .filter((entry) => {
        if (options.pid && entry.pid !== options.pid) return false
        if (options.processName && !entry.processName?.includes(options.processName)) return false
        if (options.port && entry.port !== options.port) return false
        if (ports.size > 0 && !ports.has(entry.port)) return false
        if (options.rangeStart && entry.port < options.rangeStart) return false
        if (options.rangeEnd && entry.port > options.rangeEnd) return false
        return true
      })
      .slice(0, limit)
  }

  private async readCpuUsagePercent(): Promise<Nullable<number>> {
    const commandSpec = this.platformTools.getCpuUsageCommandSpec()
    if (!commandSpec) return null

    try {
      const output = await this.runPlatformCommand(commandSpec)
      return parseCpuUsagePercent(output.stdout, this.hostPlatform)
    } catch (error) {
      log.debug('failed to read local kernel CPU usage', { error })
      return null
    }
  }

  private async readDiskStats(): Promise<Nullable<ByteStats>> {
    const commandSpec = this.platformTools.getDiskStatsCommandSpec()
    if (!commandSpec) return null

    try {
      const output = await this.runPlatformCommand(commandSpec)
      return parseDiskStats(output.stdout, this.hostPlatform)
    } catch (error) {
      log.debug('failed to read local kernel disk stats', { error })
      return null
    }
  }

  private async readSwapStats(): Promise<Nullable<ByteStats>> {
    const commandSpec = this.platformTools.getSwapStatsCommandSpec()
    if (!commandSpec) return null

    try {
      const output = await this.runPlatformCommand(commandSpec)
      return parseSwapStats(output.stdout, this.hostPlatform)
    } catch (error) {
      log.debug('failed to read local kernel swap stats', { error })
      return null
    }
  }

  private async loadPortProcessInfo(
    entries: RawPortEntry[],
    includeCwd: boolean
  ): Promise<Map<number, SystemProcessInfo>> {
    const pids = [
      ...new Set(entries.map((entry) => entry.pid).filter((pid): pid is number => isPresent(pid))),
    ]
    if (isEmpty(pids)) return new Map()

    const processes = await this.listProcesses({
      pids,
      includeCwd,
      limit: pids.length,
    })

    return new Map(processes.map((processInfo) => [processInfo.pid, processInfo]))
  }

  private toOpenPortInfo(
    entry: RawPortEntry,
    processInfoByPid: Map<number, SystemProcessInfo>
  ): SystemOpenPortInfo {
    const processInfo = entry.pid ? toNullable(processInfoByPid.get(entry.pid)) : null

    return {
      port: entry.port,
      protocol: 'tcp',
      pid: entry.pid,
      processName: processInfo?.name ?? entry.processName,
      command: toNullable(processInfo?.command ?? entry.processName),
      address: entry.address,
      state: entry.state,
      cwd: toNullable(processInfo?.cwd),
    }
  }

  public listCommandRuns(_options: SystemCommandRunQueryOptions = {}): SystemCommandRunRecord[] {
    return []
  }

  public async listBackgroundTasks(
    options: SystemBackgroundTaskQueryOptions = {}
  ): Promise<SystemBackgroundTaskRecord[]> {
    const tasks = [...this.backgroundTasks.values()].map((task) => ({
      ...task,
      status: this.resolveBackgroundTaskStatus(task),
      updatedAt: Date.now(),
    }))
    const sessionIds = new Set(options.sessionIds ?? [])

    return tasks
      .filter((task) => {
        if (options.sessionId && task.sessionId !== options.sessionId) return false
        if (sessionIds.size > 0 && (!task.sessionId || !sessionIds.has(task.sessionId))) return false
        if (options.onlyRunning && task.status !== 'running') return false
        return true
      })
      .slice(0, options.limit ?? 50)
  }

  public terminateBackgroundTask(
    request: SystemBackgroundTaskTerminateRequest
  ): SystemBackgroundTaskTerminateResult {
    const taskId = request.taskId.trim()
    if (!taskId) {
      throw new AppError('VALIDATION', '后台任务 id 不能为空。')
    }

    const task = this.backgroundTasks.get(taskId)
    if (!task) {
      throw new AppError('NOT_FOUND', `未找到后台任务：${taskId}`)
    }

    if (request.sessionId && task.sessionId !== request.sessionId) {
      throw new AppError('PERMISSION', '后台任务不属于当前会话。', undefined, {
        taskId,
        sessionId: request.sessionId,
        ownerSessionId: task.sessionId,
      })
    }

    const signal = request.force ? 'SIGKILL' : 'SIGTERM'
    const statusBefore = this.resolveBackgroundTaskStatus(task)
    let terminated = false
    let message = statusBefore === 'running' ? '后台进程已发送终止信号。' : '后台进程已经不在运行。'

    if (statusBefore === 'running') {
      try {
        this.killProcessTree(task.pid, signal)
        terminated = true
      } catch (error) {
        if (this.isProcessMissingError(error)) {
          message = '后台进程已经退出。'
        } else {
          throw new AppError('PLATFORM', '终止后台进程失败。', error, {
            taskId,
            pid: task.pid,
            signal,
          })
        }
      }
    }

    const updatedTask = {
      ...task,
      updatedAt: Date.now(),
      status: this.resolveBackgroundTaskStatus(task),
    }
    this.backgroundTasks.set(taskId, updatedTask)

    return {
      taskId,
      sessionId: task.sessionId,
      pid: task.pid,
      signal,
      statusBefore,
      statusAfter: updatedTask.status,
      terminated,
      message,
    }
  }

  public async refreshShellEnvironment(): Promise<SystemShellEnvironmentRefreshResult> {
    return {
      shell: this.getShellPath(),
      variableCount: Object.keys(process.env).length,
      refreshedAt: Date.now(),
    }
  }

  public async openPath(path: string): Promise<SystemOpenPathResult> {
    const targetPath = this.resolvePath(path)
    await this.runOpenCommand(this.platformOpenCommand(targetPath))
    return { path: targetPath, opened: true }
  }

  public async revealPath(path: string): Promise<SystemRevealPathResult> {
    const targetPath = this.resolvePath(path)
    if (this.hostPlatform === 'darwin') {
      await this.runOpenCommand({ command: 'open', args: ['-R', targetPath] })
    } else {
      await this.runOpenCommand(this.platformOpenCommand(targetPath))
    }
    return { path: targetPath, revealed: true }
  }

  public async openApplication(
    application: string,
    options: SystemOpenApplicationOptions = {}
  ): Promise<SystemOpenApplicationResult> {
    const args = options.args ?? []
    const commandSpec = this.platformTools.getOpenApplicationCommandSpec(
      application,
      args,
      options.targetPath ? this.resolvePath(options.targetPath) : undefined
    )
    await this.runOpenCommand({ command: commandSpec.file, args: commandSpec.args })

    return {
      application,
      args,
      targetPath: options.targetPath,
      opened: true,
    }
  }

  public async runCommand(
    command: string,
    options: SystemRunCommandOptions = {},
    _allowDangerous = false,
    abortSignal?: AbortSignal
  ): Promise<SystemCommandResult> {
    const cwd = this.resolvePath(options.cwd ?? this.workingDirectory ?? this.homeDir)
    const startedAt = Date.now()
    if (options.background) {
      const child = spawn(command, {
        cwd,
        shell: this.getShellPath(),
        detached: this.platformTools.shouldUseDetachedProcessGroup(),
        stdio: 'ignore',
        env: process.env,
      })
      child.unref()
      const taskId = randomUUID()
      const backgroundProcess = {
        taskId,
        sessionId: toNullable(options.sessionId),
        pid: child.pid ?? 0,
        logPath: null,
        ports: [],
        reason: null,
        terminateCommand: child.pid ? this.buildTerminateCommand(child.pid) : null,
        forceTerminateCommand: child.pid ? this.buildTerminateCommand(child.pid, true) : null,
        fallbackTerminateCommand: null,
        requested: true,
        autoStarted: false,
      }
      this.backgroundTasks.set(taskId, {
        id: taskId,
        runId: taskId,
        sessionId: toNullable(options.sessionId),
        scope: 'system',
        command,
        cwd,
        pid: child.pid ?? 0,
        logPath: null,
        ports: [],
        reason: null,
        terminateCommand: backgroundProcess.terminateCommand,
        forceTerminateCommand: backgroundProcess.forceTerminateCommand,
        fallbackTerminateCommand: null,
        requested: true,
        autoStarted: false,
        startedAt,
        updatedAt: startedAt,
        status: 'running',
        recentOutput: null,
      })

      return this.buildCommandResult(command, cwd, startedAt, {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        backgroundProcess,
      })
    }

    const result = await this.runShellCapture(command, cwd, {
      timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputChars: options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS,
      abortSignal,
    })

    return this.buildCommandResult(command, cwd, startedAt, result)
  }

  public canRefreshShellEnvironment(): boolean {
    return true
  }

  public canStartBackgroundCommands(): boolean {
    return true
  }

  private async searchPaths(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    abortSignal?.throwIfAborted()
    const query = options.query.trim()
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    const maxDepth = options.maxDepth ?? DEFAULT_SEARCH_MAX_DEPTH
    const entries: SystemFileEntry[] = []
    const extensions = this.normalizeExtensions(options.extensions)
    const entryTypes = new Set(options.entryTypes ?? ['file', 'directory'])
    let matched = 0

    await this.walkSearchRoot(
      rootPath,
      maxDepth,
      options,
      abortSignal,
      async (absolutePath, type) => {
        if (!entryTypes.has(type)) return false
        if (
          type === 'file' &&
          extensions.size > 0 &&
          !extensions.has(extname(absolutePath).toLowerCase())
        ) return false

        const relativePath = relative(rootPath, absolutePath) || '.'
        if (!this.matchesPath(relativePath, query, options.pathMatchMode ?? 'contains')) return false
        matched += 1
        if (entries.length < limit) {
          entries.push({ path: relativePath, type })
        }
        return entries.length >= limit
      }
    )

    entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
    return {
      mode: 'paths',
      rootPath,
      count: entries.length,
      truncated: matched > entries.length,
      entries,
    }
  }

  private async searchContent(
    rootPath: string,
    options: SystemGlobalSearchOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemGlobalSearchResult> {
    abortSignal?.throwIfAborted()
    const query = options.query.trim()
    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT
    const maxDepth = options.maxDepth ?? DEFAULT_SEARCH_MAX_DEPTH
    const maxResultsPerFile = options.maxResultsPerFile ?? 5
    const extensions = this.normalizeExtensions(options.extensions)
    const matches: SystemSearchMatch[] = []
    const matcher = this.createContentMatcher(query, !!options.regex, !!options.caseSensitive)

    const truncated = await this.walkSearchRoot(
      rootPath,
      maxDepth,
      options,
      abortSignal,
      async (absolutePath, type) => {
        if (type !== 'file') return false
        if (extensions.size > 0 && !extensions.has(extname(absolutePath).toLowerCase())) return false
        const stats = await lstat(absolutePath).catch(() => null)
        if (!stats || stats.size > MAX_SEARCH_FILE_BYTES) return false

        abortSignal?.throwIfAborted()
        const textFile = await readSystemTextFile(absolutePath).catch(() => null)
        if (!textFile) return false
        const content = textFile.content

        let perFileMatches = 0
        const lines = content.split(/\r?\n/)
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          abortSignal?.throwIfAborted()
          const line = lines[lineIndex] ?? ''
          for (const column of matcher(line)) {
            matches.push({
              path: relative(rootPath, absolutePath) || basename(absolutePath),
              line: lineIndex + 1,
              column,
              excerpt: line.trim(),
            })
            perFileMatches += 1
            if (matches.length >= limit || perFileMatches >= maxResultsPerFile) break
          }
          if (matches.length >= limit || perFileMatches >= maxResultsPerFile) break
        }

        return matches.length >= limit
      }
    )

    return {
      mode: 'content',
      rootPath,
      count: matches.length,
      truncated: truncated || matches.length >= limit,
      matches,
    }
  }

  private async walkSearchRoot(
    rootPath: string,
    maxDepth: number,
    options: Pick<SystemGlobalSearchOptions, 'includeHidden' | 'unrestricted'>,
    abortSignal: LooseOptional<AbortSignal>,
    onEntry: (absolutePath: string, type: SystemFileEntry['type']) => Promise<boolean>
  ): Promise<boolean> {
    abortSignal?.throwIfAborted()
    const ignorePolicy = await createSystemSearchIgnorePolicy(rootPath, {
      unrestricted: options.unrestricted,
    })
    const visit = async (currentPath: string, depth: number): Promise<boolean> => {
      abortSignal?.throwIfAborted()
      if (depth > maxDepth) return false
      const stats = await lstat(currentPath).catch(() => null)
      if (!stats || stats.isSymbolicLink()) return false

      const type = stats.isDirectory() ? 'directory' : 'file'
      if (currentPath !== rootPath) {
        if (this.shouldSkipSearchEntry(basename(currentPath), type === 'directory', options)) return false
        if (await ignorePolicy.shouldSkip(currentPath, type === 'directory')) return false
        if (type === 'directory' && this.shouldSkipProtectedDirectory(currentPath, rootPath)) return false
        if (await onEntry(currentPath, type)) return true
      }
      if (type !== 'directory') return false

      const names = await readdir(currentPath).catch(() => [])
      names.sort((left, right) => left.localeCompare(right, 'en'))
      for (const name of names) {
        abortSignal?.throwIfAborted()
        if (await visit(join(currentPath, name), depth + 1)) return true
      }
      return false
    }

    return visit(rootPath, 0)
  }

  private buildCommandResult(
    command: string,
    cwd: string,
    startedAt: number,
    result: {
      exitCode: Nullable<number>
      signal: Nullable<string>
      stdout: string
      stderr: string
      timedOut: boolean
      aborted: boolean
      backgroundProcess?: SystemCommandResult['backgroundProcess']
    }
  ): SystemCommandResult {
    const success = result.exitCode === 0 && !result.timedOut && !result.aborted
    return {
      command,
      cwd,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: result.timedOut,
      aborted: result.aborted,
      truncated: false,
      success,
      backgroundProcess: result.backgroundProcess,
      verification: {
        kind: 'unknown',
        status: result.aborted
          ? 'aborted'
          : result.timedOut
            ? 'timed-out'
            : success
              ? 'passed'
              : 'failed',
        issues: success || !result.stderr.trim() ? [] : [result.stderr.trim().slice(0, 1000)],
      },
      systemToolSuggestion: null,
    }
  }

  /**
   * 跑一条 shell 命令并抓取输出。
   *
   * 导览（§5.3b ③并发时序 / ②生命周期）——这里同时有四个可能"先到"的事件：
   * 子进程 close、超时、外部 abort、spawn error。约束如下，改动前逐条确认还成立：
   * - **`settled` 是唯一的终态闸**：四条路径都必须先看它。少一处检查就会出现
   *   "已 resolve 又 reject"（Node 会静默忽略，症状是超时后拿到一个空结果却没有 timedOut 标记）。
   * - **`terminating` 单独一个闸**：超时与 abort 可能相继触发，两次进入升级流程会排两个
   *   SIGKILL 定时器。
   * - **升级顺序固定 SIGTERM → 等 `FORCE_KILL_DELAY_MS` → SIGKILL**，且 SIGKILL 定时器
   *   `unref`：进程已经退出时它不能吊住 Node 事件循环。
   * - **abort 监听必须在每条终态路径上摘掉**，否则一个长会话的 AbortSignal 会累积监听器。
   *
   * 输出**在累积时就按 `maxOutputChars` 截断**（`appendOutput`），不是最后再切——长跑命令的
   * stdout 可以是无上限的，先攒后切等于把内存交给被调用方决定。
   */
  private runShellCapture(
    command: string,
    cwd: string,
    options: {
      timeoutMs?: number
      maxOutputChars?: number
      abortSignal?: AbortSignal
    } = {}
  ): Promise<{
    exitCode: Nullable<number>
    signal: Nullable<string>
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
  }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, {
        cwd,
        shell: this.getShellPath(),
        detached: this.platformTools.shouldUseDetachedProcessGroup(),
        env: process.env,
      })
      const maxOutputChars = options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      let settled = false
      const timers = new TimerScope({ name: 'LocalSystemKernel.runShellCapture' })
      let timeout: Nullable<TimerLease> = null
      let terminating = false

      const finish = (result: {
        exitCode: Nullable<number>
        signal: Nullable<string>
        stdout: string
        stderr: string
      }) => {
        if (settled) return
        settled = true
        timeout?.cancel()
        timers.cancelAll()
        options.abortSignal?.removeEventListener('abort', abort)
        resolvePromise({ ...result, timedOut, aborted })
      }

      const abort = () => {
        if (settled) return
        aborted = true
        terminateWithEscalation('SIGTERM')
      }
      const terminateWithEscalation = (signal: NodeJS.Signals) => {
        if (terminating) return
        terminating = true
        this.tryKillProcessTree(child.pid, signal)
        timers.after(
          FORCE_KILL_DELAY_MS,
          () => {
            if (!settled) this.tryKillProcessTree(child.pid, 'SIGKILL')
          },
          { label: 'LocalSystemKernel.runShellCapture.force-kill', unref: true }
        )
      }
      timeout = options.timeoutMs
        ? timers.after(options.timeoutMs, () => {
            if (settled) return
            timedOut = true
            terminateWithEscalation('SIGTERM')
          })
        : null

      if (options.abortSignal?.aborted) {
        abort()
      } else {
        options.abortSignal?.addEventListener('abort', abort, { once: true })
      }
      child.stdout?.on('data', (chunk) => {
        stdout = this.appendOutput(stdout, String(chunk), maxOutputChars)
      })
      child.stderr?.on('data', (chunk) => {
        stderr = this.appendOutput(stderr, String(chunk), maxOutputChars)
      })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        timeout?.cancel()
        timers.cancelAll()
        options.abortSignal?.removeEventListener('abort', abort)
        rejectPromise(error)
      })
      child.on('close', (exitCode, signal) => {
        this.reapForegroundProcessGroupAfterExit(child.pid, command)
        finish({ exitCode, signal, stdout, stderr })
      })
    })
  }

  private async runPlatformCommand(
    commandSpec: CommandSpec,
    options: { tolerateLsofEmptyResult?: boolean } = {}
  ): Promise<{ stdout: string }> {
    try {
      return await execFileAsync(commandSpec.file, commandSpec.args, {
        env: process.env,
        maxBuffer: MAX_PLATFORM_COMMAND_BUFFER,
      })
    } catch (error) {
      // lsof 在"没有任何匹配"时以 exit 1 且空 stderr 结束——这不是失败，是空结果集。
      // 判据必须三条齐（调用方要求容忍 + 确实是 lsof + stderr 为空），否则真的执行失败会被吞掉。
      const failure = isPlainObject(error) ? error : null
      if (
        options.tolerateLsofEmptyResult &&
        commandSpec.file === 'lsof' &&
        String(failure?.code) === '1' &&
        !(isString(failure?.stderr) ? failure.stderr.trim() : '')
      ) return { stdout: isString(failure?.stdout) ? failure.stdout : '' }

      throw new AppError('PLATFORM', `平台命令执行失败：${commandSpec.file}`, error)
    }
  }

  private async runOpenCommand(input: { command: string; args: string[] }): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(input.command, input.args, {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', rejectPromise)
      child.on('spawn', () => {
        child.unref()
        resolvePromise()
      })
    })
  }

  private buildTerminateCommand(pid: number, force = false): Nullable<string> {
    return this.platformTools.getTerminateCommand(pid, force)
  }

  /**
   * 终止整棵进程树。
   *
   * 判据（§5.3b ⑥非显然妥协）——**杀单个 pid 不够**：命令是通过 shell 起的，真正干活的是它的子进程；
   * 只杀 shell 会留下孤儿（真机症状：终止后端口仍被占）。所以优先用平台的树终止命令
   * （Windows `taskkill /T`），POSIX 上退回"给进程组发信号"（`getProcessKillPid` 返回负 pid）。
   *
   * **失败回退的判据**：进程组信号失败且 `killPid !== pid` 时才退回杀单进程——说明进程组不存在
   * （detached 没生效），此时杀单进程仍比什么都不做好；若两者本就是同一个 pid，
   * 说明这就是单进程失败，必须把错误抛出去，不能重试同一件事然后假装成功。
   */
  private killProcessTree(pid: number, signal: NodeJS.Signals): void {
    if (!pid) return

    const treeKillSpec = this.platformTools.getProcessTreeKillCommandSpec(pid, signal)
    if (treeKillSpec) {
      execFileSync(treeKillSpec.file, treeKillSpec.args, { stdio: 'ignore' })
      return
    }

    const killPid = this.platformTools.getProcessKillPid(pid)
    try {
      process.kill(killPid, signal)
      return
    } catch (groupError) {
      if (killPid === pid) throw groupError
    }

    process.kill(pid, signal)
  }

  private tryKillProcessTree(pid: LooseOptional<number>, signal: NodeJS.Signals): void {
    if (!pid) return

    try {
      this.killProcessTree(pid, signal)
    } catch (error) {
      log.warn('failed to terminate command process tree', {
        pid,
        signal,
        error,
      })
    }
  }

  private tryReapProcessTree(pid: LooseOptional<number>, signal: NodeJS.Signals): void {
    if (!pid) return

    try {
      this.killProcessTree(pid, signal)
    } catch (error) {
      if (this.isProcessMissingError(error)) return

      log.warn('failed to reap command process tree', {
        pid,
        signal,
        error,
      })
    }
  }

  private reapForegroundProcessGroupAfterExit(pid: LooseOptional<number>, command: string): void {
    if (!pid) return
    if (!this.platformTools.shouldUseDetachedProcessGroup()) return
    if (!shouldReapForegroundProcessGroupAfterExit(command)) return

    this.tryReapProcessTree(pid, 'SIGTERM')
    const timers = new TimerScope({ name: 'LocalSystemKernel.reapForegroundProcessGroupAfterExit' })
    timers.after(FORCE_KILL_DELAY_MS, () => {
      this.tryReapProcessTree(pid, 'SIGKILL')
      timers.dispose()
    }, {
      label: 'force-kill',
      unref: true,
    })
  }

  private platformOpenCommand(targetPath: string): { command: string; args: string[] } {
    const commandSpec = this.platformTools.getOpenExternalFallbackSpec(targetPath, process.env)
    return { command: commandSpec.file, args: commandSpec.args }
  }

  private async resolveCommandAvailability(
    name: string
  ): Promise<{ available: boolean; path: Nullable<string> }> {
    const probeCommand = this.hostPlatform === 'win32'
      ? `where ${this.platformTools.quoteShellArg(name)}`
      : `command -v ${this.platformTools.quoteShellArg(name)}`
    // 探测命令失败即"命令不存在"，由下面的 exitCode 判定表达，不需要额外的容忍开关。
    const result = await this.runShellCapture(probeCommand, homedir())
    const commandPath = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null
    return {
      available: Boolean(commandPath),
      path: commandPath || null,
    }
  }

  private createContentMatcher(
    query: string,
    regex: boolean,
    caseSensitive: boolean
  ): (line: string) => Iterable<number> {
    if (regex) {
      let expression: RegExp
      try {
        expression = new RegExp(query, caseSensitive ? 'g' : 'gi')
      } catch (error) {
        const message = AppError.getMessage(error)
        throw new AppError('VALIDATION', `Invalid regex pattern: ${message}`)
      }
      return function* matchRegex(line: string) {
        expression.lastIndex = 0
        let match = expression.exec(line)
        while (match) {
          yield match.index + 1
          if (isEmpty(match[0])) expression.lastIndex += 1
          match = expression.exec(line)
        }
      }
    }

    const needle = caseSensitive ? query : query.toLowerCase()
    return function* matchLiteral(line: string) {
      const haystack = caseSensitive ? line : line.toLowerCase()
      let index = 0
      while (true) {
        const found = haystack.indexOf(needle, index)
        if (found === -1) return
        yield found + 1
        index = found + Math.max(needle.length, 1)
      }
    }
  }

  private matchesPath(path: string, query: string, mode: SystemGlobalSearchOptions['pathMatchMode']): boolean {
    if (mode === 'exact') return path === query
    if (mode === 'fuzzy') {
      let index = 0
      const lowerPath = path.toLowerCase()
      for (const char of query.toLowerCase()) {
        index = lowerPath.indexOf(char, index)
        if (index === -1) return false
        index += 1
      }
      return true
    }
    return path.toLowerCase().includes(query.toLowerCase())
  }

  private shouldSkipSearchEntry(
    name: string,
    isDirectory: boolean,
    options: Pick<SystemGlobalSearchOptions, 'includeHidden' | 'unrestricted'>
  ): boolean {
    return shouldSkipSystemSearchEntry(name, isDirectory, !!options.includeHidden, !!options.unrestricted)
  }

  private shouldSkipProtectedDirectory(candidatePath: string, rootPath: string): boolean {
    return shouldSkipSystemSearchProtectedDirectory({
      platform: this.hostPlatform,
      homeDir: this.homeDir,
      rootPath,
      candidatePath,
    })
  }

  private normalizeExtensions(extensions: LooseOptional<string[]>): Set<string> {
    return new Set(
      (extensions ?? []).map((extension) =>
        extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      )
    )
  }

  private getCurrentUsername(): Nullable<string> {
    return toNullable(process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME)
  }

  private isCurrentUser(processUser: string, currentUser: Nullable<string>): boolean {
    if (!currentUser) return false

    return processUser === currentUser || processUser.endsWith(`\\${currentUser}`)
  }

  private resolvePath(path: string): string {
    const normalizedPath = path.startsWith('~') ? join(this.homeDir, path.slice(1)) : path
    return isAbsolute(normalizedPath)
      ? resolve(normalizedPath)
      : resolve(this.workingDirectory ?? this.homeDir, normalizedPath)
  }

  private appendOutput(previous: string, next: string, maxChars: number): string {
    const combined = previous + next
    return combined.length <= maxChars ? combined : combined.slice(0, maxChars)
  }

  private getShellPath(): string {
    return this.platformTools.getPreferredShellPath(process.env)
  }

  private metricLevel(
    value: Nullable<number>,
    warnThreshold = 75,
    highThreshold = 90
  ): 'unknown' | 'normal' | 'warn' | 'high' {
    if (!isPresent(value) || !Number.isFinite(value)) return 'unknown'

    if (value >= highThreshold) return 'high'
    if (value >= warnThreshold) return 'warn'
    return 'normal'
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (this.isProcessMissingError(error)) return false
      if (this.isProcessPermissionError(error)) return true
      log.debug('检查进程状态失败，按已退出处理', {
        pid,
        error: AppError.getMessage(error),
      })
      return false
    }
  }

  private resolveBackgroundTaskStatus(task: SystemBackgroundTaskRecord): SystemBackgroundTaskStatus {
    return this.isProcessAlive(task.pid) ? 'running' : 'exited'
  }

  /** ESRCH = "进程不存在"。数值 errno 3 是同一个含义的另一种呈现（部分平台只给 errno 不给 code）。 */
  private isProcessMissingError(error: unknown): boolean {
    if (!isPlainObject(error)) return false
    return error.code === 'ESRCH' || error.errno === 3
  }

  private isProcessPermissionError(error: unknown): boolean {
    return isPlainObject(error) && error.code === 'EPERM'
  }

}
