import type { ContextRef } from '@velaros-ai/context'

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
/**
 * 一卷历史的叙事，由整理支线读过原文后写成。
 * @AgentView
 * 最新一卷（snapshot.volume）的叙事：summary 写这一段做了什么、查明了什么（1 到 3000 个字符）；evidence 是它直接依据的原文引用；
 * unresolved 是到这一卷为止仍没解决的全部事项（snapshot.ledgers.unresolved 里还没解决的照抄保留）；negativeAttempts 是这一段里试过但没成功的做法，以后别再重复（已在 snapshot.ledgers.negativeAttempts 里的不用重写）。
 */
export interface VolumeNarrative {
  readonly summary: string
  readonly evidence: readonly ContextRef[]
  readonly unresolved: readonly string[]
  readonly negativeAttempts: readonly string[]
}
