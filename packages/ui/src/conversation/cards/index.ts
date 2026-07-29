/**
 * cards 原子——会话卡片渲染件（通知 / 确认 / 等待输入 / 骨架 / 文件变更汇总 / user-action 卡 + ask
 * 轮播）+ 其纯呈现层与随迁叶子件。viewmodel 有状态半壁留宿主，本层只吃投影（`view: UserActionCardView`）。
 */
export { AskUserCarousel } from './AskUserCarousel'
export { ChatAwaitingInputCard } from './ChatAwaitingInputCard'
export { ChatConfirmationCard } from './ChatConfirmationCard'
export { ChatConversationSkeleton } from './ChatConversationSkeleton'
export { ChatNoticeCard } from './ChatNoticeCard'
export * from './fileChangeDiff'
export { FileChangeSummaryList, type FileChangeSummaryListEntry } from './FileChangeSummaryList'
export { UserActionCard } from './UserActionCard'
export * from './userActionCardPresentation'
export type { UseSuggestionCardRejectionResult } from './useSuggestionCardRejection'
export { useSuggestionCardRejection } from './useSuggestionCardRejection'
