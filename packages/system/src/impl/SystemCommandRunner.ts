/**
 * 命令执行器：`SystemCommandRunner`。接口见 `contract/commands.ts`。
 * 本地内核创建并持有它；一条命令从选 shell、加约束、起受管子进程，到前台采集或后台登记，都在这里。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { Log, optionalWhen, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CommandSpec } from '../contract/platform.js'
import type {
  SystemBackgroundProcessInfo,
  SystemBackgroundTaskQueryOptions,
  SystemBackgroundTaskRecord,
  SystemBackgroundTaskStatus,
  SystemBackgroundTaskTerminateRequest,
  SystemBackgroundTaskTerminateResult,
  SystemCommandOutputCapture,
  SystemCommandResult,
  SystemProcessConfinementEvidence,
  SystemProcessOwnership,
  SystemRunCommandOptions,
  SystemShellDescriptor,
} from '../contract/system.js'
import type { ManagedSystemProcess, SystemCommandRunnerApi, SystemCommandRunnerOptions } from '../interface/internal.js'
import { buildSystemCommandResult } from '../utils/command-result.js'
import { buildSystemProcessConfinementSpawnSpec } from '../utils/confinement.js'
import { buildSystemOwnedProcessSpec, waitForSystemProcessSpawn } from '../utils/process.js'
import { buildSystemNativeCommandSpec, describeSystemNativeCommand, toShellDescriptor } from '../utils/shell.js'
import { appendBoundedOutput } from '../utils/text.js'

import { SystemOutputDecoder } from './SystemOutputDecoder.js'

const DefaultCommandTimeoutMs = 120_000
const DefaultOutputChars = 50_000
/** 后台任务记录里保留的最近输出字符数。 */
const BackgroundRecentOutputChars = 4_000
/** 已结束的后台任务最多留多少条，超过从最早结束的删起，进程句柄一起释放。 */
const MaxFinishedTasks = 200
const log = Log.tag('SystemCommandRunner')

/** 准备好的一条命令：可以直接 spawn 的规格和环境，外加约束、归属、shell 三份证据。 */
type PreparedSystemCommand = {
  spec: CommandSpec
  env: NodeJS.ProcessEnv
  evidence: SystemProcessConfinementEvidence
  ownership: SystemProcessOwnership
  shell: SystemShellDescriptor
}

export class SystemCommandRunner implements SystemCommandRunnerApi {
  private readonly tasks = new Map<string, SystemBackgroundTaskRecord>()
  private readonly executions = new Map<string, ManagedSystemProcess>()
  private readonly options: SystemCommandRunnerOptions

  constructor(options: SystemCommandRunnerOptions) {
    this.options = options
  }

  public async run(
    commandInput: string,
    cwd: string,
    options: SystemRunCommandOptions,
    abortSignal?: AbortSignal
  ): Promise<SystemCommandResult> {
    abortSignal?.throwIfAborted()
    const command = options.nativeCommand ? describeSystemNativeCommand(options.nativeCommand) : commandInput
    const startedAt = Date.now()
    const prepared = await this.prepare(command, options.nativeCommand)
    abortSignal?.throwIfAborted()
    if (options.background) {
      const backgroundProcess = await this.startInBackground(command, cwd, prepared, options.sessionId, startedAt, abortSignal)
      return buildSystemCommandResult(command, cwd, startedAt, {
        exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false,
        backgroundProcess, confinement: prepared.evidence, ownership: prepared.ownership, shell: prepared.shell,
      })
    }
    const result = await this.runInForeground(prepared, cwd, {
      timeoutMs: options.timeoutMs ?? DefaultCommandTimeoutMs,
      maxOutputChars: options.maxOutputChars ?? DefaultOutputChars,
      abortSignal,
    })
    return buildSystemCommandResult(command, cwd, startedAt, { ...result, ownership: prepared.ownership, shell: prepared.shell })
  }

  public listTasks(options: SystemBackgroundTaskQueryOptions = {}): SystemBackgroundTaskRecord[] {
    const tasks = [...this.tasks.values()].map((task) => ({
      ...task,
      status: this.resolveTaskStatus(task),
      updatedAt: Date.now(),
    }))
    const sessionIds = new Set(options.sessionIds ?? [])
    const filter = options.filter?.trim().toLowerCase()

    return tasks
      .sort((a, b) => b.startedAt - a.startedAt)
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

  public async terminateTask(request: SystemBackgroundTaskTerminateRequest): Promise<SystemBackgroundTaskTerminateResult> {
    const taskId = request.taskId.trim()
    if (!taskId) {
      throw new AppError('VALIDATION', '后台任务 id 不能为空。')
    }

    const task = this.tasks.get(taskId)
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
        if (this.options.platformTools.isProcessMissingError(error)) {
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

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.executions.values()].filter((entry) => !entry.exited).map((entry) => entry.stop('SIGKILL')))
  }

