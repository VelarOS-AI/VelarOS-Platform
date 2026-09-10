import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  type ConversationBlockHooks,
  ConversationBlockHooksProvider,
} from '../../packages/ui/src/conversation/blocks/conversationBlockHooks'
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
import { ChatTranscript } from '../../packages/ui/src/conversation/shell/ChatTranscript'
import { buildChatTranscriptMessagePresentations } from '../../packages/ui/src/conversation/shell/chatTranscriptActivityGrouping'
import {
  buildChatTranscriptDerivedIndexes,
  resolveActiveTranscriptAssistantMessageId,
} from '../../packages/ui/src/conversation/shell/chatTranscriptDerivedIndexes'
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
    assert.equal(derived.latestAssistantMessage?.id, secondAssistant.id)
  })

  void test('新一轮已发出而助手还没开口时，运行提示不能挂回上一轮的助手消息', () => {
    const previousTurn = message('turn-1', 'user', 'turn-input')
    const previousAssistant = message('assistant-1', 'assistant')
    const nextTurn = message('turn-2', 'user', 'turn-input')
    const derive = (messages: Array<ReturnType<typeof message>>) =>
      buildChatTranscriptDerivedIndexes({
        messages,
        messageRunMarkerMap: new Map(),
        shouldRenderAwaitingInputCard: false,
      })

    const pending = derive([previousTurn, previousAssistant, nextTurn])
    assert.equal(pending.latestAssistantMessage?.id, previousAssistant.id)
    assert.equal(pending.hasTurnInputAfterLatestAssistant, true)

    const answered = derive([
      previousTurn,
      previousAssistant,
      nextTurn,
      message('assistant-2', 'assistant'),
    ])
    assert.equal(answered.hasTurnInputAfterLatestAssistant, false)

    // 引导消息属于同一轮，不开启新一轮：提示仍跟着当前助手消息。
    const guided = derive([
      previousTurn,
      previousAssistant,
      message('guidance', 'user', 'run-guidance'),
    ])
    assert.equal(guided.hasTurnInputAfterLatestAssistant, false)
  })

  void test('引导开始后不会把上一条已完成 assistant 重新标记为流式', () => {
    assert.equal(
      resolveActiveTranscriptAssistantMessageId({
        isRunActive: true,
        latestAssistantMessageId: 'assistant-completed',
        latestAssistantRunMarker: { status: 'completed' },
      }),
      null
    )
    assert.equal(
      resolveActiveTranscriptAssistantMessageId({
        isRunActive: true,
        streamingAssistantMessageId: 'assistant-current',
        latestAssistantMessageId: 'assistant-completed',
        latestAssistantRunMarker: { status: 'completed' },
      }),
      'assistant-current'
    )
    assert.equal(
      resolveActiveTranscriptAssistantMessageId({
        isRunActive: true,
        latestAssistantMessageId: 'assistant-current',
      }),
      'assistant-current'
    )
  })

  void test('运行中把引导后的片段挂到引导前 assistant，保持原组件身份', () => {
    const turn = message('turn', 'user', 'turn-input')
    const firstAssistant = message('assistant-1', 'assistant')
    const firstGuidance = message('guidance-1', 'user', 'run-guidance')
    const interactionReply = message('reply', 'user', 'interaction-reply')
    const secondAssistant = message('assistant-2', 'assistant')
    const secondGuidance = message('guidance-2', 'user', 'run-guidance')
    const finalAssistant = message('assistant-final', 'assistant')
    const presentations = buildChatTranscriptMessagePresentations([
      turn,
      firstAssistant,
      firstGuidance,
      interactionReply,
      secondAssistant,
      secondGuidance,
      finalAssistant,
    ])

    assert.deepEqual(
      presentations.map((presentation) => presentation.message.id),
      ['turn', 'assistant-1']
    )
    assert.deepEqual(presentations[1]?.activityLeadingMessages, [])
    assert.deepEqual(
      presentations[1]?.activityTrailingMessages.map((entry) => entry.id),
      ['guidance-1', 'reply', 'assistant-2', 'guidance-2', 'assistant-final']
    )
  })

  void test('正常完成后由最终 assistant 承载整轮活动和外部总结', () => {
    const turn = message('turn', 'user', 'turn-input')
    const firstAssistant = message('assistant-1', 'assistant')
    const guidance = message('guidance', 'user', 'run-guidance')
    const finalAssistant = message('assistant-final', 'assistant')
    const presentations = buildChatTranscriptMessagePresentations(
      [turn, firstAssistant, guidance, finalAssistant],
      { isCompletedAssistant: (entry) => entry.id === finalAssistant.id }
    )

    assert.deepEqual(
      presentations.map((presentation) => presentation.message.id),
      ['turn', 'assistant-final']
    )
    assert.deepEqual(
      presentations[1]?.activityLeadingMessages.map((entry) => entry.id),
      ['assistant-1', 'guidance']
    )
    assert.deepEqual(presentations[1]?.activityTrailingMessages, [])
  })

  void test('下一轮已经开始时为漏失 marker 的上一轮补齐完成边界', () => {
    const turn = message('turn', 'user', 'turn-input')
    const firstAssistant = message('assistant-1', 'assistant')
    const guidance = message('guidance', 'user', 'run-guidance')
    const finalAssistant = message('assistant-final', 'assistant')
    const nextTurn = message('turn-2', 'user', 'turn-input')
    const presentations = buildChatTranscriptMessagePresentations([
      turn,
      firstAssistant,
      guidance,
      finalAssistant,
      nextTurn,
    ])

    assert.deepEqual(
      presentations.map((presentation) => presentation.message.id),
      ['turn', 'assistant-final', 'turn-2']
    )
    assert.equal(presentations[1]?.implicitlyCompletedRun, true)
    assert.deepEqual(
      presentations[1]?.activityLeadingMessages.map((entry) => entry.id),
      ['assistant-1', 'guidance']
    )
  })

  void test('显式失败 marker 阻止 turn 边界把上一轮推断为完成', () => {
    const assistant = message('assistant-failed', 'assistant')
    const presentations = buildChatTranscriptMessagePresentations(
      [message('turn', 'user', 'turn-input'), assistant, message('turn-2', 'user', 'turn-input')],
      { hasRunMarker: (entry) => entry.id === assistant.id }
    )

    assert.equal(presentations[1]?.implicitlyCompletedRun, false)
  })

  void test('新 assistant 片段到达前，引导留在当前活动尾部且不触发前文折叠', () => {
    const turn = message('turn', 'user', 'turn-input')
    const assistant = message('assistant', 'assistant')
    const guidance = message('guidance', 'user', 'run-guidance')
    const presentations = buildChatTranscriptMessagePresentations([turn, assistant, guidance])

    assert.deepEqual(
      presentations.map((presentation) => presentation.message.id),
      ['turn', 'assistant']
    )
    assert.deepEqual(presentations[1]?.activityLeadingMessages, [])
    assert.deepEqual(
      presentations[1]?.activityTrailingMessages.map((entry) => entry.id),
      ['guidance']
    )
  })

  void test('没有引导时不改变原始消息呈现', () => {
    const messages = [
      message('turn', 'user', 'turn-input'),
      message('assistant-1', 'assistant'),
      message('assistant-2', 'assistant'),
    ]
    const presentations = buildChatTranscriptMessagePresentations(messages)

    assert.deepEqual(
      presentations.map((presentation) => presentation.message.id),
      messages.map((entry) => entry.id)
    )
    assert.ok(
      presentations.every(
        (presentation) =>
          presentation.activityLeadingMessages.length === 0 &&
          presentation.activityTrailingMessages.length === 0
      )
    )
  })
})

