import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { type ComponentType, createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageContentBlock } from '../../packages/ui/src/conversation/blocks/MessageContentBlock'
import {
  MessageMarkdownRuntimeProvider,
  useMessageMarkdownComponents,
} from '../../packages/ui/src/conversation/blocks/useMessageMarkdownComponents'
import type { TextBlock } from '../../packages/ui/src/conversation/contracts'
import {
  type ConversationI18nContextValue,
  ConversationLocalizationProvider,
} from '../../packages/ui/src/conversation/i18n'
import { STREAMDOWN_MARKDOWN_PLUGINS } from '../../packages/ui/src/conversation/markdown/streamdownMarkdown.config'
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
    conversationCardContent: () => null,
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
function CodeFenceProbe({
  languageClassName = 'language-ts',
  isStreaming = false,
}: {
  languageClassName?: string
  isStreaming?: boolean
}): ReactElement {
  const { components, runtime } = useMessageMarkdownComponents(undefined, undefined, 'open', {
    isStreaming,
  })
  const Pre = components.pre as ComponentType<{ children: ReactNode }>

  return createElement(
    MessageMarkdownRuntimeProvider,
    { runtime },
    createElement(
      Pre,
      null,
      createElement(
        'code',
        languageClassName ? { className: languageClassName } : null,
        'const answer = 42'
      )
    )
  )
}

function renderCodeFence(
  slots: ConversationRenderSlots,
  languageClassName = 'language-ts',
  isStreaming = false
): string {
  return renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: i18nValue },
      createElement(
        ConversationRenderSlotsProvider,
        { slots },
        createElement(CodeFenceProbe, { languageClassName, isStreaming })
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

  void test('未声明语言的围栏默认标记为 text', () => {
    const markup = renderCodeFence(createSlots({}), '')

    assert.match(markup, /class="language-text"/)
  })

  void test('声明式图表完成后默认进入预览并提供统一源码入口', () => {
    const markup = renderCodeFence(createSlots({}), 'language-mermaid')

    assert.equal(STREAMDOWN_MARKDOWN_PLUGINS.mermaid.name, 'mermaid')
    assert.match(markup, /data-view="preview"/)
    assert.match(markup, /aria-label="chat\.codeBlockShowSource"/)
  })

  void test('声明式图表流式生成时回退源码且不暴露切换按钮', () => {
    const markup = renderCodeFence(createSlots({}), 'language-mermaid', true)

    assert.match(markup, /data-view="source"/)
    assert.match(markup, /data-streamdown="code-block"/)
    assert.doesNotMatch(markup, /chat\.codeBlockShowPreview/)
  })

  void test('工具栏布局由共享组件自身保证，不依赖消费端生成 Streamdown 工具类', () => {
    const stylesheet = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/blocks/MessageBubble.module.css',
        import.meta.url
      ),
      'utf8'
    )
    const codeBlockRules = stylesheet.match(
      /& \[data-streamdown='code-block'\] \{(?<rules>[^}]*)\}/
    )?.groups?.rules
    const actionRules = stylesheet.match(
      /& \[data-streamdown='code-block-actions'\] \{(?<rules>[^}]*)\}/
    )?.groups?.rules

    assert.ok(codeBlockRules)
    assert.match(codeBlockRules, /display: flex;/)
    assert.match(codeBlockRules, /flex-direction: column;/)
    assert.ok(actionRules)
    assert.match(actionRules, /position: absolute;/)
    assert.match(actionRules, /display: flex;/)
    assert.match(actionRules, /justify-content: flex-end;/)
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

  void test('替换件收到的未声明语言同样归一为 text', () => {
    const markup = renderCodeFence(
      createSlots({
        messageCodeBlock: ({ language }) =>
          createElement('section', { 'data-language': language }),
      }),
      ''
    )

    assert.match(markup, /data-language="text"/)
  })

  void test('替换件返回 null（弃权）回落官方实现', () => {
    assert.equal(
      renderCodeFence(createSlots({ messageCodeBlock: () => null })),
      renderCodeFence(createSlots({}))
    )
  })
})
