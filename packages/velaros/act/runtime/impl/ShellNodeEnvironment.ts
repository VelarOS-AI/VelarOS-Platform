import type {
  NodeCodeRunnerOptions,
  NodeProcessRequest,
  NodeProcessResult,
} from '@velaros-ai/script'
import { NodeExecutionLimits } from '@velaros-ai/script'

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
    const result = await this.options.shell.runCommand(
      'Node.js',
      {
        cwd: request.cwd,
        sessionId: request.sessionId,
        stdin: request.source,
        // 本轮执行时钟由 Node runner 管理，在等待宿主交互时停表。
        timeoutMs: null,
        maxOutputChars: NodeExecutionLimits.previewChars,
        onOutput: (text) => {
          onOutput(text)
          if (request.sessionId && request.executionId)
            this.options.output?.({
              sessionId: request.sessionId,
              executionId: request.executionId,
              invocationId: `${request.executionId}:node`,
              text,
            })
        },
        nativeCommand: {
          file: this.options.executable ?? process.execPath,
          args: ['--input-type=module', '--max-old-space-size=512'],
          env: { ...this.options.environment, ...request.environment },
        },
      },
      false,
      signal
    )
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
