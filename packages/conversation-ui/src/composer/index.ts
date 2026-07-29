/**
 * `@velaros-ai/conversation-ui/composer` — 会话输入框第五原子（pass-5 renderer 収官战役収尾）。
 *
 * 聊天页最后一块渲染件入包：输入框 / 附件槽 / 发送控件 / 队列草稿 UI / 模型·推理选择 / 「+」菜单 /
 * skill·评论·下一步补全菜单 / 语音输入。数据 + 会话层回调经 `ChatComposerControl` 投影穿过（主注入面），
 * 环境 IPC 能力（本地语音三件 / 云特性 / 提示 toast）经 `ConversationComposerPort` 注入。宿主只保留
 * 草稿队列提交 wiring（`useChatPageComposerSurface` 深耦合 chatStore + IPC）+ 端口/插槽实现胶水。
 *
 * 第二消费者：`ScheduledTaskComposerDialog` 复用本包的输入框零件（ComposerFilePreview /
 * ComposerModelRunSelector / ComposerAddMenu / useChatInputFileAttachments 等）拼装定时任务专用编辑面。
 */

// ── 组合层组件 ──────────────────────────────────────────────────────────────
export type {
  ComposerAddMenuAttachmentsProps,
  ComposerAddMenuChromeProps,
  ComposerAddMenuFeaturesProps,
  ComposerAddMenuMenuProps,
  ComposerAddMenuProps,
} from './addMenu/composerAddMenu.types'
export type {
  ChatComposerControl,
  ChatComposerInputControl,
  ChatComposerModelSelectorControl,
  ChatComposerProviderModelSelectOption,
  ChatComposerReasoningControl,
  ChatComposerSlots,
} from './ChatComposer'
export { ChatComposer } from './ChatComposer'
export type {
  ChatInputAttachmentsControl,
  ChatInputChromeControl,
  ChatInputControl,
  ChatInputExecutionControl,
  ChatInputFeaturesControl,
  ChatInputFieldControl,
  ChatInputQueueControl,
  ChatInputStreamingControl,
  ChatInputSuggestionControl,
} from './ChatInput'
export { ChatInput } from './ChatInput'
export { ComposerAddMenu } from './ComposerAddMenu'
export type {
  ChatComposerCapabilityChoice,
  ChatComposerCapabilityControl,
  ChatComposerCapabilityControlKind,
  ChatComposerCapabilityPlacement,
} from './ComposerCapabilityControls'
export {
  ComposerCapabilityControls,
  ComposerCapabilityIcon,
  ComposerCapabilityMenuItems,
} from './ComposerCapabilityControls'
export { ComposerFilePreview } from './ComposerFilePreview'
export { ComposerModelRunSelector } from './ComposerModelRunSelector'

// ── 类型 / 纯 util（单源）─────────────────────────────────────────────────────
export * from './chatInputComposerFocus.utils'
export * from './chatInputInteractionState.pure'
export * from './chatInputTypes'
export { mergeChatInputFiles, normalizeIncomingFile } from './chatInputUtils'
export type { ChatComposerLimitViolation } from './utils/chatComposerLimits'
export {
  ChatComposerInputMaxChars,
  ChatComposerInputWarningChars,
  clampChatComposerInput,
  formatChatComposerLimitViolation,
} from './utils/chatComposerLimits'

// ── 复用型 hooks（供 ScheduledTaskComposerDialog / 宿主装配复用）───────────────
export type { ChatInputComposerAddMenuBridgeInput } from './hooks/buildChatInputComposerAddMenuProps'
export { buildChatInputComposerAddMenuProps } from './hooks/buildChatInputComposerAddMenuProps'
export { useChatInputDraftActions } from './hooks/useChatInputDraftActions'
export { useChatInputFileAttachments } from './hooks/useChatInputFileAttachments'
export { useChatInputInsertDraftBridge } from './hooks/useChatInputInsertDraftBridge'
export { useChatInputPromptFeatureActivationBridge } from './hooks/useChatInputPromptFeatureActivationBridge'
export { useChatInputVoiceRecognition } from './hooks/useChatInputVoiceRecognition'
export {
  useComposerAddMenuState,
  type UseComposerAddMenuStateResult,
} from './hooks/useComposerAddMenuState'
export {
  useComposerCommentMentionMenu,
  type UseComposerCommentMentionMenuReturn,
} from './hooks/useComposerCommentMentionMenu'
export { useComposerPromptFeatures } from './hooks/useComposerPromptFeatures'
export { useComposerSkillSelection } from './hooks/useComposerSkillSelection'
export {
  useComposerSlashSkillMenu,
  type UseComposerSlashSkillMenuReturn,
} from './hooks/useComposerSlashSkillMenu'

// ── 注入端口 + 宿主 DOM 事件契约 ────────────────────────────────────────────
export * from './composerHostEvents'
export type {
  ComposerLocalSpeechRequest,
  ComposerLocalSpeechTranscription,
  ConversationComposerNotify,
  ConversationComposerPort,
} from './conversationComposerPort'
export {
  ConversationComposerPortProvider,
  emptyConversationComposerPort,
  useConversationComposerPort,
} from './conversationComposerPort'