  /** 准备一条命令：选出经过自检的 shell（原生调用则按 argv 生成规格）→ 加进程约束 → Windows 上包进原生进程宿主。 */
  private async prepare(
    command: string,
    nativeCommand: LooseOptional<SystemRunCommandOptions['nativeCommand']>
  ): Promise<PreparedSystemCommand> {
    const { platform, platformTools, confinement, confinementProvider, shells } = this.options
    const shell = await shells.resolveReady({ platform, env: process.env })
    const commandSpec = nativeCommand ? buildSystemNativeCommandSpec(nativeCommand, shell)
      : { ...platformTools.getShellCommandSpec(command, shell), env: shell.env }
    const confined = buildSystemProcessConfinementSpawnSpec(
      { spec: commandSpec, policy: confinement },
      { platform, env: commandSpec.env, provider: confinementProvider, tempDir: tmpdir() }
    )
    const owned = buildSystemOwnedProcessSpec(confined.spec, { platform, env: commandSpec.env })
    return {
      spec: owned.spec,
      env: commandSpec.env,
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
    capture: SystemCommandOutputCapture
    confinement: SystemProcessConfinementEvidence
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
      const capture: SystemCommandOutputCapture = {
        status: result.cleanupIncomplete ? 'failed' : truncated ? 'truncated' : 'complete',
        encoding: 'utf-8', totalBytes, storedBytes, omittedBytes: Math.max(0, totalBytes - storedBytes),
        decodeErrors: decoders.stdout.decodeErrors + decoders.stderr.decodeErrors,
        error: optionalWhen(result.cleanupIncomplete, 'Process output drain did not complete before its deadline'),
      }
      return { ...result, ...output, confinement: prepared.evidence, truncated, capture }
    })
  }

  /** 后台启动：等进程确认拉起后登记成任务，持续记下最近的输出；进程收尾时把退出码写回任务。拉不起来就停掉并抛错。 */
  private async startInBackground(
    command: string,
    cwd: string,
    prepared: PreparedSystemCommand,
    sessionId: Optional<string>,
    startedAt: number,
    abortSignal?: AbortSignal
  ): Promise<SystemBackgroundProcessInfo> {
    const { platform, platformTools, processes } = this.options
    const taskId = randomUUID()
    const child = spawn(prepared.spec.file, prepared.spec.args, {
      cwd, detached: platformTools.shouldUseDetachedProcessGroup(),
      stdio: ['ignore', 'pipe', 'pipe'], env: prepared.env, windowsHide: true,
      windowsVerbatimArguments: prepared.spec.windowsVerbatimArguments,
    })
    const owned = processes.manage(child, { platform, abortSignal })
    let recentOutput = ''
    const decoders = { stdout: new SystemOutputDecoder(), stderr: new SystemOutputDecoder() }
    const append = (text: string): void => {
      recentOutput = appendBoundedOutput(recentOutput, text, BackgroundRecentOutputChars)
      const task = this.tasks.get(taskId)
      if (task) this.tasks.set(taskId, { ...task, recentOutput, updatedAt: Date.now() })
    }
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => append(decoders[stream].write(chunk)))
    try { await waitForSystemProcessSpawn(child); abortSignal?.throwIfAborted() } catch (error) {
      await owned.stop('SIGKILL')
      throw error
    }
    const pid = child.pid!
    const backgroundProcess: SystemBackgroundProcessInfo = {
      taskId, sessionId: toNullable(sessionId), pid, logPath: null, ports: [],
      reason: null, terminateCommand: platformTools.getTerminateCommand(pid, false, prepared.shell),
      forceTerminateCommand: platformTools.getTerminateCommand(pid, true, prepared.shell), fallbackTerminateCommand: null,
      requested: true, autoStarted: false,
    }
    const task: SystemBackgroundTaskRecord = {
      id: taskId, runId: taskId, sessionId: toNullable(sessionId), command,
      cwd, pid, logPath: null, ports: [], reason: null,
      terminateCommand: backgroundProcess.terminateCommand,
      forceTerminateCommand: backgroundProcess.forceTerminateCommand, fallbackTerminateCommand: null,
      requested: true, autoStarted: false, startedAt, updatedAt: startedAt,
      status: 'running', recentOutput: null,
    }
    this.tasks.set(taskId, task)
    this.executions.set(taskId, owned)
    void owned.completion.then((result) => {
      for (const stream of ['stdout', 'stderr'] as const) append(decoders[stream].end())
      this.tasks.set(taskId, { ...task, status: result.cleanupIncomplete ? 'unknown' : 'exited',
        recentOutput, exitCode: result.exitCode, signal: result.signal,
        cleanupIncomplete: result.cleanupIncomplete, finishedAt: Date.now(), updatedAt: Date.now() })
      this.pruneFinishedTasks()
    }).catch((error) => log.warn('后台进程完成记录失败', { taskId, error }))
    return backgroundProcess
  }

  /** 已结束的任务只留最近 MaxFinishedTasks 条：最早结束的先删，它们的进程句柄一起释放。 */
  private pruneFinishedTasks(): void {
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? a.updatedAt) - (b.finishedAt ?? b.updatedAt))
    for (const task of finished.slice(0, Math.max(0, finished.length - MaxFinishedTasks))) {
      this.tasks.delete(task.id)
      this.executions.delete(task.id)
    }
  }

  /** 后台任务此刻的状态：受管进程还在就看它是否退出、收尾是否完整；已经不在登记里时看任务有没有记下结束时间。 */
  private resolveTaskStatus(task: SystemBackgroundTaskRecord): SystemBackgroundTaskStatus {
    const owned = this.executions.get(task.id)
    if (!owned) return task.finishedAt ? 'exited' : 'unknown'
    return owned.result?.cleanupIncomplete ? 'unknown' : owned.exited ? 'exited' : 'running'
  }
}
