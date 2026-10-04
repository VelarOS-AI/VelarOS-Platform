import type {
  ContextCompletionPort,
  ContextCompletionResult,
  ContextRuntime,
  ContextStorage,
  ContextViewApi,
  ModelView,
} from '@velaros-ai/context'
import type {
  ModelDriver,
  ModelHistoryMessage,
  ModelImage,
  ModelResponseFormat,
  ModelToolCall,
  ModelToolResult,
  ModelTurnRequest,
} from '@velaros-ai/kernel'

import type {
  ActContextPolicy,
  ActDecodedTurn,
  ActFrameSegment,
  ActPreview,
  ActRunLimits,
} from '../types/act.js'

/** 一帧固定协议的增量接收器，校验失败时不授权执行。 */
export interface ActTurnDecoder {
  /** 本帧在供应商侧声明的传输格式；缺省使用文本。 */
  readonly response?: ModelResponseFormat
  /** 本帧固定的协议说明及标记，计入实际请求预算。 */
  readonly instructions: string
  /** 清空接收状态，修复时保留同一帧的协议与参数快照。 */
  reset(): void
  /** 接收原始文本并返回正文或程序预览。 */
  push(text: string): readonly ActPreview[]
  /** 完整参数只生成预览；finish 接受整份响应后主循环才会执行。 */
  acceptTool?(call: ModelToolCall): readonly ActPreview[]
  /** 正常生成结束后校验所有段并生成控制意图。 */
  finish(): ActDecodedTurn
}

/** 核心循环对外部执行只持有一个入口，不解释领域操作。 */
export interface ActExecutionPort {
  /** 是否仍有本任务的后台程序。 */
  pending(): boolean
  /** 等待实际后台进展，不通过模型轮询。 */
  wait(signal: AbortSignal): Promise<void>
  /** 取消并收束本次任务尚未结束的程序。 */
  stop(): Promise<void>
  /** 执行并记录回执；acceptedTurnId 由宿主绑定到已持久化的响应。 */
  invoke(
    input: unknown,
    signal: AbortSignal,
    acceptedTurnId: string,
    calls?: readonly ModelToolCall[]
  ): Promise<void | boolean | { succeeded: boolean; results: readonly ModelToolResult[] }>
}
/** 上下文策略独立于协议解码和执行调度。 */
export interface ActContextPort {
  /** 专项原生工具的最终产物已受理；成功执行后可进入普通完成核查。缺省仍由模型声明完成。 */
  deliveryReady?(): boolean
  /** 安全轮边界的独立整理口；不执行业务脚本、不消费业务租约。 */
  maintain?(
    input: { reason: 'boundary' | 'pressure' | 'provider'; targetChars: number },
    signal: AbortSignal
  ): Promise<boolean>
  /** 叶子模型工具进入直接交付阶段，不再创建整理支线。 */
  pressure?(): void
  /**
   * 容量不足时先于封段调用：把租约已结束、仍在段内历史里的结果正文退成引用卡，不封卷、不算封段抖动；
   * 请求前缀从第一处改写起失效。没有可退的正文时返回 false。
   */
  retire?(signal: AbortSignal): Promise<boolean>
  /** 把段内较早的历史封成一卷、开始新的一段，不调用模型；能封的不足一个响应时返回 false。 */
  fold?(
    reason: 'runway' | 'boundary' | 'overflow' | 'provider' | 'renew',
    maxChars: number,
    signal: AbortSignal
  ): Promise<boolean>
  /** 主线续跑：到达回合或墙钟上限时封段并延长运行截止时间；缺省时上限到了就结束运行。 */
  renew?(maxChars: number, signal: AbortSignal): Promise<void>
  /** 是否处在章节边界：有待处理的整理请求、段内来了新的用户输入，或计划的下一目标变了。 */
  boundary?(signal: AbortSignal): Promise<boolean>
  /** 实际上下文生成模式。 */
  readonly mode: 'partitioned' | 'runtime-view' | 'incremental-history'
  /** 当前模式的容量管理策略。 */
  readonly policy?: ActContextPolicy
  /** 最终帧的阶段交给能力门，维护轮不派发外部业务。 */
  setPhase(phase: 'work' | 'maintenance' | 'finalizing'): void
  /** 当前单次模型调用的绝对截止时间。 */
  deadline?(): number
  /** 每次模型请求前给出阶段和控制提醒。 */
  phase?(): { phase: 'work' | 'maintenance' | 'finalizing'; instructions: string }
  /** 运行结束后的租约生命周期。 */
  end?(status: Optional<string>): Promise<void>
  /** 每个新业务回合运行稳定观察。 */
  prepare(signal: AbortSignal): Promise<void>
  /** 本轮仍有可见租约的执行身份。 */
  visibleExecutions(): Promise<readonly string[]>
  /** 根据观察输出、租约和必要事实装配下一轮上下文。 */
  project(
    view: ModelView,
    signal: AbortSignal,
    maxChars: number
  ): Promise<{
    body: string
    images: readonly ModelImage[]
    prompt?: string
    history?: readonly ModelHistoryMessage[]
    /** 分段投影时的段状态。 */
    segment?: ActFrameSegment
  }>
  /**
   * 渲染本帧相对上一帧的变化，未列出的沿用上一帧。提供时循环把已发送的帧留在历史里、
   * 在暂态开销阈值内只在其后追加，供应商可复用完整前缀缓存；重建时核对实际正文覆盖。
   * 缺省时每帧完整重发。
   */
  delta?(body: string, previous: string): string
  /** 按本次实际选择的历史核对正文覆盖；不改变逻辑历史，容量重组时重新核对。 */
  reconcile?(
    body: string,
    history: readonly ModelHistoryMessage[],
    previous: Optional<string>,
    signal: AbortSignal
  ): Promise<{ body: string; prompt: string }>
  /**
   * 完成前检查实际送达的运行时材料；返回拒绝原因时进入相应恢复路径。
   * `claim` 是本轮 done 声明附带的完成依据，没有附带时缺席。
   */
  completion?(
    request: ModelTurnRequest,
    signal: AbortSignal,
    claim?: string
  ): Promise<Optional<ContextCompletionResult>>
  /** 完成前检查是否有本帧尚未展示的新结果或任务变化。 */
  needsRefresh(request: ModelTurnRequest): Promise<boolean>
  /** 成功接收完整模型响应后消费一次帧租约。 */
  acknowledge(request: ModelTurnRequest, signal: AbortSignal): Promise<void>
}
/** 每帧协议独立于执行和上下文。 */
export interface ActProtocolPort {
  /** 为当前帧冻结标记、参数与协议说明。 */
  open(): ActTurnDecoder
}
/** 主干循环由 Velaros 统一装配。 */
export interface ActLoopOptions {
  /** 协议解析独立端口。 */
  readonly protocol: ActProtocolPort
  /** 运行管理器注入的轮边界控制。 */
  readonly control?: ActLoopControl

