/**
 * 命令执行器：`SystemCommandRunner`。接口 `SystemCommandRunnerApi` 与它的构造参数 `SystemCommandRunnerOptions` 就在本文件的类上方。
 * 本地内核创建并持有它；一条命令从选 shell、加约束、起受管子进程，到前台采集或后台登记，都在这里。
 * 交互式任务的控制台也归它：stdin 留一根打开的管道，输出另存一份带位置的缓冲，用户的输入、中断经这里递给进程。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { isFalse, Log, optionalWhen, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/platform'
import type { ShellBackgroundProcessInfo, ShellBackgroundTaskQueryOptions, ShellBackgroundTaskRecord, ShellBackgroundTaskStatus, ShellCommandOutputCapture, ShellCommandResult, ShellConsoleSessionInfo, ShellProcessConfinementEvidence, ShellRunCommandOptions } from '@velaros-ai/shell-command/contracts'

import type { SystemProcessConfinementProvider } from '../contract/requires.js'
import type { PreparedSystemCommand, SystemConsoleOutputBuffer, SystemProcessConfinementPolicy } from '../types/commands.js'
import type { SystemBackgroundTaskTerminateResult, SystemConsoleControlResult, SystemConsoleOutputChunk } from '../types/host.js'
import type { SystemBackgroundTaskTerminateRequest, SystemConsoleInputRequest, SystemConsoleInterruptRequest, SystemConsoleOutputRequest } from '../types/system.js'
import { buildSystemCommandResult } from '../utils/command-result.js'
import { buildSystemProcessConfinementSpawnSpec } from '../utils/confinement.js'
import { buildSystemOwnedProcessSpec, terminateSystemProcessTree, waitForSystemProcessSpawn, writeToChildInput } from '../utils/process.js'
import { buildSystemNativeCommandSpec, describeSystemNativeCommand, describeUnavailableShellKind, detectSystemShells, toShellDescriptor } from '../utils/shell.js'
import { selectBackgroundTasks } from '../utils/system-info.js'
import { appendBoundedOutput, readBoundedOutputSince } from '../utils/text.js'
import { SystemTuning } from '../utils/tuning.js'

import type { ManagedSystemProcess } from './SystemManagedProcess.js'
import { SystemOutputDecoder } from './SystemOutputDecoder.js'
import type { SystemProcessManagerApi } from './SystemProcessManager.js'
import type { SystemShellResolverApi } from './SystemShellResolver.js'

const log = Log.tag('SystemCommandRunner')

/**
 * 命令执行器：把一条命令变成受管子进程跑起来。前台等它结束并采集输出；后台登记成后台任务，之后可查、可停。
 *
 * 实现是 `SystemCommandRunner`，由本地内核创建并持有。它启动过的后台进程归它管，内核释放时一并停掉。
 */
