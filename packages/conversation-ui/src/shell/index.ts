/**
 * shell 原子（pass-4 収口）——会话壳三件（`ChatConversationPane` / `ChatTranscript` / `ChatScrollNavigator`）
 * + 其派生 hook（transcript 模型 / 窗口 / 滚动 / live-status / awaiting-confirmation）+ 纯 util（交互状态 /
 * 派生索引 / 翻页哨兵 / rafSchedule / worker 线程时间轴）+ 动作注入端口 `ConversationActionPort`。
 *
 * 门面收口：只导出宿主消费点需要的符号（会话壳三件 + 动作端口 + live-status hook + worker 线程时间轴）；
 * 4 个 pane 私有 hook（transcript 模型 / 窗口 / 滚动 / awaiting）是 ChatConversationPane 的实现细节，
 * 仅包内相对 import，不进门面。
 */
export type { ChatConversationPaneProps } from './ChatConversationPane'
export { ChatConversationPane } from './ChatConversationPane'
export { ChatScrollNavigator } from './ChatScrollNavigator'
export type { ChatTranscriptNavigationHandle, ChatTranscriptProps } from './ChatTranscript'
export { ChatTranscript } from './ChatTranscript'
export type {
  ConversationActionPort,
  ConversationGoalLifecycleResult,
} from './conversationActionPort'
export {
  ConversationActionPortProvider,
  useConversationActionPort,
} from './conversationActionPort'
export { useQueuedLiveStatusText } from './useQueuedLiveStatusText'
export type { WorkerThreadTranscriptPlacement } from './workerThreadTimeline.pure'
export {
  findWorkerThreadReplacementForDispatchPlaceholder,
  groupWorkerThreadsByTranscriptAnchor,
  listWorkerThreadsForTranscriptStage,
  listWorkerThreadsFromTranscriptPlacement,
} from './workerThreadTimeline.pure'
