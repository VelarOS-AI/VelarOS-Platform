/**
 * 会话壳原子包含 `ChatConversationPane`、`ChatTranscript`、`ChatScrollNavigator`，以及派生钩子、
 * 交互状态与索引工具、翻页哨兵、动画帧调度、工作线程时间轴和动作注入端口。
 *
 * 门面只导出宿主消费所需的会话壳组件、动作端口、活动状态钩子和工作线程时间轴。转录模型、窗口、
 * 滚动和等待状态等面板私有钩子属于 `ChatConversationPane` 实现细节，只允许包内相对导入。
 */
export type { ChatConversationPaneProps } from './ChatConversationPane'
export { ChatConversationPane } from './ChatConversationPane'
export { ChatScrollNavigator } from './ChatScrollNavigator'
export {
  ChatScrollNavigatorVisibilityToggle,
  type ChatScrollNavigatorVisibilityToggleProps,
} from './ChatScrollNavigatorVisibilityToggle'
export type { ChatTranscriptNavigationHandle, ChatTranscriptProps } from './ChatTranscript'
export { ChatTranscript } from './ChatTranscript'
export type {
  ConversationActionPort,
  ConversationGoalLifecycleResult,
} from './conversationActionPort'
export {
  ConversationActionPortProvider,
  emptyConversationActionPort,
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
