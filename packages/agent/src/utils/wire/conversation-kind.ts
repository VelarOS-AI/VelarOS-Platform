/** 旧消息只在读取时推断；所有新 user-role 消息创建路径都应显式写 conversationKind。 */

import type { ChatMessageConversationKind, ChatMessageConversationSemanticInput } from '../../types/agent.js'

/**
 * 判定一条聊天消息在对话语义上属于哪一类。非 user role 一律记 `assistant-output`（fail closed）；
 * user role 且已显式写了四种合法 conversationKind 之一就照写；只有旧消息没写这个字段时才回退推断——
 * 带 `guidanceStatus` 的算 `run-guidance`，否则算 `turn-input`。新建消息不该依赖这条回退。
 */
export function resolveChatMessageConversationKind(
  message: ChatMessageConversationSemanticInput
): ChatMessageConversationKind {
  // 持久化/IPC 外框可能只把 role 声明成 string；未知或非 user role 必须 fail closed，
  // 不能被分页、回卷和“最近一次用户诉求”逻辑误判成新一轮输入。
  if (message.role !== 'user') return 'assistant-output'
  if (
    message.conversationKind === 'turn-input' ||
    message.conversationKind === 'run-guidance' ||
    message.conversationKind === 'interaction-reply' ||
    message.conversationKind === 'system-notice'
  )
    return message.conversationKind

  return message.guidanceStatus ? 'run-guidance' : 'turn-input'
}

/**
 * 仅当这条消息判定为 `turn-input` 时为真——也就是「用户真正发起的一轮新诉求」。
 * 运行引导、交互回填、系统通知都不算，分页与「最近一次用户诉求」定位靠它划界。
 */
export function isConversationTurnInputMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'turn-input'
}

/**
 * 仅当这条消息判定为 `run-guidance` 时为真——用户在一轮执行进行中插进来的补充指示，
 * 它不开启新一轮，只改当前这轮的方向。
 */
export function isRunGuidanceMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'run-guidance'
}

/**
 * 仅当这条消息判定为 `system-notice` 时为真——挂在 user role 上、但实际由系统注入给模型看的通知
 * （如目标自动续跑、环境变更）。它不是人写的，统计与展示要跟真用户消息区分开。
 */
export function isSystemNoticeMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'system-notice'
}
