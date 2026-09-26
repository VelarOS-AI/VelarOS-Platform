/**
 * 命令执行器：`ShellCommandRunner`。接口 `ShellCommandRunnerApi` 与它的构造参数 `ShellCommandRunnerOptions` 就在本文件的类上方。
 * 本机宿主与受约束执行器创建并持有它；一条命令从选 shell、加约束、起受管子进程，到前台采集或后台登记，都在这里。
 * 交互式任务的控制台也归它：宿主给了伪终端工厂就在真终端里跑，没给就留一根打开的 stdin 管道；输出另存一份带位置的缓冲，
 * 用户的输入、中断、终端尺寸经这里递给进程，新输出推给订阅的人。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { isFalse, isUndefined, Log, optionalWhen, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { PlatformCompatibilityApi } from '@velaros-ai/core/platform'

import { ShellLimits } from '../../contract/constants.js'
import type {
  ShellProcessConfinementProvider,
  ShellTerminalFactory,
} from '../../contract/requires.js'
import type {
  PreparedShellCommand,
  ShellConsoleBuffer,
  ShellProcessConfinementPolicy,
} from '../../types/local.js'
import type {
  ShellBackgroundProcessInfo,
  ShellBackgroundTaskQueryOptions,
  ShellBackgroundTaskRecord,
  ShellBackgroundTaskStatus,
  ShellCommandOutputCapture,
  ShellCommandResult,
  ShellConsoleSessionInfo,
  ShellProcessConfinementEvidence,
  ShellRunCommandOptions,
} from '../../types/shell-command.js'
import type {
  ShellConsoleControlResult,
  ShellConsoleOutputChunk,
  ShellTaskTerminateReport,
} from '../../types/shell-command.js'
import type {
  ShellConsoleInputRequest,
  ShellConsoleInterruptRequest,
  ShellConsoleOutputEvent,
  ShellConsoleOutputRequest,
  ShellConsoleResizeRequest,
  ShellConsoleWatchRequest,
  ShellTaskTerminateRequest,
} from '../../types/shell-command.js'
import { buildShellCommandResult } from '../../utils/command-result.js'
import { buildConfinedSpawnSpec } from '../../utils/confinement.js'
import { appendBoundedOutput, readBoundedOutputSince } from '../../utils/output.js'
import {
  buildOwnedProcessSpec,
  terminateProcessTree,
  waitForProcessSpawn,
  writeToChildInput,
} from '../../utils/process.js'
import {
  buildNativeCommandSpec,
  describeNativeCommand,
  describeUnavailableShellKind,
  detectAvailableShells,
  toShellDescriptor,
} from '../../utils/shells.js'
import { selectBackgroundTasks } from '../../utils/system-info.js'
import { ShellTuning } from '../../utils/tuning.js'

import type { ShellEnvironmentApi } from './ShellEnvironment.js'
import type { ManagedShellProcess } from './ShellManagedProcess.js'
import { ShellOutputDecoder } from './ShellOutputDecoder.js'
import type { ShellProcessManagerApi } from './ShellProcessManager.js'
import type { ShellResolverApi } from './ShellResolver.js'

const log = Log.tag('ShellCommandRunner')

/**
 * 命令执行器：把一条命令变成受管子进程跑起来。前台等它结束并采集输出；后台登记成后台任务，之后可查、可停。
 *
 * 实现是 `ShellCommandRunner`，由本机宿主（与受约束执行器）创建并持有。它启动过的后台进程归它管，内核释放时一并停掉。
 */
