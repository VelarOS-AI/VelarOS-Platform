import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { cpus, freemem, homedir, loadavg, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { isEmpty, isNull, isPlainObject, isPresent, isString, Log, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { readSystemTextFile } from '../atomic/Filesystem.js'
import { createSystemSearchIgnorePolicy } from '../atomic/SystemSearchIgnorePolicy.js'
import {
  shouldSkipSystemSearchEntry,
  shouldSkipSystemSearchProtectedDirectory,
} from '../atomic/SystemSearchVisibility.js'
import type {
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskStatus,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandOutputCapture,
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
  SystemProcessConfinementEvidence,
  SystemProcessConfinementMode,
  SystemProcessInfo,
  SystemProcessQueryOptions,
  SystemRevealPathResult,
  SystemRunCommandOptions,
  SystemSearchMatch,
  SystemShellDescriptor,
  SystemShellEnvironmentRefreshResult,
} from '../SystemContracts.js'
import { createSystemOutputDecoder } from '../SystemOutputDecoder.js'
import {
  type CommandSpec,
  SystemPlatformCompatibility,
} from '../SystemPlatformCompatibility.js'
import {
  buildSystemProcessConfinementSpawnSpec,
  type SystemProcessConfinementProvider,
} from '../SystemProcessConfinement.js'
import { buildSystemOwnedProcessSpec, type SystemProcessOwnership } from '../SystemProcessHost.js'
import { type ManagedSystemProcess,manageSystemProcess, waitForSystemProcessSpawn } from '../SystemProcessLifecycle.js'
import {
  type ByteStats,
  parseCpuUsagePercent,
  parseDiskStats,
  parseOpenPortEntries,
  parseProcessRows,
  parseSwapStats,
  type RawPortEntry,
} from '../SystemProcessParsers.js'
import { buildSystemNativeCommandSpec, describeSystemNativeCommand, resolveSystemCommand, resolveSystemShellReady } from '../SystemShell.js'
import type { SystemToolSystemApi } from '../Types.js'

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_CHARS = 50_000
const DEFAULT_SEARCH_LIMIT = 60
const DEFAULT_SEARCH_MAX_DEPTH = 6
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_PLATFORM_COMMAND_BUFFER = 8 * 1024 * 1024
const log = Log.tag('LocalSystemKernel')
const execFileAsync = promisify(execFile)

export interface LocalSystemKernelOptions {
  cwd: string
  homeDir?: string
  platform?: NodeJS.Platform
  /**
   * 同机命令的进程约束策略。缺省保持兼容的 `danger-full-access`，但仍在结果中明确报告
   * `enforcement:none`；受约束模式没有可用后端时会失败关闭。
   */
  processConfinement?: {
    mode: SystemProcessConfinementMode
    workspaceRoot?: string
    writeRoots?: readonly string[]
    network?: boolean
    provider?: SystemProcessConfinementProvider
  }
}

export function createLocalSystemKernel(options: LocalSystemKernelOptions): LocalSystemKernel {
  return new LocalSystemKernel(options)
}

export class LocalSystemKernel implements SystemToolSystemApi {
  private readonly backgroundTasks = new Map<string, SystemBackgroundTaskRecord>()
  private readonly backgroundExecutions = new Map<string, ManagedSystemProcess>()
  private readonly homeDir: string
  private readonly hostPlatform: NodeJS.Platform
  private readonly platformTools: SystemPlatformCompatibility
  private readonly processConfinement: NonNullable<LocalSystemKernelOptions['processConfinement']>
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
    this.processConfinement = options.processConfinement ?? {
      mode: 'danger-full-access',
      workspaceRoot: root,
    }
  }

  public async inspectEnvironment(commands: string[] = []): Promise<SystemEnvironmentInspection> {
    const shell = await this.resolveShell()
    const pathEntries = this.platformTools.getPathEntries(shell.env)
    const commandAvailability = await Promise.all(
      commands.map((name) => resolveSystemCommand(name, shell))
    )

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
    const filter = options.filter?.trim().toLowerCase()
    const pids = new Set(options.pids ?? [])
    const currentUser = this.getCurrentUsername()

    return parseProcessRows(output.stdout, this.hostPlatform)
      .map((row): SystemProcessInfo => ({
        ...row,
        cwd: null,
        startTime: row.startTime || null,
      }))
      .filter((processInfo) => {
        if (filter && !`${processInfo.name}\0${processInfo.command}`.toLowerCase().includes(filter)) return false
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
    const filter = options.filter?.trim().toLowerCase()
    const ports = new Set(options.ports ?? [])
    const rawEntries = parseOpenPortEntries(output.stdout, this.hostPlatform)
    const processInfoByPid = await this.loadPortProcessInfo(rawEntries, !!options.includeCwd)

    return rawEntries
      .map((entry) => this.toOpenPortInfo(entry, processInfoByPid))
      .filter((entry) => {
        if (filter && !`${entry.processName ?? ''}\0${entry.command ?? ''}`.toLowerCase().includes(filter)) return false
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
    const filter = options.filter?.trim().toLowerCase()

    return tasks
      .filter((task) => {
        if (filter && !task.command.toLowerCase().includes(filter)) return false
        if (options.taskId && task.id !== options.taskId) return false
        if (options.sessionId && task.sessionId !== options.sessionId) return false
        if (sessionIds.size > 0 && (!task.sessionId || !sessionIds.has(task.sessionId))) return false
        if (options.onlyRunning && task.status !== 'running') return false
        return true
      })
      .slice(0, options.limit ?? 50)
  }

  public async terminateBackgroundTask(
    request: SystemBackgroundTaskTerminateRequest
  ): Promise<SystemBackgroundTaskTerminateResult> {
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
        const owned = this.backgroundExecutions.get(taskId)
        if (!owned || owned.child.pid !== task.pid) throw new AppError('PERMISSION', '无法确认后台进程的受管身份。')
        terminated = await owned.stop(signal)
        if (!terminated && !owned.exited) throw new AppError('PLATFORM', '后台进程未在期限内确认退出。')
      } catch (error) {
        if (this.platformTools.isProcessMissingError(error)) {
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
    const shell = await this.resolveShell()
    return {
      shell: shell.shellPath,
      runtime: this.describeShell(shell),
      variableCount: Object.keys(shell.env).length,
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
    commandInput: string,
    options: SystemRunCommandOptions = {},
    _allowDangerous = false,
    abortSignal?: AbortSignal
  ): Promise<SystemCommandResult> {
    abortSignal?.throwIfAborted()
    const command = options.nativeCommand ? describeSystemNativeCommand(options.nativeCommand) : commandInput
    const cwd = this.resolvePath(options.cwd ?? this.workingDirectory ?? this.homeDir)
    const startedAt = Date.now()
    const confined = await this.buildCommandSpawnSpec(command, options.nativeCommand)
    abortSignal?.throwIfAborted()
    if (options.background) {
      const taskId = randomUUID()
      const child = spawn(confined.spec.file, confined.spec.args, {
        cwd, detached: this.platformTools.shouldUseDetachedProcessGroup(),
        stdio: ['ignore', 'pipe', 'pipe'], env: confined.env, windowsHide: true,
        windowsVerbatimArguments: confined.spec.windowsVerbatimArguments,
      })
      const owned = manageSystemProcess(child, { platform: this.hostPlatform, abortSignal })
      let recentOutput = ''
      const decoders = { stdout: createSystemOutputDecoder(), stderr: createSystemOutputDecoder() }
      const append = (text: string): void => {
        recentOutput = this.appendOutput(recentOutput, text, 4_000)
        const task = this.backgroundTasks.get(taskId)
        if (task) this.backgroundTasks.set(taskId, { ...task, recentOutput, updatedAt: Date.now() })
      }
      for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => append(decoders[stream].write(chunk)))
      try { await waitForSystemProcessSpawn(child); abortSignal?.throwIfAborted() } catch (error) {
        await owned.stop('SIGKILL')
        throw error
      }
      const pid = child.pid!
      const backgroundProcess = {
        taskId, sessionId: toNullable(options.sessionId), pid, logPath: null, ports: [],
        reason: null, terminateCommand: this.platformTools.getTerminateCommand(pid, false, confined.shell),
        forceTerminateCommand: this.platformTools.getTerminateCommand(pid, true, confined.shell), fallbackTerminateCommand: null,
        requested: true, autoStarted: false,
      }
      const task: SystemBackgroundTaskRecord = {
        id: taskId, runId: taskId, sessionId: toNullable(options.sessionId), scope: 'system', command,
        cwd, pid, logPath: null, ports: [], reason: null,
        terminateCommand: backgroundProcess.terminateCommand,
        forceTerminateCommand: backgroundProcess.forceTerminateCommand, fallbackTerminateCommand: null,
        requested: true, autoStarted: false, startedAt, updatedAt: startedAt,
        status: 'running', recentOutput: null,
      }
      this.backgroundTasks.set(taskId, task)
      this.backgroundExecutions.set(taskId, owned)
      void owned.completion.then((result) => {
        for (const stream of ['stdout', 'stderr'] as const) append(decoders[stream].end())
        this.backgroundTasks.set(taskId, { ...task, status: result.cleanupIncomplete ? 'unknown' : 'exited',
          recentOutput, exitCode: result.exitCode, signal: result.signal,
          cleanupIncomplete: result.cleanupIncomplete, finishedAt: Date.now(), updatedAt: Date.now() })
      }).catch((error) => log.warn('后台进程完成记录失败', { taskId, error }))
      return this.buildCommandResult(command, cwd, startedAt, {
        exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
        backgroundProcess, confinement: confined.evidence, ownership: confined.ownership, shell: confined.shell,
      })
    }
    const result = await this.runShellCapture(command, confined.spec, confined.evidence, cwd, {
      env: confined.env, timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputChars: options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS, abortSignal,
    })
    return this.buildCommandResult(command, cwd, startedAt, { ...result, ownership: confined.ownership, shell: confined.shell })
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
      cleanupIncomplete?: boolean
      truncated?: boolean
      capture?: SystemCommandOutputCapture
      shell?: SystemShellDescriptor
      ownership?: SystemProcessOwnership
      confinement: SystemProcessConfinementEvidence
    }
  ): SystemCommandResult {
    const success = (result.exitCode === 0 || (!!result.backgroundProcess && isNull(result.exitCode)))
      && !result.timedOut && !result.aborted && !result.cleanupIncomplete
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
      cleanupIncomplete: result.cleanupIncomplete,
      ownership: result.ownership,
      truncated: !!result.truncated,
      capture: result.capture,
      shell: result.shell,
      success,
      confinement: result.confinement,
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

  /** Capture bounded output while the shared lifecycle owns cancellation and pipe-drain deadlines. */
  private runShellCapture(
    command: string,
    spawnSpec: CommandSpec,
    confinement: SystemProcessConfinementEvidence,
    cwd: string,
    options: {
      env: NodeJS.ProcessEnv
      timeoutMs?: number
      maxOutputChars?: number
      abortSignal?: AbortSignal
    }
  ): Promise<{
    exitCode: Nullable<number>
    signal: Nullable<string>
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
    cleanupIncomplete: boolean
    truncated: boolean
    capture: SystemCommandOutputCapture
    confinement: SystemProcessConfinementEvidence
  }> {
    options.abortSignal?.throwIfAborted()
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd, detached: this.platformTools.shouldUseDetachedProcessGroup(), env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
    })
    const owned = manageSystemProcess(child, { platform: this.hostPlatform,
      timeoutMs: options.timeoutMs, abortSignal: options.abortSignal })
    const maxChars = options.maxOutputChars ?? DEFAULT_OUTPUT_CHARS
    const decoders = { stdout: createSystemOutputDecoder(), stderr: createSystemOutputDecoder() }
    const output = { stdout: '', stderr: '' }
    let truncated = false
    let totalBytes = 0
    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      totalBytes += Buffer.byteLength(text)
      if (output[stream].length + text.length > maxChars) truncated = true
      output[stream] = this.appendOutput(output[stream], text, maxChars)
    }
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => append(stream, decoders[stream].write(chunk)))
    return owned.completion.then((result) => {
      for (const stream of ['stdout', 'stderr'] as const) append(stream, decoders[stream].end())
      if (result.spawnError) throw result.spawnError
      const storedBytes = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)
      const capture: SystemCommandOutputCapture = {
        status: result.cleanupIncomplete ? 'failed' : truncated ? 'truncated' : 'complete',
        encoding: 'utf-8', totalBytes, storedBytes, omittedBytes: Math.max(0, totalBytes - storedBytes),
        decodeErrors: decoders.stdout.decodeErrors + decoders.stderr.decodeErrors,
        ...(result.cleanupIncomplete ? { error: 'Process output drain did not complete before its deadline' } : {}),
      }
      return { ...result, ...output, confinement, truncated, capture }
    })
  }

  private async buildCommandSpawnSpec(command: string, nativeCommand?: { file: string; args: string[]; env?: Record<string, string> }) {
    const shell = await this.resolveShell()
    const commandSpec = nativeCommand ? buildSystemNativeCommandSpec(nativeCommand, shell)
      : { ...this.platformTools.getShellCommandSpec(command, shell), env: shell.env }
    const confined = buildSystemProcessConfinementSpawnSpec({ spec: commandSpec,
      policy: { mode: this.processConfinement.mode,
        workspaceRoot: this.processConfinement.workspaceRoot ?? this.workingDirectory,
        writeRoots: this.processConfinement.writeRoots, network: this.processConfinement.network } },
      { platform: this.hostPlatform, env: commandSpec.env, provider: this.processConfinement.provider, tempDir: tmpdir() })
    const owned = buildSystemOwnedProcessSpec(confined.spec, { platform: this.hostPlatform, env: commandSpec.env })
    return { ...confined, ...owned, env: commandSpec.env, shell: this.describeShell(shell) }
  }

  private describeShell(shell: SystemShellDescriptor): SystemShellDescriptor {
    return { kind: shell.kind, name: shell.name, shellPath: shell.shellPath, args: shell.args,
      readiness: shell.readiness, version: shell.version, recommendation: shell.recommendation }
  }

  private async runPlatformCommand(
    commandSpec: CommandSpec,
    options: { tolerateLsofEmptyResult?: boolean } = {}
  ): Promise<{ stdout: string }> {
    try {
      return await execFileAsync(commandSpec.file, commandSpec.args, {
        env: process.env,
        maxBuffer: MAX_PLATFORM_COMMAND_BUFFER,
        timeout: 2_000, killSignal: 'SIGKILL', windowsHide: true,
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

  /** Release every background child owned by this kernel instance. */
  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.backgroundExecutions.values()].filter((entry) => !entry.exited).map((entry) => entry.stop('SIGKILL')))
  }

  private platformOpenCommand(targetPath: string): { command: string; args: string[] } {
    const commandSpec = this.platformTools.getOpenExternalFallbackSpec(targetPath)
    return { command: commandSpec.file, args: commandSpec.args }
  }

  private async resolveCommandAvailability(
    name: string
  ): Promise<{ available: boolean; path: Nullable<string> }> {
    const shell = await this.resolveShell()
    const command = await resolveSystemCommand(name, shell)
    return { available: command.available, path: command.path }
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
    if (combined.length <= maxChars) return combined
    let start = combined.length - maxChars
    if (combined.charCodeAt(start) >= 0xdc00 && combined.charCodeAt(start) <= 0xdfff &&
      combined.charCodeAt(start - 1) >= 0xd800 && combined.charCodeAt(start - 1) <= 0xdbff) start++
    return combined.slice(start)
  }

  private resolveShell() {
    return resolveSystemShellReady({ platform: this.hostPlatform, env: process.env })
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

  private resolveBackgroundTaskStatus(task: SystemBackgroundTaskRecord): SystemBackgroundTaskStatus {
    const owned = this.backgroundExecutions.get(task.id)
    if (!owned) return task.finishedAt ? 'exited' : 'unknown'
    return owned.result?.cleanupIncomplete ? 'unknown' : owned.exited ? 'exited' : 'running'
  }


}
