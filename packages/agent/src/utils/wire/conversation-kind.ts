/** 旧消息只在读取时推断；所有新 user-role 消息创建路径都应显式写 conversationKind。 */

import type { ChatMessageConversationKind, ChatMessageConversationSemanticInput } from '../../types/agent.js'

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

export function isConversationTurnInputMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'turn-input'
}

export function isRunGuidanceMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'run-guidance'
}

export function isSystemNoticeMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'system-notice'
}