const localization: ConversationI18nContextValue = {
  locale: 'zh-CN',
  t: (key) => {
    if (key === 'chat.guidedConversation') return '已引导对话'
    if (key === 'chat.copyGuidance') return '复制引导'
    if (key === 'chat.codeBlockCopied') return '已复制'
    if (key === 'chat.processedActivity') return '已处理'
    return key
  },
}
const blockHooks: ConversationBlockHooks = {
  useAutoTranslateThinkingEnabled: () => false,
  useMessageActionView: () => ({
    actionItems: [],
    actionRows: [],
    formatPathForDisplay: (path) => path,
    hasActionItems: false,
    openPathInLight: async () => {},
  }),
}

function guidanceTranscriptMessages(): ChatMessage[] {
  return [
    message('turn', 'user', 'turn-input'),
    {
      ...message('assistant-before-guidance', 'assistant'),
      blocks: [{ type: 'thinking', text: '先检查当前页面。' }],
    },
    message('guidance', 'user', 'run-guidance'),
    {
      ...message('assistant-after-guidance', 'assistant'),
      blocks: [
        { type: 'thinking', text: '根据补充要求完成剩余检查。' },
        {
          type: 'tool-call',
          toolCallId: 'tool-final',
          toolName: 'system:read',
          args: {},
          result: { ok: true },
          isRunning: false,
        },
        { type: 'text', text: '最终总结留在已处理外面。' },
      ],
    },
  ]
}

