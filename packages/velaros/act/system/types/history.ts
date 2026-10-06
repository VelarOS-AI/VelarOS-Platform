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
 * 最新一卷（snapshot.volume）的叙事：summary 写这一段做了什么、查明了什么（1 到 3000 个字符）；evidence 是它直接依据的原文引用，序号不能晚于 snapshot.volume.through；更早的用户输入和记录可以作为背景依据；
 * unresolved 只列本卷新增且仍未解决的问题；已有事项由宿主持久保留，需要关闭时按 active 合同逐项提供证据。negativeAttempts 只写本卷失败的尝试。
 */
export interface VolumeNarrative {
  readonly summary: string
  readonly evidence: readonly ContextRef[]
  readonly unresolved: readonly string[]
  readonly negativeAttempts: readonly string[]
}