export interface ShellCommandRunnerApi {
  /**
   * 跑一条命令，返回完整结果。
   *
   * 链路：选 shell（`options.shell` 挑定哪一种，本机没有它就以 VALIDATION 拒绝、一个进程都不起；给了 nativeCommand 就按原生 argv 执行）
   * → 加进程约束 → Windows 上包进原生进程宿主 → 启动受管子进程。
   * 前台：有界采集 stdout 与 stderr，超时或取消后在期限内收敛，失败时把输出末尾摘进 verification。
   * 后台（options.background）：进程拉起后登记成后台任务就返回，结果里带任务 id 和终止命令。
   * 交互式（options.interactive，必须和 background 一起）：宿主给了伪终端工厂就在真终端里跑（channel 为 `pty`），
   * 没给就留一根保持打开的 stdin 管道（channel 为 `pipe`）；输出另外存进控制台缓冲区，结果的 `backgroundProcess.console` 给出这个控制台。
   * 命令自己失败（非零退出、超时、取消）不抛错，如实写进结果；找不到能用的 shell、约束后端缺失、进程拉不起来才抛错。
   * @param command 命令文本；给了 options.nativeCommand 时只用来展示
   * @param cwd 已经解析好的绝对工作目录
   */
  run(
    command: string,
    cwd: string,
    options: ShellRunCommandOptions,
    abortSignal?: AbortSignal
  ): Promise<ShellCommandResult>
  /** 列出后台任务：可按任务 id、会话、命令过滤词、只看运行中来筛，给了 limit 就最多那么多条（不给全列）；状态按受管进程此刻的情况给出。 */
  listTasks(options?: ShellBackgroundTaskQueryOptions): ShellBackgroundTaskRecord[]
  /**
   * 终止一个后台任务，返回终止前后的状态。
   *
   * 先核对任务存在、属于请求里的会话、进程确实是自己启动的那个，再发信号（force 时直接 SIGKILL）并等它在期限内退出。
   * 进程已经不在了不算失败，结果里如实说明；核对不过或期限内没退出时抛错。
   */
  terminateTask(request: ShellTaskTerminateRequest): Promise<ShellTaskTerminateReport>
  /**
   * 往交互式任务的控制台写一段输入，缺省补一个回车（管道里是换行，终端里是 `\r`）。
   * 先核对任务存在、属于请求里的会话；进程已经退出、这条任务不是交互式的、stdin 已经关掉时不抛错，结果里 `accepted` 为 false。
   * 管道：写入最多等 `ShellTuning.command.consoleWriteTimeoutMs`，进程到期还没读走就如实报「已排队」；上一笔还压在管道里时拒绝再写。
   * stdin 管道断开（进程关了输入、写到一半进程退出）的错误在启动时就接住了，不会变成宿主进程的未捕获异常。终端：原样写进去，由终端回显。
   */
  writeConsoleInput(request: ShellConsoleInputRequest): Promise<ShellConsoleControlResult>
  /** 读控制台从 cursor 起的增量输出；缓冲区只留最近一段，挤掉的字符数如实给出。任务不存在或不属于该会话时抛错。 */
  readConsoleOutput(request: ShellConsoleOutputRequest): Promise<ShellConsoleOutputChunk>
  /**
   * 给控制台发中断：终端里写一个 Ctrl+C，由终端发给它的前台进程组（交互 shell 里正在跑的那条命令也收得到）；
   * 管道下 POSIX 向进程组发 SIGINT，Windows 退回按进程树终止。进程已经退出时不抛错，`accepted` 为 false。
   */
  interruptConsole(request: ShellConsoleInterruptRequest): Promise<ShellConsoleControlResult>
  /** 改控制台的终端尺寸；列数、行数不是正整数时抛 VALIDATION。管道后面的任务没有尺寸、进程已经退出时不抛错，`accepted` 为 false。 */
  resizeConsole(request: ShellConsoleResizeRequest): Promise<ShellConsoleControlResult>
  /**
   * 订阅控制台的新输出：每段带着它结束处的 cursor（与读增量输出同一把尺子），返回退订函数。
   * 任务不存在或不属于该会话时抛错；不是交互式任务时什么也收不到。订阅方抛错只记日志，不影响输出入缓冲。
   */
  watchConsoleOutput(
    request: ShellConsoleWatchRequest,
    listener: (event: ShellConsoleOutputEvent) => void
  ): () => void
  /** 停掉这个执行器启动过、还没退出的全部后台进程。 */
  dispose(): Promise<void>
}

/** 命令执行器的构造参数，由本机宿主或受约束执行器给。 */
export interface ShellCommandRunnerOptions {
  /** 借用宿主的登录环境，命令启动前读取当前代次。 */
  environment?: ShellEnvironmentApi
  /** 命令跑在哪个平台上。 */
  platform: NodeJS.Platform
  /** 按这个平台算 shell 参数、终止命令、要不要独立进程组。 */
  platformTools: PlatformCompatibilityApi
  /** 进程约束策略：模式、工作区根、额外写根、是否断网。 */
  confinement: ShellProcessConfinementPolicy
  /** 宿主注入的约束后端；没有内置后端的平台（Windows）靠它，缺了就在受约束模式下失败。 */
  confinementProvider?: ShellProcessConfinementProvider
  /** 选 shell 用。 */
  shells: ShellResolverApi
  /** 登记和管理子进程用。 */
  processes: ShellProcessManagerApi
  /** 约束里当作临时目录放行的路径；缺省是系统临时目录。沙箱执行器用它把可写的临时区收进沙箱。 */
  confinementTempDir?: string
  /** 每条命令额外带上的环境变量，盖过 shell 自己的；沙箱执行器用它把 TMPDIR 指进沙箱。 */
  extraEnv?: Readonly<Record<string, string>>
  /** 宿主的伪终端工厂；给了，交互式任务在真终端里跑。 */
  terminal?: ShellTerminalFactory
}

