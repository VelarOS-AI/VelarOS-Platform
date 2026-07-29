import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { type ComponentType, createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageContentBlock } from '../../packages/ui/src/conversation/blocks/MessageContentBlock'
import { useMessageMarkdownComponents } from '../../packages/ui/src/conversation/blocks/useMessageMarkdownComponents'
import type { TextBlock } from '../../packages/ui/src/conversation/contracts'
import {
  type ConversationI18nContextValue,
  ConversationLocalizationProvider,
} from '../../packages/ui/src/conversation/i18n'
import {
  type ConversationRenderSlots,
  ConversationRenderSlotsProvider,
} from '../../packages/ui/src/conversation/render-slots'

const textBlock: TextBlock = { type: 'text', text: 'hello **world**' }

/** 增强槽全填空实现；替换槽按用例决定填不填——「不填」正是被验的那条路。 */
function createSlots(overrides: Partial<ConversationRenderSlots>): ConversationRenderSlots {
  return {
    capabilityAutoApprovalNotice: () => null,
    scheduledTaskProposal: () => null,
    flaggedTaskSuggestion: () => null,
    browserScreenshotGroup: () => null,
    workerThreadPanel: () => null,
    systemToolInstall: () => null,
    askUser: () => null,
    userActionCard: () => null,
    messageFileChangeSummary: () => null,
    stickyDockItemContent: () => null,
    renderMessageBoundary: ({ children }) => createElement('div', null, children),
    ...overrides,
  }
}

function renderTextBlock(slots: ConversationRenderSlots): string {
  return renderToStaticMarkup(
    createElement(
      ConversationRenderSlotsProvider,
      { slots },
      createElement(MessageContentBlock, {
        block: textBlock,
        isStreaming: false,
        animateStreamingText: false,
        sessionId: 'session',
        messageId: 'message',
      })
    ) as ReactElement
  )
}

void describe('会话替换槽（messageMarkdown）', () => {
  void test('槽位缺席时与「注入面完全没装」逐字节同一份官方输出', () => {
    const withoutProvider = renderToStaticMarkup(
      createElement(MessageContentBlock, {
        block: textBlock,
        isStreaming: false,
        animateStreamingText: false,
        sessionId: 'session',
        messageId: 'message',
      }) as ReactElement
    )

    assert.equal(renderTextBlock(createSlots({})), withoutProvider)
    assert.match(withoutProvider, /hello \*\*world\*\*/)
  })

  void test('注入替换件时正文改由替换件渲染', () => {
    const markup = renderTextBlock(
      createSlots({
        messageMarkdown: ({ text, isStreaming }) =>
          createElement('article', { 'data-mod': 'markdown', 'data-streaming': isStreaming }, text),
      })
    )

    assert.match(markup, /data-mod="markdown"/)
    assert.match(markup, /data-streaming="false"/)
  })

  void test('替换件返回 null（弃权）回落官方实现', () => {
    assert.equal(
      renderTextBlock(createSlots({ messageMarkdown: () => null })),
      renderTextBlock(createSlots({}))
    )
  })

  void test('替换件拿到的正文是官方渲染器逐字消费的那份（已按流式规则准备）', () => {
    let observed = ''
    renderToStaticMarkup(
      createElement(
        ConversationRenderSlotsProvider,
        {
          slots: createSlots({
            messageMarkdown: ({ text }) => {
              observed = text
              return createElement('article', null, text)
            },
          }),
        },
        createElement(MessageContentBlock, {
          // 裸 `$` 是 prepareStreamdownMarkdownText 的招牌动作：转义后才交渲染器。
          block: { type: 'text', text: 'cost is 5$ today' },
          isStreaming: false,
          animateStreamingText: false,
          sessionId: 'session',
          messageId: 'message',
        })
      ) as ReactElement
    )

    assert.equal(observed, 'cost is 5\\$ today')
  })
})

const i18nValue: ConversationI18nContextValue = {
  locale: 'zh-CN',
  t: (key: string) => key,
}

/** 直接驱动 `components.pre`：绕开 Streamdown 解析，只验围栏渲染器这一格的改道。 */
function CodeFenceProbe(): ReactElement {
  const components = useMessageMarkdownComponents(undefined, undefined, 'open', {
    isStreaming: false,
  })
  const Pre = components.pre as ComponentType<{ children: ReactNode }>

  return createElement(
    Pre,
    null,
    createElement('code', { className: 'language-ts' }, 'const answer = 42')
  )
}

function renderCodeFence(slots: ConversationRenderSlots): string {
  return renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: i18nValue },
      createElement(
        ConversationRenderSlotsProvider,
        { slots },
        createElement(CodeFenceProbe)
      )
    ) as ReactElement
  )
}

void describe('会话替换槽（messageCodeBlock）', () => {
  void test('槽位缺席时走官方可展开代码框', () => {
    const markup = renderCodeFence(createSlots({}))

    assert.match(markup, /data-block="true"/)
    assert.match(markup, /const answer = 42/)
  })

  void test('注入替换件时围栏改由替换件渲染，并拿到语言与正文', () => {
    const markup = renderCodeFence(
      createSlots({
        messageCodeBlock: ({ language, code, isStreaming }) =>
          createElement(
            'section',
            { 'data-mod': 'code', 'data-language': language, 'data-streaming': isStreaming },
            code
          ),
      })
    )

    assert.match(markup, /data-mod="code"/)
    assert.match(markup, /data-language="ts"/)
    assert.match(markup, /const answer = 42/)
    assert.doesNotMatch(markup, /data-block="true"/)
  })

  void test('替换件返回 null（弃权）回落官方实现', () => {
    assert.equal(
      renderCodeFence(createSlots({ messageCodeBlock: () => null })),
      renderCodeFence(createSlots({}))
    )
  })
})
