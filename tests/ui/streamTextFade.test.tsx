import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { StreamingTextBlock } from '../../packages/ui/src/conversation/blocks/MessageMarkdownBlocks'
import {
  createStreamFadeLedgerStore,
  planStreamFade,
  renderStreamFadeText,
  settleStreamFade,
  splitStreamFadeText,
  StreamFadeMarkdownText,
  StreamFadeMarkdownTextTagName,
  type StreamFadeRenderScope,
  StreamFadeRenderScopeContext,
  StreamTextFadeDurationMs,
  useStreamFadeViewState,
  velarStreamFadeTextPlugin,
} from '../../packages/ui/src/conversation/blocks/streamTextFade'
import { getStreamingThinkingDisplayWindow } from '../../packages/ui/src/conversation/blocks/thinkingTranslation'
import { ConversationLocalizationProvider } from '../../packages/ui/src/conversation/i18n'

const Open = Number.POSITIVE_INFINITY

void describe('stream text fade plan', () => {
  void test('a block seen for the first time fades from the start only while it is short', () => {
    assert.deepEqual(planStreamFade({ ledger: undefined, now: 5, sourceLength: 12, mounted: false }), [
      { start: 0, end: Open, bornAt: 5 },
    ])
    // 首次打开已在跑的长消息：整段当作已显示，不补淡入。
    assert.deepEqual(planStreamFade({ ledger: undefined, now: 5, sourceLength: 900, mounted: false }), [])
  })

  void test('new text joins a batch that has just started, otherwise opens a new one', () => {
    const ledger = { length: 10, chunks: [{ start: 0, end: 10, bornAt: 100 }] }

    assert.deepEqual(planStreamFade({ ledger, now: 120, sourceLength: 20, mounted: true }), [
      { start: 0, end: Open, bornAt: 100 },
    ])
    assert.deepEqual(planStreamFade({ ledger, now: 200, sourceLength: 20, mounted: true }), [
      { start: 0, end: 10, bornAt: 100 },
      { start: 10, end: Open, bornAt: 200 },
    ])
    // 淡完的批次并回普通文本。
    assert.deepEqual(
      planStreamFade({ ledger, now: 100 + StreamTextFadeDurationMs, sourceLength: 20, mounted: true }),
      [{ start: 10, end: Open, bornAt: 100 + StreamTextFadeDurationMs }]
    )
  })

  void test('a remounted view finishes the batches still fading and never replays what it missed', () => {
    const ledger = {
      length: 30,
      chunks: [
        { start: 0, end: 20, bornAt: 0 },
        { start: 20, end: 30, bornAt: 200 },
      ],
    }
    const plan = planStreamFade({
      ledger,
      now: StreamTextFadeDurationMs + 20,
      sourceLength: 400,
      mounted: false,
    })

    // 还在淡的那一批沿用原来的上屏时刻（进度不回零）；离开期间到的第 30 字以后直接显示。
    assert.deepEqual(plan, [{ start: 20, end: 30, bornAt: 200 }])
    assert.deepEqual(splitStreamFadeText('x'.repeat(60), 0, plan), [
      { text: 'x'.repeat(20), start: 0, bornAt: null },
      { text: 'x'.repeat(10), start: 20, bornAt: 200 },
      { text: 'x'.repeat(30), start: 30, bornAt: null },
    ])
  })

  void test('a block first seen while its message view is mounting shows as is', () => {
    // 切回会话时整条消息重新挂载：离开期间新起的短段落不从头淡入。
    assert.deepEqual(
      planStreamFade({ ledger: undefined, now: 5, sourceLength: 12, mounted: false, viewLive: false }),
      []
    )

    const views: boolean[] = []
    function Probe({ streaming, textLength }: { streaming: boolean; textLength: number }) {
      views.push(useStreamFadeViewState({ streaming, readTextLength: () => textLength }).live)
      return null
    }
    renderToStaticMarkup(createElement(Probe, { streaming: true, textLength: 6 }))
    renderToStaticMarkup(createElement(Probe, { streaming: true, textLength: 900 }))
    renderToStaticMarkup(createElement(Probe, { streaming: false, textLength: 0 }))
    // 刚诞生的回答挂载时就在屏上；已经写了很多的（切回来的）与已结束的，挂载那一帧都不算。
    assert.deepEqual(views, [true, false, false])
  })

  void test('settling closes the open batch at the rendered length and drops empty ones', () => {
    assert.deepEqual(
      settleStreamFade(
        [
          { start: 0, end: 8, bornAt: 1 },
          { start: 8, end: Open, bornAt: 2 },
        ],
        14
      ),
      {
        length: 14,
        chunks: [
          { start: 0, end: 8, bornAt: 1 },
          { start: 8, end: 14, bornAt: 2 },
        ],
      }
    )
    // 文本变短（Markdown 结构重排）时收口，不留越界批次。
    assert.deepEqual(settleStreamFade([{ start: 8, end: Open, bornAt: 2 }], 5), { length: 5, chunks: [] })
  })

  void test('the ledger store keeps the most recent blocks', () => {
    const store = createStreamFadeLedgerStore(2)
    store.set('a', { length: 1, chunks: [] })
    store.set('b', { length: 2, chunks: [] })
    store.set('a', { length: 3, chunks: [] })
    store.set('c', { length: 4, chunks: [] })

    assert.equal(store.get('b'), undefined)
    assert.equal(store.get('a')?.length, 3)
    assert.equal(store.get('c')?.length, 4)
  })
})

