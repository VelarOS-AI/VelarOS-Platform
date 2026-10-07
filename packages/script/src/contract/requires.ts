/**
 * 注入面：宿主要塞进来的东西。
 *
 * 代码面本身不认识任何一件具体能力——它只负责「安全地跑一段程序，并把程序发出的调用转给宿主」。
 * 哪些能力存在、每一次调用要不要向用户要授权、危险不危险、算不算一次运行事件，全在宿主这一侧。
 */

import type { OperationRuntimeApi } from '@velaros-ai/kernel'

import type { NodeRuntimeEnvironment } from '../types/environment.js'
import type { CodeAttachment } from '../types/outcome.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'
import type { CodeCallNotice, ScriptPackageDefinition } from '../types/script.js'
import type { NodeProcessRequest, NodeProcessResult } from '../types/script.js'

/** 标准 Node 环境由宿主提供进程边界；必须沿用该工作区的审批、沙箱和进程树回收。 */
export interface NodeCodeRunnerOptions {
  /** 已授权的绝对工作目录，也是原生 ESM/npm 解析起点。 */
  readonly cwd: string
  /** 宿主持有的归档目录，进程只需读取其中的能力目录。 */
  readonly directory: string
  /** 默认 npm 环境的绝对根目录（含 node_modules）；省略时使用 Script 包的生产依赖。 */
  readonly packageDirectory?: string
  /** 当前会话锁定的 Skill 与标准依赖环境。 */
  readonly runtime?: NodeRuntimeEnvironment
  /** 每次执行固定新的依赖快照；优先于静态 runtime，进程树收束后释放。 */
  acquireRuntime?(signal: AbortSignal): Promise<NodeRuntimeLease>
  /** 在计时与启动前完成本次源码的宿主审批；拒绝时不得启动进程。 */
  authorize?(request: NodeProcessRequest, signal: AbortSignal): Promise<void>
  /** 启动真实 Node，将 source 作为 ESM 标准输入；signal 必须终止并回收进程树。 */
  execute(
    request: NodeProcessRequest,
    onOutput: (text: string) => void,
    signal: AbortSignal
  ): Promise<NodeProcessResult>
}

/** 宿主为一次 Node 执行及其后代持有的不可变环境。 */
export interface NodeRuntimeLease {
  /** 宿主无法证明进程树已收束时保留文件，防止重启回收仍在使用的依赖。 */
  retain?(): Promise<void>
  /** 本次执行的依赖和 Skill 目录。 */
  readonly environment: NodeRuntimeEnvironment
  /** 随快照固定的包命令目录。 */
  readonly binDirectories?: readonly string[]
  /** 进程树完全收束后释放，失败或未回收时保留保护。 */
  release(): Promise<void>
}

/** 同一 Kernel 上的一次脚本会话配置。 */
export interface KernelScriptSessionOptions {
  /** 宿主装配的虚拟包，声明与运行对象使用同一投影。 */
  readonly packages?: readonly ScriptPackageDefinition[]
  /** 由宿主设定，本次脚本不能通过参数改变执行权限。 */
  readonly mode?: 'execute' | 'observe'
  /** 持有统一注册、调用和日志的运行时。 */
  readonly runtime: OperationRuntimeApi
  /** 显式选择通过隔离验收的运行器。 */
  readonly runner: CodeRunnerApi
  /** 宿主签发的会话身份。 */
  readonly sessionId: string
  /** 本次程序身份，调用号由它派生。 */
  readonly executionId: string
  /** 宿主可显式收窄本次执行的能力范围；省略时使用挂载模块。 */
  readonly allowedModules?: readonly string[]
}

/** 程序发出的一次能力调用。 */
export interface CodeCapabilityCall {
  /** 命名空间，如 `system`。 */
  namespace: string
  /** 操作名，如 `read`。 */
  operation: string
  /** 入参；已经过隔离边界，是纯 JSON 值。 */
  input: unknown
}

/** 一次能力调用的结果。 */
export interface CodeCapabilityOutcome {
  /** 交回给程序的值；调用失败时不给这一格。 */
  value?: unknown
  /**
   * 调用失败（审批被拒、入参不合法、能力自己报错）。
   *
   * 它在程序里是一个**能 try/catch 的异常**，不是一份静默的空回执——
   * 模型可以接住它换条路走，也可以让它把整个程序带停。
   */
  error?: {
    /** 失败类别；能力自己定的码，代码面不解释它。程序里从 `error.code` 读得到。 */
    code: string
    /** 给模型看的一句话，说清为什么没做成、下一步能怎么办。 */
    message: string
  }
  /** 系统在这次调用上插手过的地方，随最终结果回给模型。 */
  notices?: readonly CodeCallNotice[]
  /** 这次调用交给模型看的图；不进 `value`，程序拿不到它们的像素。 */
  attachments?: readonly CodeAttachment[]
}

/**
 * 能力端口：代码面与真实能力之间唯一的通道。
 *
 * **审批、危险判定、权限、运行事件都在 `invoke` 里面撞。** 这是代码面能成立的前提：
 * 今天「危险命令硬门化」能成立，是因为一次工具调用就是一个可审查单元；
 * 代码块里几十条语句不是，所以门必须下沉到这里，而不是留在协议层。
 */
export interface CodeCapabilityPort {
  /**
   * 登记的能力清单：命名空间 → 操作名。
   * 模型读的声明按它生成，隔离进程里的 RPC 桩也按它造——两边同一个来源，不会对不上。
   */
  listOperations(): Readonly<Record<string, readonly string[]>>
  /**
   * 执行一次能力调用；`signal` 触发时尽快停下。
   *
   * 调用的时间不计进程序的墙钟：会话在调用开始时停表、落定时恢复，能力自己的时限（命令的 timeoutMs）与等用户点头都在这里面。
   * 程序停下（跑完、失败、超时、被中止）时还没落定的调用，会话会触发 `signal` 要它停下——做不到立刻停的，也该尽快收尾。
   */
  invoke(call: CodeCapabilityCall, signal?: AbortSignal): Promise<CodeCapabilityOutcome>
}

/** 程序跑起来之后陆续发生的事，宿主据此往界面上冒卡片与实时输出。 */
export interface CodeSurfaceEventSink {
  /** 程序发起了一次能力调用。 */
  callStarted?(call: CodeCapabilityCall & { callId: number }): void
  /** 那次调用有结果了。 */
  callSettled?(settled: { callId: number; ok: boolean; elapsedMs: number }): void
  /**
   * 程序打了一行日志。
   *
   * 界面要**实时**看见它（用户得知道程序跑到哪了）；模型那边不走这条路，
   * 日志随最终结果一起回——一次 tool_use 只能回一个 tool_result，中途没法单独成轮。
   */
  logged?(line: string): void
}

/**
 * 隔离运行器：会话要一个，装配时给。
 *
 * 执行器运行真实 Node.js；操作系统权限由宿主进程端口负责，应用能力通过会话授权桥访问。
 * 模型程序、检查和能力分发共用这一注入面，宿主仍须验证自己的部署隔离边界。
 */
export interface CodeRunnerApi {
  /** 当前执行器使用的工作目录，供宿主说明环境。 */
  readonly cwd?: string
  /** 标准 Node 语义；自定义测试执行器可省略。 */
  readonly environment?: 'node'
  /**
   * 在隔离环境里跑一段程序。
   *
   * Node 环境开放宿主批准的操作系统范围。
   * 源码通过进程通道传递；必须执行时限、取消和进程回收。
   */
  run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome>
}