export class ShellCommandRunner implements ShellCommandRunnerApi {
  /** 交互式任务启动后给模型的一句话：别在这次工具调用里等输出。 */
  private static readonly ConsoleStartedNote =
    '命令在控制台里跑，正在等用户输入；用户在控制台里打字，本次调用不再有输出。'
  /** 伪终端里的进程看到的终端类型：256 色，并声明支持真彩色。 */
  private static readonly TerminalEnv = Object.freeze({
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  })

  private readonly tasks = new Map<string, ShellBackgroundTaskRecord>()
  private readonly executions = new Map<string, ManagedShellProcess>()
  private readonly consoles = new Map<string, ShellConsoleBuffer>()
  private readonly options: ShellCommandRunnerOptions

  constructor(options: ShellCommandRunnerOptions) {
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
    if (options.background && !isUndefined(options.stdin))
      throw new AppError('VALIDATION', '前台标准输入不能与后台命令一起使用。')
    const directory = await stat(cwd).catch(() => null)
    if (!directory?.isDirectory())
      throw new AppError('NOT_FOUND', `工作目录不存在或不是目录：${cwd}`)
    const command = options.nativeCommand
      ? describeNativeCommand(options.nativeCommand)
      : commandInput
    const startedAt = Date.now()
    const prepared = await this.prepare(command, options, abortSignal)
    abortSignal?.throwIfAborted()
    if (options.background) {
      const backgroundProcess = await this.startInBackground(
        command,
        cwd,
        prepared,
        options,
        startedAt,
        abortSignal
      )
      return buildShellCommandResult(command, cwd, startedAt, {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        backgroundProcess,
        confinement: prepared.evidence,
        ownership: prepared.ownership,
        shell: prepared.shell,
      })
    }
    const result = await this.runInForeground(prepared, cwd, {
      timeoutMs: options.timeoutMs ?? ShellTuning.command.timeoutMs,
      maxOutputChars: options.maxOutputChars ?? ShellTuning.command.outputChars,
      stdin: options.stdin,
      abortSignal,
    })
    return buildShellCommandResult(command, cwd, startedAt, {
      ...result,
      ownership: prepared.ownership,
      shell: prepared.shell,
    })
  }

  public listTasks(options: ShellBackgroundTaskQueryOptions = {}): ShellBackgroundTaskRecord[] {
    const tasks = [...this.tasks.values()].map((task) => ({
      ...task,
      status: this.resolveTaskStatus(task),
      updatedAt: Date.now(),
    }))
    return selectBackgroundTasks(tasks, options)
  }

  public async terminateTask(
    request: ShellTaskTerminateRequest
  ): Promise<ShellTaskTerminateReport> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const taskId = task.id
    const signal = request.force ? 'SIGKILL' : 'SIGTERM'
    const statusBefore = this.resolveTaskStatus(task)
    let terminated = false
    let message = statusBefore === 'running' ? '后台进程已发送终止信号。' : '后台进程已经不在运行。'

    if (statusBefore === 'running') {
      try {
        const owned = this.executions.get(taskId)
        if (!owned || owned.pid !== task.pid)
          throw new AppError('PERMISSION', '无法确认后台进程的受管身份。')
        terminated = await owned.stop(signal)
        if (!terminated && !owned.exited)
          throw new AppError('PLATFORM', '后台进程未在期限内确认退出。')
      } catch (error) {
        if (!this.options.platformTools.isProcessMissingError(error)) {
          // 身份核对失败（PERMISSION）和期限内没退出（PLATFORM）各有自己的错误码，原样抛出，调用方才分得开。
          if (error instanceof AppError) throw error
          throw new AppError('PLATFORM', '终止后台进程失败。', error, {
            taskId,
            pid: task.pid,
            signal,
          })
        }
        message = '后台进程已经退出。'
      }
    }

