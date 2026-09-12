/**
 * 投影层（§8）——会话渲染门面与宿主权威状态之间的**类型契约边界**。
 *
 * 包件只消费这些投影（viewmodel hook 输出形状 / 渲染切片），从不 reach 宿主 chatStore / rendererIpc /
 * 运行态模型。desktop 在边界处提供 `toConversation*` 装配器把权威源映射成投影；WS2 会话权威搬迁后换
 * 权威源接口，只动 desktop 边界映射，本层不动。
 */
export type {
  ConversationRewindFilePlan,
  ConversationRewindPlan,
} from './conversationRewindPlan'
export type {
  ConversationMessageRunMarker,
  ConversationRunMarkerStatus,
  ConversationRunMarkerTurnKind,
  ConversationRunMarkerView,
  ConversationTurnContextView,
} from './conversationRunMarkerView'
export type {
  ConversationCardItem,
  ConversationRuntimeView,
  ConversationStickyDockItem,
} from './conversationRuntimeView'
export type {
  ConversationRunUsage,
  ConversationRunUsageBucket,
  ConversationRunUsageOrigin,
  ConversationRunUsagePricing,
  ConversationSubAgentRunUsage,
} from './conversationRunUsage'
export type { ConversationView } from './conversationView'
export type { ConversationWorkerThread } from './conversationWorkerThread'
export type {
  ConversationActionItem,
  ConversationMessageActionRow,
  MessageActionView,
} from './messageActionView'
export type {
  SystemToolInstallSuggestionStatus,
  SystemToolInstallSuggestionView,
} from './systemToolInstallSuggestionView'
export type {
  FormDraftValue,
  FormDraftValues,
  FormErrors,
  UserActionCardTimeoutHandlers,
  UserActionCardView,
  UserActionEntry,
  UserActionResolution,
} from './userActionCardView'
