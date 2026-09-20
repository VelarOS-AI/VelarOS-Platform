import type { ModelInputEstimate, ModelTurnRequest } from '@velaros-ai/kernel'

import type { ProviderRequestSnapshot } from './context.js'

/** 核心循环的状态，由真实生命周期变化驱动。 */
export type FoundationRunStatus = 'thinking' | 'executing' | 'completed' | 'cancelled' | 'failed' | 'context_blocked'
/** 主干向宿主报告的事件。 */
export type FoundationRunEvent =
  | { readonly type: 'state'; readonly runId: string; readonly status: FoundationRunStatus }
  | { readonly type: 'text'; readonly runId: string; readonly text: string }
  | { readonly type: 'usage'; readonly runId: string; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'verification'; readonly runId: string; readonly completed: boolean; readonly verified: boolean; readonly reason: string }
  | { readonly type: 'error'; readonly runId: string; readonly message: string }
/** 明确而有界的运行预算。 */
export interface FoundationRunLimits {
  readonly turns: number
  readonly outputTokens: number
  readonly safetyTokens: number
  readonly projectionChars: number
  readonly recoveryChars: number
  readonly timeoutMs: number
}

/** 物化视图经过统一编译器之后的不可变请求与预算结论。 */
export interface CompiledFoundationRequest {
  readonly request: ModelTurnRequest
  readonly estimate: ModelInputEstimate
  readonly okToSend: boolean
  readonly providerRequest: ProviderRequestSnapshot
}