    // 停下时收尾回调已经把退出码、信号、结束时间和关掉的控制台写进任务了：在它之上更新，别拿停之前那份盖回去。
    const current = this.tasks.get(taskId) ?? task
    const updatedTask = {
      ...current,
      updatedAt: Date.now(),
      status: this.resolveTaskStatus(current),
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

  public async writeConsoleInput(
    request: ShellConsoleInputRequest
  ): Promise<ShellConsoleControlResult> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    if (!task.console)
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '这条后台任务不是交互式的，没有可以写的控制台。',
      }

    const end = this.consoles.get(task.id)?.end
    if (status !== 'running' || !end || (end.channel === 'pipe' && !end.stdin.writable))
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '控制台已经关闭：进程不在运行，或输入通道已经断开。',
      }
    // 终端里回车是 \r，由终端按自己的设置换成程序读到的换行；回显也归终端。
    if (end.channel === 'pty') {
      end.terminal.write(isFalse(request.submit) ? request.text : `${request.text}\r`)
      return { taskId: task.id, accepted: true, status, message: '输入已写进控制台。' }
    }
    const stdin = end.stdin
    // 上一笔输入还压在管道里没被读走：进程多半没在读输入，再写只会越积越多。
    if (stdin.writableNeedDrain)
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '进程还没读走之前写进去的输入（它可能没在读输入），这次没有写；等它读完再写。',
      }

    // 缺省补一个换行，相当于用户按回车；只想写半行（例如单个按键）时传 submit: false。
    const payload = isFalse(request.submit) ? request.text : `${request.text}\n`
    const outcome = await writeToChildInput(
      stdin,
      payload,
      ShellTuning.command.consoleWriteTimeoutMs
    )
    const failed = outcome instanceof Error
    return {
      taskId: task.id,
      accepted: !failed,
      status: this.resolveTaskStatus(task),
      message: failed
        ? `写入控制台失败：${outcome.message}`
        : outcome === 'written'
          ? '输入已写进控制台。'
          : '输入已经排进控制台，进程还没读走。',
    }
  }

  public async readConsoleOutput(
    request: ShellConsoleOutputRequest
  ): Promise<ShellConsoleOutputChunk> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    const acceptsInput = !!task.console?.acceptsInput && status === 'running'
    const buffered = this.consoles.get(task.id)
    if (!buffered)
      return { taskId: task.id, text: '', cursor: 0, droppedChars: 0, status, acceptsInput }

    const since = readBoundedOutputSince(buffered.buffer, buffered.produced, request.cursor ?? 0)
    return { taskId: task.id, ...since, status, acceptsInput }
  }

  public async interruptConsole(
    request: ShellConsoleInterruptRequest
  ): Promise<ShellConsoleControlResult> {
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    if (!task.console)
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '这条后台任务不是交互式的，没有可以中断的控制台。',
      }
    if (status !== 'running')
      return { taskId: task.id, accepted: false, status, message: '进程已经不在运行，不用再中断。' }

    // 只中断自己启动的那个进程：pid 可能已经被系统复用，身份对不上就什么都不发。
    const owned = this.executions.get(task.id)
    if (owned?.pid !== task.pid)
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '无法确认后台进程的受管身份，没有发送中断。',
      }

    // 终端里就是按一下 Ctrl+C：终端把 SIGINT 发给它的前台进程组，交互 shell 里正在跑的那条命令也收得到。
    const end = this.consoles.get(task.id)?.end
    if (end?.channel === 'pty') {
      end.terminal.write('\u0003')
      return { taskId: task.id, accepted: true, status, message: '已发送中断（Ctrl+C）。' }
    }

    // POSIX 向整个进程组发 SIGINT；Windows 没有 SIGINT，退回按进程树终止。
    const delivered = await terminateProcessTree(task.pid, 'SIGINT', {
      platform: this.options.platform,
    })
    return {
      taskId: task.id,
      accepted: delivered,
      status: this.resolveTaskStatus(task),
      message: delivered ? '已发送中断（Ctrl+C）。' : '中断信号没能送到进程。',
    }
  }

  public async resizeConsole(
    request: ShellConsoleResizeRequest
  ): Promise<ShellConsoleControlResult> {
    const { cols, rows } = request
    if (![cols, rows].every((size) => Number.isInteger(size) && size > 0))
      throw new AppError('VALIDATION', `终端尺寸要是正整数：${cols}×${rows}`)
    const task = this.requireTask(request.taskId, request.sessionId)
    const status = this.resolveTaskStatus(task)
    const end = this.consoles.get(task.id)?.end
    if (end?.channel !== 'pty')
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '这条任务不在终端里跑，没有终端尺寸。',
      }
    if (status !== 'running')
      return {
        taskId: task.id,
        accepted: false,
        status,
        message: '进程已经不在运行，不用再改尺寸。',
      }

    end.terminal.resize(cols, rows)
    return { taskId: task.id, accepted: true, status, message: `终端尺寸改成了 ${cols}×${rows}。` }
  }

  public watchConsoleOutput(
    request: ShellConsoleWatchRequest,
    listener: (event: ShellConsoleOutputEvent) => void
  ): () => void {
    const task = this.requireTask(request.taskId, request.sessionId)
    const buffered = this.consoles.get(task.id)
    if (!buffered) return () => undefined
    buffered.watchers.add(listener)
    return () => {
      buffered.watchers.delete(listener)
    }
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.executions.values()]
        .filter((entry) => !entry.exited)
        .map((entry) => entry.stop('SIGKILL'))
    )
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
    { shell: kind, nativeCommand }: ShellRunCommandOptions,
    signal?: AbortSignal
  ): Promise<PreparedShellCommand> {
    const {
      platform,
      platformTools,
      confinement,
      confinementProvider,
      confinementTempDir,
      extraEnv,
      shells,
    } = this.options
    const environment = this.options.environment
      ? await this.options.environment.getEnvironment(signal)
      : process.env
    signal?.throwIfAborted()
    const candidates = detectAvailableShells({ platform, env: environment })
    if (kind && !candidates.some((candidate) => candidate.kind === kind))
      throw new AppError(
        'VALIDATION',
        describeUnavailableShellKind(kind, candidates.map(toShellDescriptor))
      )
    const shell = await shells.resolveReady({ platform, env: environment, kind, signal })
    const commandSpec = nativeCommand
      ? buildNativeCommandSpec(nativeCommand, shell)
      : { ...platformTools.getShellCommandSpec(command, shell), env: shell.env }
    const env = { ...commandSpec.env, ...extraEnv }
    const confined = buildConfinedSpawnSpec(
      { spec: commandSpec, policy: confinement },
      { platform, env, provider: confinementProvider, tempDir: confinementTempDir ?? tmpdir() }
    )
    const owned = buildOwnedProcessSpec(confined.spec, { platform, env })
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
    prepared: PreparedShellCommand,
    cwd: string,
    options: {
      timeoutMs: number
      maxOutputChars: number
      stdin?: string
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
    capture: ShellCommandOutputCapture
    confinement: ShellProcessConfinementEvidence
  }> {
    options.abortSignal?.throwIfAborted()
    const child = spawn(prepared.spec.file, prepared.spec.args, {
      cwd,
      detached: this.options.platformTools.shouldUseDetachedProcessGroup(),
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    const owned = this.options.processes.manage(child, {
      platform: this.options.platform,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
    })
    const maxChars = options.maxOutputChars
    const decoders = { stdout: new ShellOutputDecoder(), stderr: new ShellOutputDecoder() }
    const output = { stdout: '', stderr: '' }
    let truncated = false
    let totalBytes = 0
    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      totalBytes += Buffer.byteLength(text)
      if (output[stream].length + text.length > maxChars) truncated = true
      output[stream] = appendBoundedOutput(output[stream], text, maxChars)
    }
    for (const stream of ['stdout', 'stderr'] as const)
      child[stream].on('data', (chunk: Buffer) => append(stream, decoders[stream].write(chunk)))
    child.stdin.on('error', (error) => log.debug('前台命令输入管道已关闭', { error }))
    child.stdin.end(options.stdin, 'utf8')
    return owned.completion.then((result) => {
      for (const stream of ['stdout', 'stderr'] as const) append(stream, decoders[stream].end())
      if (result.spawnError) throw result.spawnError
      const storedBytes = Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)
      const capture: ShellCommandOutputCapture = {
        status: result.cleanupIncomplete ? 'failed' : truncated ? 'truncated' : 'complete',
        encoding: 'utf-8',
        totalBytes,
        storedBytes,
        omittedBytes: Math.max(0, totalBytes - storedBytes),
        decodeErrors: decoders.stdout.decodeErrors + decoders.stderr.decodeErrors,
        error: optionalWhen(result.cleanupIncomplete, '到期限时进程的输出还没收完'),
      }
      return { ...result, ...output, confinement: prepared.evidence, truncated, capture }
    })
  }

  /**
   * 后台启动：等进程确认拉起后登记成任务，持续记下最近的输出；进程收尾时把退出码写回任务。拉不起来就停掉并抛错。
   * 交互式任务另外建一份控制台（输出缓冲与另一头：伪终端或打开的 stdin 管道），回执里带上控制台。
   */
  private async startInBackground(
    command: string,
    cwd: string,
    prepared: PreparedShellCommand,
    options: ShellRunCommandOptions,
    startedAt: number,
    abortSignal?: AbortSignal
  ): Promise<ShellBackgroundProcessInfo> {
    const { platformTools } = this.options
    const { sessionId, interactive } = options
    const terminal = interactive ? this.options.terminal : undefined
    const taskId = randomUUID()
    // 控制台缓冲在挂输出监听之前就建好，进程一启动就吐的输出不会丢。
    if (interactive) this.consoles.set(taskId, { buffer: '', produced: 0, watchers: new Set() })
    let recentOutput = ''
    const append = (text: string): void => {
      recentOutput = appendBoundedOutput(recentOutput, text, ShellLimits.outputChars)
      this.appendConsoleOutput(taskId, text)
      const task = this.tasks.get(taskId)
      if (task) this.tasks.set(taskId, { ...task, recentOutput, updatedAt: Date.now() })
    }
    let started: { owned: ManagedShellProcess; flush: () => void }
    try {
      started = terminal
        ? this.startInTerminal(terminal, prepared, cwd, taskId, append, abortSignal)
        : await this.startWithPipes(prepared, cwd, taskId, !!interactive, append, abortSignal)
    } catch (error) {
      this.consoles.delete(taskId)
      throw error
    }
    const { owned, flush } = started
    const pid = owned.pid!
    // 宿主给了伪终端就是真终端（pty），没给就是一根保持打开的输入管道（pipe）。
    const consoleSession: Optional<ShellConsoleSessionInfo> = optionalWhen(interactive, {
      taskId,
      channel: terminal ? ('pty' as const) : ('pipe' as const),
      acceptsInput: true,
      note: ShellCommandRunner.ConsoleStartedNote,
    })
    // 进程收尾后控制台还留在任务上，只是不再接受输入。
    const closedConsole: Optional<ShellConsoleSessionInfo> = consoleSession
      ? { ...consoleSession, acceptsInput: false }
      : undefined
    const backgroundProcess: ShellBackgroundProcessInfo = {
      taskId,
      sessionId: toNullable(sessionId),
      pid,
      logPath: null,
      ports: [],
      reason: null,
      terminateCommand: platformTools.getTerminateCommand(pid, false, prepared.shell),
      forceTerminateCommand: platformTools.getTerminateCommand(pid, true, prepared.shell),
      fallbackTerminateCommand: null,
      requested: true,
      autoStarted: false,
      console: consoleSession,
    }
    const task: ShellBackgroundTaskRecord = {
      id: taskId,
      runId: taskId,
      sessionId: toNullable(sessionId),
      command,
      cwd,
      pid,
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
      recentOutput: recentOutput || null,
      console: consoleSession,
    }
    this.tasks.set(taskId, task)
    this.executions.set(taskId, owned)
    void owned.completion
      .then((result) => {
        flush()
        this.tasks.set(taskId, {
          ...task,
          status: result.cleanupIncomplete ? 'unknown' : 'exited',
          recentOutput,
          exitCode: result.exitCode,
          signal: result.signal,
          cleanupIncomplete: result.cleanupIncomplete,
          finishedAt: Date.now(),
          updatedAt: Date.now(),
          console: closedConsole,
        })
        this.pruneFinishedTasks()
      })
      .catch((error) => log.warn('后台进程完成记录失败', { taskId, error }))
    return backgroundProcess
  }

  /**
   * 用管道起后台进程：stdout、stderr 各自解码后记下；交互式的留一根打开的 stdin 当控制台的另一头。
   * 等进程确认拉起，拉不起来（或这时已经取消）就强杀并抛错。返回的 flush 在收尾时把解码器里剩下的半个字吐出来。
   */
  private async startWithPipes(
    prepared: PreparedShellCommand,
    cwd: string,
    taskId: string,
    interactive: boolean,
    append: (text: string) => void,
    abortSignal?: AbortSignal
  ): Promise<{ owned: ManagedShellProcess; flush: () => void }> {
    const { platform, platformTools, processes } = this.options
    const child = spawn(prepared.spec.file, prepared.spec.args, {
      cwd,
      detached: platformTools.shouldUseDetachedProcessGroup(),
      stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: prepared.env,
      windowsHide: true,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    // stdin 管道断开（进程关了输入、写到一半进程退出）时流上会报 error；不接住就成了宿主进程的未捕获异常。写入结果由写的一方从回调里拿，这里只记日志。
    child.stdin?.on('error', (error) => log.debug('控制台的输入管道断开', { taskId, error }))
    const owned = processes.manage(child, { platform, abortSignal })
    const decoders = { stdout: new ShellOutputDecoder(), stderr: new ShellOutputDecoder() }
    // 交互式任务的 stdin 是管道，非交互式是 ignore，所以这里的输出管道按可空处理。
    for (const stream of ['stdout', 'stderr'] as const)
      child[stream]?.on('data', (chunk: Buffer) => append(decoders[stream].write(chunk)))
    try {
      await waitForProcessSpawn(child)
      abortSignal?.throwIfAborted()
    } catch (error) {
      await owned.stop('SIGKILL')
      throw error
    }
    const buffered = this.consoles.get(taskId)
    if (buffered && child.stdin) buffered.end = { channel: 'pipe', stdin: child.stdin }
    return {
      owned,
      flush: () => {
        for (const stream of ['stdout', 'stderr'] as const) append(decoders[stream].end())
      },
    }
  }

  /**
   * 在宿主的伪终端里起交互式任务：终端输出只有一路、已经解码，终端本身就是控制台的另一头。
   * 进程带着约束包装原样交给工厂，TERM 与终端类型一致；工厂起不来就抛错。
   */
  private startInTerminal(
    factory: ShellTerminalFactory,
    prepared: PreparedShellCommand,
    cwd: string,
    taskId: string,
    append: (text: string) => void,
    abortSignal?: AbortSignal
  ): { owned: ManagedShellProcess; flush: () => void } {
    abortSignal?.throwIfAborted()
    const terminal = factory.spawn(prepared.spec.file, prepared.spec.args, {
      cwd,
      env: { ...prepared.env, ...ShellCommandRunner.TerminalEnv },
      cols: ShellTuning.command.consoleColumns,
      rows: ShellTuning.command.consoleRows,
      name: ShellCommandRunner.TerminalEnv.TERM,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    const owned = this.options.processes.manageTerminal(terminal, {
      platform: this.options.platform,
      abortSignal,
    })
    terminal.onData(append)
    const buffered = this.consoles.get(taskId)
    if (buffered) buffered.end = { channel: 'pty', terminal }
    return { owned, flush: () => undefined }
  }

  /** 已结束的任务只留最近 ShellTuning.command.finishedTasks 条：最早结束的先删，它们的进程句柄一起释放。 */
  private pruneFinishedTasks(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt))
    for (const task of finished.slice(
      0,
      Math.max(0, finished.length - ShellTuning.command.finishedTasks)
    )) {
      this.tasks.delete(task.id)
      this.executions.delete(task.id)
      this.consoles.delete(task.id)
    }
  }

  /** 把一段输出并进控制台缓冲区并推给订阅的人；不是交互式任务就什么都不做。 */
  private appendConsoleOutput(taskId: string, text: string): void {
    const buffered = this.consoles.get(taskId)
    if (!buffered || !text) return
    buffered.buffer = appendBoundedOutput(
      buffered.buffer,
      text,
      ShellTuning.command.consoleBufferChars
    )
    buffered.produced += text.length
    const event: ShellConsoleOutputEvent = { taskId, text, cursor: buffered.produced }
    for (const watcher of buffered.watchers) {
      try {
        watcher(event)
      } catch (error) {
        log.warn('控制台新输出的订阅方处理失败', { taskId, error })
      }
    }
  }

  /** 取出一条任务并核对会话归属：任务不存在、不属于请求里的会话时抛错。 */
  private requireTask(
    requestedTaskId: string,
    sessionId: LooseOptional<string>
  ): ShellBackgroundTaskRecord {
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
