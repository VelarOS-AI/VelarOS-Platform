import type { ConversationMessageRunMarker } from '../projection'

import type { ChatMessage } from '#contracts'

export interface ChatTranscriptDerivedIndexesInput {
  messages: readonly ChatMessage[]
  messageRunMarkerMap: ReadonlyMap<string, ConversationMessageRunMarker>
  shouldRenderAwaitingInputCard: boolean
  awaitingInputQuestion?: LooseOptional<string>
}

export interface ChatTranscriptDerivedIndexes {
  latestAssistantMessage: Nullable<ChatMessage>
  latestCompletedAssistantMessage: Nullable<ChatMessage>
  latestCompletedAssistantMessageId: Nullable<string>
  planUpdateIndexByToolCallId: Map<string, number>
  assistantQuestionMap: Map<string, ChatMessage>
  guidedInputMessageIds: Set<string>
  activeAwaitingInputMessageId: Nullable<string>
}

export function buildChatTranscriptDerivedIndexes({
  messages,
  messageRunMarkerMap,
  shouldRenderAwaitingInputCard,
  awaitingInputQuestion,
}: ChatTranscriptDerivedIndexesInput): ChatTranscriptDerivedIndexes {
  const planUpdateIndexByToolCallId = new Map<string, number>()
  const assistantQuestionMap = new Map<string, ChatMessage>()
  const guidedInputMessageIds = new Set<string>()
  const expectedQuestion = awaitingInputQuestion?.trim() || null

  let latestAssistantMessage: Nullable<ChatMessage> = null
  let latestCompletedAssistantMessage: Nullable<ChatMessage> = null
  let activeAwaitingInputMessageId: Nullable<string> = null
  let latestUserMessage: Nullable<ChatMessage> = null
  let previousMessage: Nullable<ChatMessage> = null
  let planUpdateIndex = 0

  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool-call' || block.toolName !== 'update_plan') continue

      planUpdateIndexByToolCallId.set(block.toolCallId, planUpdateIndex)
      planUpdateIndex += 1
    }

    if (message.role === 'user') {
      if (previousMessage?.role === 'assistant') {
        const previousMarker = messageRunMarkerMap.get(previousMessage.id)

        if (previousMarker?.status === 'awaiting-input') {
          guidedInputMessageIds.add(message.id)
        }
      }

      latestUserMessage = message
      previousMessage = message
      continue
    }

    latestAssistantMessage = message

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

    previousMessage = message
  }

  return {
    latestAssistantMessage,
    latestCompletedAssistantMessage,
    latestCompletedAssistantMessageId: latestCompletedAssistantMessage?.id ?? null,
    planUpdateIndexByToolCallId,
    assistantQuestionMap,
    guidedInputMessageIds,
    activeAwaitingInputMessageId,
  }
}