  /** 任务事实、未知效果与领域验收由现有视图维护。 */
  readonly view: ContextViewApi
  /** 领域的真实完成校验。 */
  readonly completionVerifier?: ContextCompletionPort

  /** 会话的唯一上下文权威。 */
  readonly context: ContextRuntime
  /** 中立模型驱动。 */
  readonly model: ModelDriver
  /** 已装配的统一调用入口。 */
  readonly execution: ActExecutionPort
  /** 按运行模式装配的上下文策略。 */
  readonly frames: ActContextPort
  /** 宿主固定的基础指令，不受模型工作集替换影响。 */
  readonly instructions: string
  /** 运行、输出与维护预算。 */
  readonly limits: ActRunLimits
}

/** 运行服务在轮边界递交已归档输入，暂停在途模型但不重放脚本。 */
export interface ActLoopControl {
  /** 当前运行身份。 */
  readonly runId: string
  /** 当前轮前归并输入。 */
  beforeTurn(signal: AbortSignal): Promise<void>
  /** 请求已持久化时确认本次准备包含的输入，回执绑定该请求身份。 */
  applied?(turnId: string, signal: AbortSignal): Promise<void>
  /** 当前轮模型流的抢占信号。 */
  turnSignal(): AbortSignal
  /** 检查是否有尚未进入本轮的新用户输入。 */
  pending(): boolean
}
/** 宿主配置统一运行服务。 */
export interface ActRunServiceOptions extends Omit<ActLoopOptions, 'control'> {
  /** 与用户输入和操作回执共用的持久对象存储。 */
  readonly storage: ContextStorage
  /** 与材料存储一致的会话身份。 */
  readonly sessionId: string
}

import type { ActRunServiceApi } from '../impl/ActRunService.js'
import type { AgentJob, AgentStart, ModelToolDelivery } from '../types/delegation.js'
/** 子任务复用相同的 Act 运行服务。 */
export interface ActChildSession extends Pick<
  ActRunServiceApi,
  'submit' | 'steer' | 'answer' | 'cancel' | 'close'
> {}
/** 调度器仅处理运行权，装配层提供受权限和预算约束的同一会话工厂。 */
export interface AgentSupervisorOptions {
  /** Runtime 把已经落盘的子任务结果发布为统一交付。 */
  deliver?(job: AgentJob, payload: { sessionId: string; id: string }): Promise<ModelToolDelivery>
  /** 原文、事件和子任务状态共用存储。 */
  readonly storage: ContextStorage
  /** 同时活动的最大子运行数。 */
  readonly concurrency: number
  /** 一个父逻辑任务允许创建的子会话累计上限，重启和继续不能重置；显式新任务重新计数。 */
  readonly maxChildren: number
  /** 创建统一的 Act 会话，材料需要先验证所属范围。 */
  open(job: AgentJob, request: Optional<AgentStart>, signal: AbortSignal): Promise<ActChildSession>
}