void test('运行中将引导与前后 assistant 片段保持在同一个平铺活动里', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: localization },
      createElement(
        ConversationBlockHooksProvider,
        { value: blockHooks },
        createElement(ChatTranscript, {
          messages: guidanceTranscriptMessages(),
          sessionId: 'session',
          getIsStreaming: (entry) => entry.id === 'assistant-before-guidance',
        })
      )
    ) as ReactElement
  )

  assert.match(markup, /data-chat-run-activity="true"/)
  assert.match(markup, /data-chat-message="guidance"/)
  assert.doesNotMatch(markup, /aria-expanded=/)
  assert.doesNotMatch(markup, />已处理</)
})

void test('运行中追加引导不会插到既有 assistant 块之间', () => {
  const beforeGuidance: ChatMessage = {
    ...message('assistant-before-guidance', 'assistant'),
    blocks: [
      { type: 'text', text: '先说明处理方式。' },
      {
        type: 'tool-call',
        toolCallId: 'tool-before-guidance',
        toolName: 'system:run',
        args: {},
        result: { ok: true },
        isRunning: false,
      },
      { type: 'text', text: '引导前已经产生的后续正文。' },
    ],
  }
  const afterGuidance = {
    ...message('assistant-after-guidance', 'assistant'),
    blocks: [{ type: 'text' as const, text: '收到引导后的继续执行。' }],
  }
  const guidance = {
    ...message('guidance', 'user', 'run-guidance'),
    blocks: [{ type: 'text' as const, text: '追加要求内容标记。' }],
  }
  const markup = renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: localization },
      createElement(
        ConversationBlockHooksProvider,
        { value: blockHooks },
        createElement(ChatTranscript, {
          messages: [
            message('turn', 'user', 'turn-input'),
            beforeGuidance,
            guidance,
            afterGuidance,
          ],
          sessionId: 'session',
          getIsStreaming: (entry) => entry.id === beforeGuidance.id,
        })
      )
    ) as ReactElement
  )

  const existingContentIndex = markup.indexOf('引导前已经产生的后续正文。')
  const guidanceIndex = markup.indexOf('追加要求内容标记。')
  const afterGuidanceIndex = markup.indexOf('收到引导后的继续执行。')

  assert.ok(existingContentIndex >= 0)
  assert.ok(guidanceIndex > existingContentIndex)
  assert.ok(afterGuidanceIndex > guidanceIndex)
})

void test('旧会话运行完成后只留下一个已处理入口，并把引导内容收进其中', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: localization },
      createElement(
        ConversationBlockHooksProvider,
        { value: blockHooks },
        createElement(ChatTranscript, {
          messages: guidanceTranscriptMessages(),
          sessionId: 'session',
          getRunMarker: (entry) =>
            entry.id === 'assistant-after-guidance'
              ? {
                  messageId: entry.id,
                  status: 'completed',
                  detail: null,
                  turnCount: 1,
                  turnKind: 'turn',
                  timestamp: 2,
                }
              : null,
        })
      )
    ) as ReactElement
  )

  assert.equal(markup.match(/>已处理</g)?.length, 1)
  assert.match(markup, /aria-expanded="false"/)
  assert.doesNotMatch(markup, /data-chat-message="guidance"/)
  assert.match(markup, /最终总结留在已处理外面。/)
})

void test('真实长任务在下一轮开始后即使漏存完成 marker 也生成已处理折叠', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: localization },
      createElement(
        ConversationBlockHooksProvider,
        { value: blockHooks },
        createElement(ChatTranscript, {
          messages: [
            ...guidanceTranscriptMessages(),
            message('next-independent-task', 'user', 'turn-input'),
          ],
          sessionId: 'session',
        })
      )
    ) as ReactElement
  )

  assert.equal(markup.match(/>已处理</g)?.length, 1)
  assert.match(markup, /aria-expanded="false"/)
  assert.doesNotMatch(markup, /data-chat-message="guidance"/)
  assert.match(markup, /最终总结留在已处理外面。/)
})

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
