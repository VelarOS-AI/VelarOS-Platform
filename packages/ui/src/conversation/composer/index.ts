/**
 * `@velaros-ai/ui/conversation/composer` 提供会话输入框原子。
 *
 * 本包包含输入框、附件槽、发送控件、队列草稿、模型与推理选择、添加菜单、技能与评论补全、下一步
 * 建议及语音输入。数据和会话回调通过 `ChatComposerControl` 投影，环境能力通过
 * `ConversationComposerPort` 注入；宿主只保留草稿提交及端口、插槽装配。
 *
 * `ScheduledTaskComposerDialog` 也会复用本包零件，拼装定时任务专用编辑面。
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
  ChatComposerDensity,
  ChatComposerInputControl,
  ChatComposerModelRunSummary,
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
  ChatInputGoalModeCopy,
  ChatInputQueueControl,
  ChatInputStreamingControl,
  ChatInputSuggestionControl,
} from './ChatInput'
export { ChatInput } from './ChatInput'
export type {
  ChatSurfaceComposerProps,
  ChatSurfaceVariant,
} from './ChatSurfaceComposer'
export {
  ChatSurfaceComposer,
  resolveChatSurfaceComposerDensity,
} from './ChatSurfaceComposer'
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
  useComposerMentionMenu,
  type UseComposerMentionMenuReturn,
} from './hooks/useComposerMentionMenu'
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
