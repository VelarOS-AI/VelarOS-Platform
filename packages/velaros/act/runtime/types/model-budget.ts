import type { ModelDriver } from '@velaros-ai/model'

/** 子模型借用父任务的唯一预算账本。 */
export interface BudgetedModelOptions {
  /** 真实共享驱动。 */
  readonly model: ModelDriver
  /** 父任务预算权威。 */
  readonly parent: ModelBudgetPort
  /** 根任务持续有效的取消信号。 */
  readonly signal: AbortSignal
}

/** 模型调用预算端口；支线实现把同一次调用计入全部祖先总账。 */
export interface ModelBudgetPort {
  /** 实际派发前预留一次调用及 token。 */
  reserveModel(role: 'main' | 'context', tokens: number, requestId?: string): Promise<void>
  /** 正式宿主提供逐请求派发确认；旧聚合适配器保留保守行为。 */
  dispatchModel?(requestId: string): Promise<void>
  /** 把收尾占位原子转交给实际请求；所有祖先沿用同一派发身份。 */
  transferModelReservation?(reservationId: string, requestId: string): Promise<void>
  /** 仅归还确认尚未派发的预留。 */
  releaseModel(
    role: 'main' | 'context',
    tokens: number,
    requestId?: string,
    confirmedNotDispatched?: boolean
  ): Promise<void>
  /** 记录供应商返回的一次真实用量。 */
  recordUsage(inputTokens: number, outputTokens: number, requestId?: string): Promise<void>
}

/** 供应商实际用量先持久化，再幂等结算到每个原任务；重启可补齐部分失败。 */
export interface ModelBudgetSettlement {
  readonly requestId: string
  readonly rootSessionId: string
  readonly rootTaskId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly targets: ReadonlyArray<{ readonly sessionId: string; readonly taskId: string }>
  readonly status: 'pending' | 'settled' | 'archived'
}