export interface SystemCommandRunnerApi {
  /**
   * 跑一条命令，返回完整结果。
   *
   * 链路：选 shell（`options.shell` 挑定哪一种，本机没有它就以 VALIDATION 拒绝、一个进程都不起；给了 nativeCommand 就按原生 argv 执行）
   * → 加进程约束 → Windows 上包进原生进程宿主 → 启动受管子进程。
   * 前台：有界采集 stdout 与 stderr，超时或取消后在期限内收敛，失败时把输出末尾摘进 verification。
   * 后台（options.background）：进程拉起后登记成后台任务就返回，结果里带任务 id 和终止命令。
   * 交互式（options.interactive，必须和 background 一起）：stdin 留一根保持打开的管道，输出另外存进控制台缓冲区，
   * 结果的 `backgroundProcess.console` 给出这个控制台；本机没有 PTY，channel 一律是 `pipe`，真正的 PTY 由宿主自己的端口实现提供。
   * 命令自己失败（非零退出、超时、取消）不抛错，如实写进结果；找不到能用的 shell、约束后端缺失、进程拉不起来才抛错。
   * @param command 命令文本；给了 options.nativeCommand 时只用来展示
   * @param cwd 已经解析好的绝对工作目录
   */
  run(command: string, cwd: string, options: ShellRunCommandOptions, abortSignal?: AbortSignal): Promise<ShellCommandResult>
  /** 列出后台任务：可按任务 id、会话、命令过滤词、只看运行中来筛，最多 limit 条（默认 50）；状态按受管进程此刻的情况给出。 */
  listTasks(options?: ShellBackgroundTaskQueryOptions): ShellBackgroundTaskRecord[]
  /**
   * 终止一个后台任务，返回终止前后的状态。
   *
   * 先核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号（force 时直接 SIGKILL）并等它在期限内退出。
   * 进程已经不在了不算失败，结果里如实说明；核对不过或期限内没退出时抛错。
   */
  terminateTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult>
  /**
   * 往交互式任务的控制台写一段输入，缺省补一个换行。
   * 先核对任务存在、属于请求里的会话；进程已经退出、这条任务不是交互式的、stdin 已经关掉时不抛错，结果里 `accepted` 为 false。
   * 写入最多等 `SystemTuning.command.consoleWriteTimeoutMs`：进程到期还没读走就如实报「已排队」；上一笔还压在管道里时拒绝再写。
   * stdin 管道断开（进程关了输入、写到一半进程退出）的错误在启动时就接住了，不会变成宿主进程的未捕获异常。
   */
  writeConsoleInput(request: SystemConsoleInputRequest): Promise<SystemConsoleControlResult>
  /** 读控制台从 cursor 起的增量输出；缓冲区只留最近一段，挤掉的字符数如实给出。任务不存在或不属于该会话时抛错。 */
  readConsoleOutput(request: SystemConsoleOutputRequest): Promise<SystemConsoleOutputChunk>
  /** 给控制台发中断（POSIX 向进程组发 SIGINT，Windows 退回按进程树终止）；进程已经退出时不抛错，`accepted` 为 false。 */
  interruptConsole(request: SystemConsoleInterruptRequest): Promise<SystemConsoleControlResult>
  /** 停掉这个执行器启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
}

/** 命令执行器的构造参数，由本地内核给。 */
export interface SystemCommandRunnerOptions {
  /** 命令跑在哪个平台上。 */
  platform: NodeJS.Platform
  /** 按这个平台算 shell 参数、终止命令、要不要独立进程组。 */
  platformTools: PlatformCompatibilityApi
  /** 进程约束策略：模式、工作区根、额外写根、是否断网。 */
  confinement: SystemProcessConfinementPolicy
  /** 宿主注入的约束后端；没有内置后端的平台（Windows）靠它，缺了就在受约束模式下失败。 */
  confinementProvider?: SystemProcessConfinementProvider
  /** 选 shell 用。 */
  shells: SystemShellResolverApi
  /** 登记和管理子进程用。 */
  processes: SystemProcessManagerApi
  /** 约束里当作临时目录放行的路径；缺省是系统临时目录。沙箱执行器用它把可写的临时区收进沙箱。 */
  confinementTempDir?: string
  /** 每条命令额外带上的环境变量，盖过 shell 自己的；沙箱执行器用它把 TMPDIR 指进沙箱。 */
  extraEnv?: Readonly<Record<string, string>>
}

export class SystemCommandRunner implements SystemCommandRunnerApi {
  /** 交互式任务启动后给模型的一句话：别在这次工具调用里等输出。 */
  private static readonly ConsoleStartedNote = '命令在控制台里跑，正在等用户输入；用户在聊天里的控制台卡片中打字，本次调用不再有输出。'

  private readonly tasks = new Map<string, ShellBackgroundTaskRecord>()
  private readonly executions = new Map<string, ManagedSystemProcess>()
  private readonly consoles = new Map<string, SystemConsoleOutputBuffer>()
  private readonly options: SystemCommandRunnerOptions

  constructor(options: SystemCommandRunnerOptions) {
    this.options = options
  }

