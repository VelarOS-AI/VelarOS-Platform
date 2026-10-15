import { delimiter, dirname, join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import type {
  NodeCodeRunnerOptions,
  NodeProcessRequest,
  NodeProcessResult,
} from '@velaros-ai/script'
import { NodeEnvironmentVariables, nodeExecutable, NodeExecutionLimits } from '@velaros-ai/script'

import type { NpmClientApi } from '../../../execution/contract/provides.js'
import type { ShellRunCommandHooks } from '../../../execution/contract/requires.js'
import { createNpmClient } from '../../../execution/local.js'
import type { ShellRunCommandOptions } from '../../../execution/types/shell-command.js'
import type { NodeExecutionEnvironmentOptions } from '../contract/requires.js'

/** 标准 Node 执行适配器，统一接入进程权限、环境与回收。 */
export interface NodeExecutionEnvironmentApi {
  /** npm 安装查询沿用同一宿主执行策略。 */
  readonly npm?: NpmClientApi
  /** 标准进程的工作目录。 */
  readonly cwd: string
  /** 本次执行的归档父目录。 */
  readonly directory: string
  /** 独立 Node 可读取的默认 npm 依赖根目录。 */
  readonly packageDirectory?: string
  /** 会话使用的不可变依赖环境。 */
  readonly runtime?: NodeCodeRunnerOptions['runtime']
  /** 宿主在进程计时开始前审批。 */
  readonly authorize: NodeCodeRunnerOptions['authorize']
  /** 经命令宿主派发并等待完整的进程收束。 */
  execute(
    request: NodeProcessRequest,
    onOutput: (text: string, stream?: 'stdout' | 'stderr' | 'combined') => void,
    signal: AbortSignal
  ): Promise<NodeProcessResult>
}

/** 使用统一执行宿主管理沙箱、环境、取消与进程树。 */
class NodeExecutionEnvironment implements NodeExecutionEnvironmentApi {
  public readonly npm?: NpmClientApi
  public readonly cwd: string
  public readonly directory: string
  public readonly packageDirectory?: string
  public readonly runtime?: NodeCodeRunnerOptions['runtime']
  public readonly authorize: NodeCodeRunnerOptions['authorize']

  public constructor(private readonly options: NodeExecutionEnvironmentOptions) {
    this.cwd = options.cwd
    this.directory = options.directory
    this.packageDirectory = options.packageDirectory
    this.runtime = options.runtime
    this.authorize = options.authorize
    const executable = options.executable ?? nodeExecutable.resolve()
    if (executable)
      this.npm = createNpmClient({
        executable,
        npmCli: options.npmCli,
        cacheDirectory: options.npmCacheDirectory ?? join(options.directory, 'npm-cache'),
        host: options.host,
        environment: options.environment,
      })
  }

  public async execute(
    request: NodeProcessRequest,
    onOutput: (text: string, stream?: 'stdout' | 'stderr' | 'combined') => void,
    signal: AbortSignal
  ): Promise<NodeProcessResult> {
    signal.throwIfAborted()
    const executable = this.options.executable ?? nodeExecutable.resolve()
    if (!executable) throw new AppError('UNAVAILABLE', '宿主需要提供 Node.js 执行文件')
    const environment = { ...this.options.environment, ...request.environment }
    environment.PATH = [
      dirname(executable),
      ...(request.binDirectories ?? []),
      environment.PATH ?? process.env.PATH,
    ]
      .filter(Boolean)
      .join(delimiter)
    if (request.preload)
      environment.NODE_OPTIONS =
        `${environment.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? ''} --import ${JSON.stringify(request.preload)}`.trim()
    const command = 'Node.js'
    const options: ShellRunCommandOptions & ShellRunCommandHooks = {
      cwd: request.cwd,
      sessionId: request.sessionId,
      stdin: request.entrypoint ? undefined : (request.bootstrap ?? request.source),
      timeoutMs: null,
      maxOutputChars: NodeExecutionLimits.previewChars,
      environment,
      ipcSocket: request.environment[NodeEnvironmentVariables.socket.name],
      outputFile: request.environment[NodeEnvironmentVariables.output.name],
      onOutput: (text, stream) => {
        onOutput(text, stream)
        if (request.sessionId && request.executionId)
          this.options.output?.({
            sessionId: request.sessionId,
            executionId: request.executionId,
            invocationId: `${request.executionId}:exec`,
            text,
            stream,
          })
      },
      nativeCommand: {
        file: executable!,
        args: [
          '--max-old-space-size=512',
          ...(request.entrypoint ? [request.entrypoint] : ['--input-type=module']),
        ],
      },
    }
    if (request.mode === 'observe' && !this.options.host.runObservationCommand)
      throw new AppError('UNAVAILABLE', '宿主没有提供只读进程执行口')
    const result =
      request.mode === 'observe'
        ? await this.options.host.runObservationCommand!(command, options, signal)
        : await this.options.host.runCommand(command, options, false, signal)
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

/** 创建标准 Node 执行环境，权限范围由宿主批准。 */
export function createNodeExecutionEnvironment(
  options: NodeExecutionEnvironmentOptions
): NodeExecutionEnvironmentApi {
  return new NodeExecutionEnvironment(options)
}
