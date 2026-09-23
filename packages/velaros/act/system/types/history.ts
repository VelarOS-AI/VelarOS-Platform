import type { ContextRef } from '@velaros-ai/context'

/**
 * 旧历史区间的有来源摘要，近期执行单元由 Runtime 保留。
 * @AgentView
 * 较早历史的一段摘要：baseThrough 到 through 是这一段的序号范围，through 必须是已完成脚本结果的 sequence，并留下最近两个响应不收进来；
 * evidence 是它直接依据的原文引用，unresolved 是没解决的事项，negativeAttempts 是试过但没成功的做法。
 */
export interface HistoryCheckpoint {
  readonly baseThrough: number
  readonly through: number
  readonly summary: string
  readonly evidence: readonly ContextRef[]
  readonly unresolved: readonly string[]
  readonly negativeAttempts: readonly string[]
}
/** 搜索历史目录的有界序号范围；through 可固定跨页上界。 */
export interface HistoryListRequest {
  readonly after?: number
  readonly through?: number
  readonly limit?: number
}
/** 只含当前授权代次的历史元数据，正文通过原始引用读取。 */
export interface HistoryPage {
  readonly items: ReadonlyArray<{
    readonly ref: ContextRef
    readonly sequence: number
    readonly kind: 'assistant' | 'result'
    readonly totalChars: number
  }>
  readonly resetAfter: number
  readonly through: number
  readonly nextAfter: Nullable<number>
}
