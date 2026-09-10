import type { ConversationMessageRunMarker } from '../projection'

import type { ChatMessage } from '#contracts'
import { isConversationTurnInputMessage } from '#contracts'
import { toNullable } from '#internal/runtime'

export interface ChatTranscriptDerivedIndexesInput {
  messages: readonly ChatMessage[]
  messageRunMarkerMap: ReadonlyMap<string, ConversationMessageRunMarker>
  shouldRenderAwaitingInputCard: boolean
  awaitingInputQuestion?: LooseOptional<string>
}

export interface ChatTranscriptDerivedIndexes {
  latestAssistantMessage: Nullable<ChatMessage>
  /**
   * 最近一条助手消息之后是否已经出现新的用户输入（新一轮已发出、助手还没开口）。
   * 此时任何运行/结果提示都属于新的一轮，不能再挂到上一轮的助手消息上——那条消息在新输入的上方。
   */
  hasTurnInputAfterLatestAssistant: boolean
  latestCompletedAssistantMessage: Nullable<ChatMessage>
  latestCompletedAssistantMessageId: Nullable<string>
  planUpdateIndexByToolCallId: Map<string, number>
  assistantQuestionMap: Map<string, ChatMessage>
  activeAwaitingInputMessageId: Nullable<string>
}

export function resolveActiveTranscriptAssistantMessageId({
  isRunActive,
  streamingAssistantMessageId,
  latestAssistantMessageId,
  latestAssistantRunMarker,
}: {
  isRunActive: boolean
  streamingAssistantMessageId?: LooseOptional<string>
  latestAssistantMessageId?: LooseOptional<string>
  latestAssistantRunMarker?: LooseOptional<Pick<ConversationMessageRunMarker, 'status'>>
}): Nullable<string> {
  if (!isRunActive) return null
  if (streamingAssistantMessageId) return streamingAssistantMessageId
  if (!latestAssistantMessageId || latestAssistantRunMarker?.status === 'completed') return null

  return latestAssistantMessageId
}

export function buildChatTranscriptDerivedIndexes({
  messages,
  messageRunMarkerMap,
  shouldRenderAwaitingInputCard,
  awaitingInputQuestion,
}: ChatTranscriptDerivedIndexesInput): ChatTranscriptDerivedIndexes {
  const planUpdateIndexByToolCallId = new Map<string, number>()
  const assistantQuestionMap = new Map<string, ChatMessage>()
  const expectedQuestion = awaitingInputQuestion?.trim() || null

  let latestAssistantMessage: Nullable<ChatMessage> = null
  let latestCompletedAssistantMessage: Nullable<ChatMessage> = null
  let activeAwaitingInputMessageId: Nullable<string> = null
  let latestUserMessage: Nullable<ChatMessage> = null
  let hasTurnInputAfterLatestAssistant = false
  let planUpdateIndex = 0

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool-call' || block.toolName !== 'plan:update') continue

      planUpdateIndexByToolCallId.set(block.toolCallId, planUpdateIndex)
      planUpdateIndex += 1
    }

    if (isConversationTurnInputMessage(message)) {
      latestUserMessage = message
      hasTurnInputAfterLatestAssistant = true
      continue
    }

    if (message.role === 'user') continue

    latestAssistantMessage = message
    hasTurnInputAfterLatestAssistant = false

    if (latestUserMessage) {
      assistantQuestionMap.set(message.id, latestUserMessage)
    }

    const marker = messageRunMarkerMap.get(message.id)

    if (marker?.status === 'completed') {
      latestCompletedAssistantMessage = message
    }

    if (shouldRenderAwaitingInputCard && marker?.status === 'awaiting-input') {
      const markerQuestion = marker.detail?.trim() || null

      if (!expectedQuestion || markerQuestion === expectedQuestion) {
        activeAwaitingInputMessageId = message.id
      }
    }

  }

  return {
    latestAssistantMessage,
    hasTurnInputAfterLatestAssistant,
    latestCompletedAssistantMessage,
    latestCompletedAssistantMessageId: toNullable(latestCompletedAssistantMessage?.id),
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    activeAwaitingInputMessageId,
  }
}
