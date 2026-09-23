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
  reserveModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 仅归还确认尚未派发的预留。 */
  releaseModel(role: 'main' | 'context', tokens: number): Promise<void>
  /** 记录供应商返回的一次真实用量。 */
  recordUsage(inputTokens: number, outputTokens: number): Promise<void>
}