  public async run(
    commandInput: string,
    cwd: string,
    options: ShellRunCommandOptions,
    abortSignal?: AbortSignal
  ): Promise<ShellCommandResult> {
    abortSignal?.throwIfAborted()
    // 工作目录不存在时 spawn 会报成找不到 shell，先核对一次，报错才指向真正的原因。
    const directory = await stat(cwd).catch(() => null)
    if (!directory?.isDirectory()) throw new AppError('NOT_FOUND', `工作目录不存在或不是目录：${cwd}`)
    const command = options.nativeCommand ? describeSystemNativeCommand(options.nativeCommand) : commandInput
    const startedAt = Date.now()
    const prepared = await this.prepare(command, options)
    abortSignal?.throwIfAborted()
    if (options.background) {
      const backgroundProcess = await this.startInBackground(command, cwd, prepared, options, startedAt, abortSignal)
      return buildSystemCommandResult(command, cwd, startedAt, {
        exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
        backgroundProcess, confinement: prepared.evidence, ownership: prepared.ownership, shell: prepared.shell,
      })
    }
    const result = await this.runInForeground(prepared, cwd, {
      timeoutMs: options.timeoutMs ?? SystemTuning.command.timeoutMs,
      maxOutputChars: options.maxOutputChars ?? SystemTuning.command.outputChars,
      abortSignal,
    })
    return buildSystemCommandResult(command, cwd, startedAt, { ...result, ownership: prepared.ownership, shell: prepared.shell })
  }

  public listTasks(options: ShellBackgroundTaskQueryOptions = {}): ShellBackgroundTaskRecord[] {
    const tasks = [...this.tasks.values()].map((task) => ({
      ...task,
      status: this.resolveTaskStatus(task),
      updatedAt: Date.now(),
    }))
    return selectBackgroundTasks(tasks, options)
  }

  public async terminateTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const taskId = task.id
    const signal = request.force ? 'SIGKILL' : 'SIGTERM'
    const statusBefore = this.resolveTaskStatus(task)
    let terminated = false
    let message = statusBefore === 'running' ? '后台进程已发送终止信号。' : '后台进程已经不在运行。'

    if (statusBefore === 'running') {
      try {
        const owned = this.executions.get(taskId)
        if (!owned || owned.child.pid !== task.pid) throw new AppError('PERMISSION', '无法确认后台进程的受管身份。')
        terminated = await owned.stop(signal)
        if (!terminated && !owned.exited) throw new AppError('PLATFORM', '后台进程未在期限内确认退出。')
      } catch (error) {
        if (!this.options.platformTools.isProcessMissingError(error)) {
          // 身份核对失败（PERMISSION）和期限内没退出（PLATFORM）各有自己的错误码，原样抛出，调用方才分得开。
          if (error instanceof AppError) throw error
          throw new AppError('PLATFORM', '终止后台进程失败。', error, { taskId, pid: task.pid, signal })
        }
        message = '后台进程已经退出。'
      }
    }

    const updatedTask = {
      ...task,
      updatedAt: Date.now(),
      status: this.resolveTaskStatus(task),
    }
    this.tasks.set(taskId, updatedTask)

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

  public async writeConsoleInput(request: SystemConsoleInputRequest): Promise<SystemConsoleControlResult> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    if (!task.console) return { taskId: task.id, accepted: false, status, message: '这条后台任务不是交互式的，没有可以写的控制台。' }

    const stdin = this.executions.get(task.id)?.child.stdin
    if (status !== 'running' || !stdin?.writable) return { taskId: task.id, accepted: false, status, message: '控制台已经关闭：进程不在运行，或输入通道已经断开。' }
    // 上一笔输入还压在管道里没被读走：进程多半没在读输入，再写只会越积越多。
    if (stdin.writableNeedDrain) return { taskId: task.id, accepted: false, status, message: '进程还没读走之前写进去的输入（它可能没在读输入），这次没有写；等它读完再写。' }

    // 缺省补一个换行，相当于用户按回车；只想写半行（例如单个按键）时传 submit: false。
    const payload = isFalse(request.submit) ? request.text : `${request.text}\n`
    const outcome = await writeToChildInput(stdin, payload, SystemTuning.command.consoleWriteTimeoutMs)
    const failed = outcome instanceof Error
    return {
      taskId: task.id,
      accepted: !failed,
      status: this.resolveTaskStatus(task),
      message: failed ? `写入控制台失败：${outcome.message}` : outcome === 'written' ? '输入已写进控制台。' : '输入已经排进控制台，进程还没读走。',
    }
  }

