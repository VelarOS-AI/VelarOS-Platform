import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { UserMessageBubble } from '../../packages/ui/src/conversation/blocks/UserMessageBubble'
import type { ChatMessage } from '../../packages/ui/src/conversation/contracts'
import {
  isConversationTurnInputMessage,
  isRunGuidanceMessage,
  resolveChatMessageConversationKind,
} from '../../packages/ui/src/conversation/contracts'
import {
  type ConversationI18nContextValue,
  ConversationLocalizationProvider,
} from '../../packages/ui/src/conversation/i18n'
import { buildChatTranscriptDerivedIndexes } from '../../packages/ui/src/conversation/shell/chatTranscriptDerivedIndexes'
import {
  computeChatTranscriptSectionStarts,
  resolveChatTranscriptWindowMessages,
} from '../../packages/ui/src/conversation/shell/useChatTranscriptWindow'

function message(
  id: string,
  role: ChatMessage['role'],
  conversationKind?: ChatMessage['conversationKind']
): ChatMessage {
  return {
    id,
    role,
    conversationKind,
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
  }
}

void describe('会话消息语义', () => {
  void test('模型 user role 不再等于新一轮会话', () => {
    const turnInput = message('turn-1', 'user', 'turn-input')
    const guidance = message('guidance', 'user', 'run-guidance')
    const reply = message('reply', 'user', 'interaction-reply')

    assert.equal(isConversationTurnInputMessage(turnInput), true)
    assert.equal(isConversationTurnInputMessage(guidance), false)
    assert.equal(isConversationTurnInputMessage(reply), false)
    assert.equal(isRunGuidanceMessage(guidance), true)
    assert.equal(resolveChatMessageConversationKind(message('assistant', 'assistant')), 'assistant-output')
  })

  void test('旧引导状态只作为读取回退，不会重新成为 turn 边界', () => {
    const legacyGuidance = {
      ...message('legacy-guidance', 'user'),
      guidanceStatus: 'sent' as const,
    }

    assert.equal(resolveChatMessageConversationKind(legacyGuidance), 'run-guidance')
    assert.equal(isConversationTurnInputMessage(legacyGuidance), false)
  })

  void test('引导和交互回复留在当前 section，不会把上方对话裁掉', () => {
    const messages = [
      message('turn-1', 'user', 'turn-input'),
      message('assistant-1', 'assistant'),
      message('guidance', 'user', 'run-guidance'),
      message('assistant-2', 'assistant'),
      message('reply', 'user', 'interaction-reply'),
      message('assistant-3', 'assistant'),
      message('turn-2', 'user', 'turn-input'),
    ]

    assert.deepEqual(computeChatTranscriptSectionStarts(messages), [0, 6])
  })

  void test('长运行收到引导后仍保留整段当前对话，而不是只剩引导后的尾部', () => {
    const longRunningTurn = [
      message('turn', 'user', 'turn-input'),
      ...Array.from({ length: 64 }, (_, index) => message(`assistant-${index}`, 'assistant')),
      message('guidance', 'user', 'run-guidance'),
      message('assistant-after-guidance', 'assistant'),
    ]
    const visible = resolveChatTranscriptWindowMessages({
      messages: longRunningTurn,
      state: { followEnd: true, anchorIndex: 0 },
    })

    assert.equal(visible[0]?.id, 'turn')
    assert.equal(visible.at(-1)?.id, 'assistant-after-guidance')
    assert.equal(visible.length, longRunningTurn.length)
  })

  void test('引导不会替换 assistant 的原始问题归属', () => {
    const turn = message('turn', 'user', 'turn-input')
    const firstAssistant = message('assistant-1', 'assistant')
    const guidance = message('guidance', 'user', 'run-guidance')
    const secondAssistant = message('assistant-2', 'assistant')
    const derived = buildChatTranscriptDerivedIndexes({
      messages: [turn, firstAssistant, guidance, secondAssistant],
      messageRunMarkerMap: new Map(),
      shouldRenderAwaitingInputCard: false,
    })

    assert.equal(derived.assistantQuestionMap.get(firstAssistant.id), turn)
    assert.equal(derived.assistantQuestionMap.get(secondAssistant.id), turn)
  })
})

const localization: ConversationI18nContextValue = {
  locale: 'zh-CN',
  t: (key) => {
    if (key === 'chat.guidedConversation') return '已引导对话'
    if (key === 'chat.copyGuidance') return '复制引导'
    if (key === 'chat.codeBlockCopied') return '已复制'
    return key
  },
}

void test('运行内引导复用气泡视觉，但展示自己的标签和复制语义', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: localization },
      createElement(UserMessageBubble, {
        message: message('guidance', 'user', 'run-guidance'),
        onRewindToMessage: async () => {},
        canRewindToMessage: true,
      })
    ) as ReactElement
  )

  assert.match(markup, /data-conversation-kind="run-guidance"/)
  assert.match(markup, /已引导对话/)
  assert.match(markup, /复制引导/)
  assert.doesNotMatch(markup, /chat\.rewind/)
})