void describe('stream text fade rendering', () => {
  void test('only the text inside a batch is wrapped, keyed by where the batch starts', () => {
    const markup = renderToStaticMarkup(
      createElement('p', null, renderStreamFadeText('hello world', 0, [{ start: 6, end: Open, bornAt: 1 }]))
    )
    assert.equal(markup, '<p>hello <span data-velar-stream-fade="">world</span></p>')
    assert.equal(renderStreamFadeText('settled', 0, []), 'settled')
  })

  void test('the markdown plugin marks text nodes with their offsets and leaves code and whitespace alone', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            { type: 'text', value: 'Hello ' },
            { type: 'element', tagName: 'strong', children: [{ type: 'text', value: 'bold' }] },
            { type: 'element', tagName: 'code', children: [{ type: 'text', value: 'x()' }] },
            { type: 'text', value: '\n' },
            { type: 'text', value: ' tail' },
          ],
        },
      ],
    }
    velarStreamFadeTextPlugin()(tree)

    const paragraph = tree.children[0].children
    assert.deepEqual(paragraph[0], {
      type: 'element',
      tagName: StreamFadeMarkdownTextTagName,
      properties: { dataVelarStreamStart: 0 },
      children: [{ type: 'text', value: 'Hello ' }],
    })
    assert.equal(paragraph[1].children?.[0].tagName, StreamFadeMarkdownTextTagName)
    assert.deepEqual(paragraph[1].children?.[0].properties, { dataVelarStreamStart: 6 })
    // 代码不淡入、不计长度；纯空白保持文本节点但计长度。
    assert.deepEqual(paragraph[2].children, [{ type: 'text', value: 'x()' }])
    assert.deepEqual(paragraph[3], { type: 'text', value: '\n' })
    assert.deepEqual(paragraph[4].properties, { dataVelarStreamStart: 11 })
  })

  void test('marked text is split by the block plan from context and reports how far it reaches', () => {
    const scope: StreamFadeRenderScope = {
      chunks: [{ start: 3, end: Open, bornAt: 9 }],
      report: { textLength: 0 },
    }
    const markup = renderToStaticMarkup(
      createElement(
        StreamFadeRenderScopeContext.Provider,
        { value: scope },
        createElement(StreamFadeMarkdownText, { 'data-velar-stream-start': 0 }, 'abcdef')
      )
    )

    assert.equal(markup, 'abc<span data-velar-stream-fade="">def</span>')
    assert.equal(scope.report.textLength, 6)
  })

  void test('each streaming block fades by its own plan through the real Streamdown pipeline', () => {
    // Streamdown 按插件函数名共用处理器；两条消息同屏渲染，淡入状态不能串。
    const longText = `${'settled words '.repeat(8)}end`
    const markup = renderToStaticMarkup(
      createElement(
        ConversationLocalizationProvider,
        { value: { locale: 'zh-CN', t: (key: string) => key } },
        createElement(StreamingTextBlock, {
          block: { type: 'text', text: 'Hello **world**' },
          animationKey: 'fade-test-new:text',
          animateText: true,
          isMessageStreaming: true,
        }),
        createElement(StreamingTextBlock, {
          block: { type: 'text', text: longText },
          animationKey: 'fade-test-long:text',
          animateText: true,
          isMessageStreaming: true,
        })
      )
    )

    assert.match(markup, /<span data-velar-stream-fade="">Hello <\/span>/u)
    assert.match(markup, /data-streamdown="strong"><span data-velar-stream-fade="">world<\/span>/u)
    assert.equal(markup.match(/data-velar-stream-fade/gu)?.length, 2, 'the long block shows as is')
    assert.ok(markup.includes(longText))
    assert.doesNotMatch(markup, new RegExp(StreamFadeMarkdownTextTagName, 'u'))
  })

  void test('the streaming thinking window is a suffix of the original text', () => {
    const text = ['one', 'two', 'three', 'four'].join('\n')
    assert.deepEqual(getStreamingThinkingDisplayWindow(text, { streaming: true, maxChars: 0, maxLines: 2 }), {
      text: 'three\nfour',
      start: 8,
      truncated: true,
    })
    assert.deepEqual(getStreamingThinkingDisplayWindow(text, { streaming: false }), {
      text,
      start: 0,
      truncated: false,
    })
  })
})