  public async readConsoleOutput(request: SystemConsoleOutputRequest): Promise<SystemConsoleOutputChunk> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    const acceptsInput = !!task.console?.acceptsInput && status === 'running'
    const buffered = this.consoles.get(task.id)
    if (!buffered) return { taskId: task.id, text: '', cursor: 0, droppedChars: 0, status, acceptsInput }

    const since = readBoundedOutputSince(buffered.buffer, buffered.produced, request.cursor ?? 0)
    return { taskId: task.id, ...since, status, acceptsInput }
  }

  public async interruptConsole(request: SystemConsoleInterruptRequest): Promise<SystemConsoleControlResult> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    if (!task.console) return { taskId: task.id, accepted: false, status, message: '这条后台任务不是交互式的，没有可以中断的控制台。' }
    if (status !== 'running') return { taskId: task.id, accepted: false, status, message: '进程已经不在运行，不用再中断。' }

    // 只中断自己启动的那个进程：pid 可能已经被系统复用，身份对不上就什么都不发。
    const owned = this.executions.get(task.id)
    if (owned?.child.pid !== task.pid) return { taskId: task.id, accepted: false, status, message: '无法确认后台进程的受管身份，没有发送中断。' }

    // POSIX 向整个进程组发 SIGINT；Windows 没有 SIGINT，退回按进程树终止。
    const delivered = await terminateSystemProcessTree(task.pid, 'SIGINT', { platform: this.options.platform })
    return {
      taskId: task.id,
      accepted: delivered,
      status: this.resolveTaskStatus(task),
      message: delivered ? '已发送中断（Ctrl+C）。' : '中断信号没能送到进程。',
    }
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.executions.values()].filter((entry) => !entry.exited).map((entry) => entry.stop('SIGKILL')))
    this.tasks.clear()
    this.executions.clear()
    this.consoles.clear()
  }

  /**
   * 准备一条命令：核对挑定的 shell 本机有没有 → 选出经过自检的 shell（原生调用则按 argv 生成规格）→ 加进程约束 → Windows 上包进原生进程宿主。
   * 挑定的 shell 本机没有时在这里就拒绝，一个进程都不起：模型是按那个 shell 的语法写的命令，换一个跑出来的是错的结果而不是报错。
   */
  private async prepare(
    command: string,
    { shell: kind, nativeCommand }: ShellRunCommandOptions
  ): Promise<PreparedSystemCommand> {
    const { platform, platformTools, confinement, confinementProvider, confinementTempDir, extraEnv, shells } = this.options
    const candidates = detectSystemShells({ platform, env: process.env })
    if (kind && !candidates.some((candidate) => candidate.kind === kind))
      throw new AppError('VALIDATION', describeUnavailableShellKind(kind, candidates.map(toShellDescriptor)))
    const shell = await shells.resolveReady({ platform, env: process.env, kind })
    const commandSpec = nativeCommand ? buildSystemNativeCommandSpec(nativeCommand, shell)
      : { ...platformTools.getShellCommandSpec(command, shell), env: shell.env }
    const env = { ...commandSpec.env, ...extraEnv }
    const confined = buildSystemProcessConfinementSpawnSpec(
      { spec: commandSpec, policy: confinement },
      { platform, env, provider: confinementProvider, tempDir: confinementTempDir ?? tmpdir() }
    )
    const owned = buildSystemOwnedProcessSpec(confined.spec, { platform, env })
    return {
      spec: owned.spec,
      env,
      evidence: confined.evidence,
      ownership: owned.ownership,
      shell: toShellDescriptor(shell),
    }
  }

  /** 前台跑：受管子进程负责超时、取消和管道排空的期限，这里有界地采集并解码输出。 */
  private runInForeground(
    prepared: PreparedSystemCommand,
    cwd: string,
    options: { timeoutMs: number; maxOutputChars: number; abortSignal?: AbortSignal }
  ): Promise<{
    exitCode: Nullable<number>
    signal: Nullable<string>
    stdout: string
    stderr: string
    timedOut: boolean
    aborted: boolean
    cleanupIncomplete: boolean
    truncated: boolean
    capture: ShellCommandOutputCapture
    confinement: ShellProcessConfinementEvidence
  }> {
    options.abortSignal?.throwIfAborted()
    const child = spawn(prepared.spec.file, prepared.spec.args, {
      cwd, detached: this.options.platformTools.shouldUseDetachedProcessGroup(), env: prepared.env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    const owned = this.options.processes.manage(child, {
      platform: this.options.platform,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
    })
    const maxChars = options.maxOutputChars
    const decoders = { stdout: new SystemOutputDecoder(), stderr: new SystemOutputDecoder() }
    const output = { stdout: '', stderr: '' }
    let truncated = false
    let totalBytes = 0
    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      totalBytes += Buffer.byteLength(text)
      if (output[stream].length + text.length > maxChars) truncated = true
      output[stream] = appendBoundedOutput(output[stream], text, maxChars)
    }
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => append(stream, decoders[stream].write(chunk)))
    return owned.completion.then((result) => {
      for (const stream of ['stdout', 'stderr'] as const) append(stream, decoders[stream].end())
      if (result.spawnError) throw result.spawnError
      const storedBytes = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)
      const capture: ShellCommandOutputCapture = {
        status: result.cleanupIncomplete ? 'failed' : truncated ? 'truncated' : 'complete',
        encoding: 'utf-8', totalBytes, storedBytes, omittedBytes: Math.max(0, totalBytes - storedBytes),
        decodeErrors: decoders.stdout.decodeErrors + decoders.stderr.decodeErrors,
        error: optionalWhen(result.cleanupIncomplete, '到期限时进程的输出还没收完'),
      }
      return { ...result, ...output, confinement: prepared.evidence, truncated, capture }
    })
  }

  /**
   * 后台启动：等进程确认拉起后登记成任务，持续记下最近的输出；进程收尾时把退出码写回任务。拉不起来就停掉并抛错。
   * 交互式任务另外留一根打开的 stdin 管道和一份控制台输出缓冲，回执里带上控制台。
   */
  private async startInBackground(
    command: string,
    cwd: string,
    prepared: PreparedSystemCommand,
    options: ShellRunCommandOptions,
    startedAt: number,
    abortSignal?: AbortSignal
  ): Promise<ShellBackgroundProcessInfo> {
    const { platform, platformTools, processes } = this.options
    const { sessionId, interactive } = options
    const taskId = randomUUID()
    const child = spawn(prepared.spec.file, prepared.spec.args, {
      cwd, detached: platformTools.shouldUseDetachedProcessGroup(),
      stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: prepared.env, windowsHide: true,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    // stdin 管道断开（进程关了输入、写到一半进程退出）时流上会报 error；不接住就成了宿主进程的未捕获异常。写入结果由写的一方从回调里拿，这里只记日志。
    child.stdin?.on('error', (error) => log.debug('控制台的输入管道断开', { taskId, error }))
    const owned = processes.manage(child, { platform, abortSignal })
    // 控制台缓冲在挂输出监听之前就建好，进程一启动就吐的输出不会丢。
    if (interactive) this.consoles.set(taskId, { buffer: '', produced: 0 })
    let recentOutput = ''
    const decoders = { stdout: new SystemOutputDecoder(), stderr: new SystemOutputDecoder() }
    const append = (text: string): void => {
      recentOutput = appendBoundedOutput(recentOutput, text, SystemTuning.command.recentOutputChars)
      this.appendConsoleOutput(taskId, text)
      const task = this.tasks.get(taskId)
      if (task) this.tasks.set(taskId, { ...task, recentOutput, updatedAt: Date.now() })
    }
    // 交互式任务的 stdin 是管道，非交互式是 ignore，所以这里的输出管道按可空处理。
    for (const stream of ['stdout', 'stderr'] as const) child[stream]?.on('data', (chunk: Buffer) => append(decoders[stream].write(chunk)))
    try { await waitForSystemProcessSpawn(child); abortSignal?.throwIfAborted() } catch (error) {
      this.consoles.delete(taskId)
      await owned.stop('SIGKILL')
      throw error
    }
    const pid = child.pid!
    // 本机只有管道，没有 PTY：真正的终端由宿主在自己的端口实现里提供，那时 channel 报成 pty。
    const consoleSession: Optional<ShellConsoleSessionInfo> = optionalWhen(interactive, {
      taskId, channel: 'pipe' as const, acceptsInput: true, note: SystemCommandRunner.ConsoleStartedNote,
    })
    // 进程收尾后控制台还留在任务上，只是不再接受输入。
    const closedConsole: Optional<ShellConsoleSessionInfo> = consoleSession
      ? { ...consoleSession, acceptsInput: false }
      : undefined
    const backgroundProcess: ShellBackgroundProcessInfo = {
      taskId, sessionId: toNullable(sessionId), pid, logPath: null, ports: [],
      reason: null, terminateCommand: platformTools.getTerminateCommand(pid, false, prepared.shell),
      forceTerminateCommand: platformTools.getTerminateCommand(pid, true, prepared.shell), fallbackTerminateCommand: null,
      requested: true, autoStarted: false, console: consoleSession,
    }
    const task: ShellBackgroundTaskRecord = {
      id: taskId, runId: taskId, sessionId: toNullable(sessionId), command,
      cwd, pid, logPath: null, ports: [], reason: null,
      terminateCommand: backgroundProcess.terminateCommand,
      forceTerminateCommand: backgroundProcess.forceTerminateCommand, fallbackTerminateCommand: null,
      requested: true, autoStarted: false, startedAt, updatedAt: startedAt,
      status: 'running', recentOutput: recentOutput || null, console: consoleSession,
    }
    this.tasks.set(taskId, task)
    this.executions.set(taskId, owned)
    void owned.completion.then((result) => {
      for (const stream of ['stdout', 'stderr'] as const) append(decoders[stream].end())
      this.tasks.set(taskId, { ...task, status: result.cleanupIncomplete ? 'unknown' : 'exited',
        recentOutput, exitCode: result.exitCode, signal: result.signal,
        cleanupIncomplete: result.cleanupIncomplete, finishedAt: Date.now(), updatedAt: Date.now(),
        console: closedConsole })
      this.pruneFinishedTasks()
    }).catch((error) => log.warn('后台进程完成记录失败', { taskId, error }))
    return backgroundProcess
  }

  /** 已结束的任务只留最近 SystemTuning.command.finishedTasks 条：最早结束的先删，它们的进程句柄一起释放。 */
  private pruneFinishedTasks(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt))
    for (const task of finished.slice(0, Math.max(0, finished.length - SystemTuning.command.finishedTasks))) {
      this.tasks.delete(task.id)
      this.executions.delete(task.id)
      this.consoles.delete(task.id)
    }
  }

  /** 把一段输出并进控制台缓冲区；不是交互式任务就什么都不做。 */
  private appendConsoleOutput(taskId: string, text: string): void {
    const buffered = this.consoles.get(taskId)
    if (!buffered || !text) return
    this.consoles.set(taskId, {
      buffer: appendBoundedOutput(buffered.buffer, text, SystemTuning.command.consoleBufferChars),
      produced: buffered.produced + text.length,
    })
  }

  /** 取出一条任务并核对会话归属：任务不存在、不属于请求里的会话时抛错。 */
  private requireTask(requestedTaskId: string, sessionId: LooseOptional<string>): ShellBackgroundTaskRecord {
    const taskId = requestedTaskId.trim()
    if (!taskId) throw new AppError('VALIDATION', '后台任务 id 不能为空。')

    const task = this.tasks.get(taskId)
    if (!task) throw new AppError('NOT_FOUND', `未找到后台任务：${taskId}`)

    if (sessionId && task.sessionId !== sessionId) {
      throw new AppError('PERMISSION', '后台任务不属于当前会话。', undefined, {
        taskId,
        sessionId,
        ownerSessionId: task.sessionId,
      })
    }
    return task
  }

  /** 后台任务此刻的状态：受管进程还在就看它是否退出、收尾是否完整；已经不在登记里时看任务有没有记下结束时间。 */
  private resolveTaskStatus(task: ShellBackgroundTaskRecord): ShellBackgroundTaskStatus {
    const owned = this.executions.get(task.id)
    if (!owned) return task.finishedAt ? 'exited' : 'unknown'
    return owned.result?.cleanupIncomplete ? 'unknown' : owned.exited ? 'exited' : 'running'
  }
}
