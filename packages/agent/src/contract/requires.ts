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
  /** 本帧固定的协议说明及标记，计入实际请求预算。 */
  readonly instructions: string
  /** 清空接收状态，修复时保留同一帧的协议与参数快照。 */
  reset(): void
  /** 接收原始文本并返回正文或程序预览。 */
  push(text: string): readonly ActPreview[]
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
  invoke(input: unknown, signal: AbortSignal, acceptedTurnId: string): Promise<void | boolean>
}
/** 上下文策略独立于协议解码和执行调度。 */
export interface ActContextPort {
  /** 安全轮边界的独立整理口；不执行业务脚本、不消费业务租约。 */
  maintain?(
    input: { reason: 'boundary' | 'pressure' | 'provider'; targetChars: number },
    signal: AbortSignal
  ): Promise<boolean>
  /** 叶子模型工具进入直接交付阶段，不再创建整理支线。 */
  pressure?(): void
  /** 把段内较早的历史封成一卷、开始新的一段，不调用模型；能封的不足一个响应时返回 false。 */
  fold?(
    reason: 'runway' | 'boundary' | 'overflow' | 'provider',
    maxChars: number,
    signal: AbortSignal
  ): Promise<boolean>
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
  /** 完成前检查实际送达的运行时材料；返回拒绝原因时进入相应恢复路径。 */
  completion?(
    request: ModelTurnRequest,
    signal: AbortSignal
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
