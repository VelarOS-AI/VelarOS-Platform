import type { ContextRecord } from '@velaros-ai/context'

/** 只属于一次页读取；不跨页复用状态、授权结果或缺失事实。 */
export interface TraceReadState {
  readonly records: ReadonlyMap<string, ContextRecord>
  readonly bodies: Map<string, Nullable<string>>
  bodyChars: number
  yieldedAt: number
}
