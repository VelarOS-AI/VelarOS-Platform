/**
 * 注入面：宿主要塞进来的东西。
 *
 * 代码面本身不认识任何一件具体能力——它只负责「安全地跑一段程序，并把程序发出的调用转给宿主」。
 * 哪些能力存在、每一次调用要不要向用户要授权、危险不危险、算不算一次运行事件，全在宿主这一侧。
 */

import type { ScopeRef } from '@velaros-ai/kernel/contracts'

import type { CodeProgramGateApi } from '../impl/CodeProgramGate.js'
import type { CodeAttachment, CodeCallNotice, MountedCapabilityModule } from '../types/code-surface.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'

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
 * 一次能力调用要改哪些本机文件：能力在动手之前报给代码面，时间线据此在改前、改后各记一次内容哈希。
 * 系统空间没法给整个磁盘打标记，经 `velar:files` 改的文件只能这样记；项目空间有整棵树的标记，用不着它。
 */
export interface CodeCallFileWatch {
  /** 这次调用接下来要改（写、删）这些文件（绝对路径）；等它记下改前的样子再动手。 */
  touching(paths: readonly string[]): Promise<void>
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
   * 执行一次能力调用；`signal` 触发时尽快停下；`watch` 给了，能力改本机文件之前经它报出路径（见 `CapabilityOperationContext.touching`）。
   *
   * 调用的时间不计进程序的墙钟：会话在调用开始时停表、落定时恢复，能力自己的时限（命令的 timeoutMs）与等用户点头都在这里面。
   * 程序停下（跑完、失败、超时、被中止）时还没落定的调用，会话会触发 `signal` 要它停下——做不到立刻停的，也该尽快收尾。
   */
  invoke(call: CodeCapabilityCall, signal?: AbortSignal, watch?: CodeCallFileWatch): Promise<CodeCapabilityOutcome>
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
 * 抽成注入面是因为隔离方案会换——今天这个 `node --permission` 子进程挡得住文件系统与起子进程，
 * 挡不住网络（Node 的权限模型不覆盖 socket），只能开发期用；正式版换 WASM 里的 QuickJS。
 * 两边模型写的程序、检查、能力分发完全相同，换的只是这一层。
 */
export interface CodeRunnerApi {
  /**
   * 在隔离环境里跑一段程序。
   *
   * 实现必须保证三件事：程序拿不到宿主的任何环境能力；到 `timeoutMs` 一定停；
   * `signal` 触发时尽快停。程序**不落盘**——源码经通道送进去，落盘等于凭空多一个可读文件。
   */
  run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome>
}

/**
 * 这个空间的时间线放在哪、给哪个目录打标记。
 *
 * 时间线记下每一次调用、每一步的代码、参数与结果，脚本库也在里面；它只存这些操作和哈希，不存工作区文件的内容。
 * 同一个目录只该由一个宿主进程写：调用号在进程里分配。
 */
export interface CodeSurfaceTimelinePort {
  /** 时间线的目录：应用数据目录下给这个空间的一个目录（每个项目一份），没有就建。跨会话、跨重启都在。 */
  directory: string
  /**
   * 要打标记的工作区根目录（绝对路径）：每一步前后给它算一个哈希标记，记下这一步改了哪些文件。
   * 项目空间给项目根；系统空间不给——整个磁盘打不了标记，那里只记操作。
   */
  workspace?: string
  /** 时间线最多存多少字节（代码、参数、结果、目录节点）；超了从最旧的调用清起。不给用缺省（500 MB）。 */
  retainBytes?: number
}

/** 这一次调用所在的空间交给门的东西。 */
export interface CodeSurfaceSpacePort {
  /** 这个空间挂的能力（空间的 `modules`）：常驻的声明一直给检查器，其余 import 了才给。 */
  modules: readonly MountedCapabilityModule[]
  /** 这个空间的能力端口，按这一次调用装好（审批通道、取消信号、会话都是这一次的），如 `createCapabilityPort(space.operations)`。 */
  capabilities: CodeCapabilityPort
  /** 这个空间的时间线：放在哪、给哪个目录打标记。 */
  timeline: CodeSurfaceTimelinePort
}

/** 门的工具（`script:exec` 等四个）每次被调用时宿主给的上下文。 */
export interface CodeSurfaceToolContext {
  /** 本次调用的取消信号：用户停下这一轮时触发，程序与它发出的调用都要停。 */
  abortSignal: AbortSignal
  /**
   * 会话身份：门按它记导入过的模块，时间线按它标出每次调用是哪个会话的。会话切了分支、回到检查点时，宿主把分支与检查点一起拼进来，
   * 两条分支的导入就不串；子 Agent 与父会话同一个 sessionId 时也要区分开，或者不给子 Agent 开这扇门。
   */
  sessionId: string
  /** 门：宿主进程里装一个（`createCodeProgramGate`），所有会话共用；会话结束、转交新会话时宿主调它的 `forget`。 */
  gate: CodeProgramGateApi
  /** 这一次调用所在的空间。 */
  space: CodeSurfaceSpacePort
  /** 模型收哪些输入形态（`text`、`image`……）；不收图时程序交出的图不放进回执，只说一声。不给当收。 */
  getSupportedModelInputModalities?: () => readonly string[]
  /** 界面要实时看见的事（程序发起、结束的调用，打的日志）；模型那边不走这条路。 */
  events?: CodeSurfaceEventSink
}

/** 内核按工具名调用时，宿主用它把作用域换成一份门的上下文。 */
export type CodeSurfaceToolContextResolver = (
  scope: LooseOptional<ScopeRef>,
  signal: AbortSignal,
) => CodeSurfaceToolContext | Promise<CodeSurfaceToolContext>

/** 建门的内核模块时的选项。 */
export interface CreateCodeSurfaceKernelModuleOptions {
  /** 宿主自己的、绑定了作用域的上下文解析器；不给就只登记工具目录，不支持按名调用。 */
  resolveContext?: CodeSurfaceToolContextResolver
}
