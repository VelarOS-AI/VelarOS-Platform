/**
 * blocks 原子——消息内工具活动 / 提供方制品组 / 模型图片组 / 系统工具安装建议卡 + 工具结果汇总列表
 * （pass-1）+ 气泡族（MessageBubble / User·Assistant / Segments / Footer / StatusMarker / InlineRuntimeNotice /
 * UserAttachmentGallery，pass-3b1）+ 消息动作行（MessageActionList/Row/MessageBubbleActions）+ 渲染模型/成本/
 * 动作项/思考翻译/live-text 纯工具 + 品牌帆标。渲染件纯呈现，viewmodel/IPC 走投影 + 宿主 hook/slot 注入。
 *
 * 门面收口：只导出宿主消费点需要的符号（MessageBubble / StatusMarker / 渲染模型 / 成本 / 动作项 /
 * 思考翻译 / live-text / 帆标）；气泡族内部件（Assistant 气泡 / User 气泡 / Inline 提示 / Action 行 等）是
 * MessageBubble 的实现细节，仅包内相对 import，不进门面。
 */
export * from './AssistantProviderArtifactGroup'
export * from './chatActionItems'
export {
  ChatThinkingVisibilityProvider,
  useChatThinkingVisibility,
} from './chatThinkingVisibility'
export {
  type ConversationBlockHooks,
  ConversationBlockHooksProvider,
  type ConversationMessageActionOptions,
  useConversationBlockHooks,
} from './conversationBlockHooks'
export * from './liveTextRendererMode'
export * from './MessageBubble'
export * from './messageBubbleRenderModel'
export * from './messageCostEstimate'
export * from './MessageStatusMarker'
export * from './MessageToolActivity'
export * from './SystemToolInstallSuggestionCard'
export * from './thinkingTranslation'
export * from './ToolModelImageGroup'
export * from './ToolResultSummaryList'
export * from './VelarSailMark'
