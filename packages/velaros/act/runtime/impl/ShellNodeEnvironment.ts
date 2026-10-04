import { delimiter, dirname } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import type {
  NodeCodeRunnerOptions,
  NodeProcessRequest,
  NodeProcessResult,
} from '@velaros-ai/script'
import { NodeEnvironmentVariables, nodeExecutable, NodeExecutionLimits } from '@velaros-ai/script'

import type { ShellRunCommandHooks } from '../../../shell/contract/requires.js'
import type { ShellRunCommandOptions } from '../../../shell/types/shell-command.js'
import type { ShellNodeEnvironmentOptions } from '../contract/requires.js'

/** 经工作区命令宿主运行标准 Node 的适配器。 */
export interface ShellNodeEnvironmentApi {
  /** 标准进程的工作目录。 */
  readonly cwd: string
  /** 本次执行的归档父目录。 */
  readonly directory: string
  /** 宿主在进程计时开始前审批。 */
  readonly authorize: NodeCodeRunnerOptions['authorize']
  /** 经命令宿主派发并等待完整的进程收束。 */
  execute(
    request: NodeProcessRequest,
    onOutput: (text: string) => void,
    signal: AbortSignal
  ): Promise<NodeProcessResult>
}

/** 复用 Shell 的沙箱、环境、取消与进程树回收。 */
class ShellNodeEnvironment implements ShellNodeEnvironmentApi {
  public readonly cwd: string
  public readonly directory: string
  public readonly authorize: NodeCodeRunnerOptions['authorize']

  public constructor(private readonly options: ShellNodeEnvironmentOptions) {
    this.cwd = options.cwd
    this.directory = options.directory
    this.authorize = options.authorize
  }

  public async execute(
    request: NodeProcessRequest,
    onOutput: (text: string) => void,
    signal: AbortSignal
  ): Promise<NodeProcessResult> {
    signal.throwIfAborted()
    const shell = request.language === 'shell'
    const executable = this.options.executable ?? nodeExecutable.resolve()
    if (!executable) throw new AppError('UNAVAILABLE', '宿主需要提供 Node.js 执行文件')
    const environment = { ...this.options.environment, ...request.environment }
    environment.PATH = [dirname(executable), environment.PATH ?? process.env.PATH]
      .filter(Boolean)
      .join(delimiter)
    if (request.preload)
      environment.NODE_OPTIONS =
        `${environment.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(request.preload)}`.trim()
    const command = shell ? request.source : 'Node.js'
    const options: ShellRunCommandOptions & ShellRunCommandHooks = {
      cwd: request.cwd,
      sessionId: request.sessionId,
      stdin: shell || request.entrypoint ? undefined : (request.bootstrap ?? request.source),
      timeoutMs: null,
      maxOutputChars: NodeExecutionLimits.previewChars,
      environment,
      ipcSocket: request.environment[NodeEnvironmentVariables.socket.name],
      outputFile: request.environment[NodeEnvironmentVariables.output.name],
      onOutput: (text) => {
        onOutput(text)
        if (request.sessionId && request.executionId)
          this.options.output?.({
            sessionId: request.sessionId,
            executionId: request.executionId,
            invocationId: `${request.executionId}:${shell ? 'shell' : 'node'}`,
            text,
          })
      },
      nativeCommand: shell
        ? undefined
        : {
            file: executable!,
            args: [
              '--max-old-space-size=512',
              ...(request.entrypoint ? [request.entrypoint] : ['--input-type=module']),
            ],
          },
    }
    if (request.mode === 'observe' && !this.options.shell.runObservationCommand)
      throw new AppError('UNAVAILABLE', '宿主没有提供只读进程执行口')
    const result =
      request.mode === 'observe'
        ? await this.options.shell.runObservationCommand!(command, options, signal)
        : await this.options.shell.runCommand(command, options, false, signal)
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      aborted: result.aborted,
      timedOut: result.timedOut,
      cleanupIncomplete: result.cleanupIncomplete,
      truncated: result.truncated,
      confinement: result.confinement,
    }
  }
}

/** 标准编程环境沿用宿主已经批准的 Shell 执行边界。 */
export function createShellNodeEnvironment(
  options: ShellNodeEnvironmentOptions
): ShellNodeEnvironmentApi {
  return new ShellNodeEnvironment(options)
}
