import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  MessageMarkdownRuntimeProvider,
  useMessageMarkdownComponents,
} from '../../packages/ui/src/conversation/blocks/useMessageMarkdownComponents'
import {
  isMessageMarkdownFileReference,
  normalizeMessageMarkdownFileReference,
  resolveMessageMarkdownHrefTarget,
} from '../../packages/ui/src/conversation/markdown/messageMarkdownLinks.utils'

function MarkdownLinkProbe({ href }: { href: string }): ReactElement {
  const { components, runtime } = useMessageMarkdownComponents(undefined, async () => {})
  const Anchor = components.a

  assert.ok(Anchor)

  return createElement(
    MessageMarkdownRuntimeProvider,
    { runtime },
    createElement(Anchor, { href }, href)
  )
}

function InlineCodeProbe({ value }: { value: string }): ReactElement {
  const { components, runtime } = useMessageMarkdownComponents(undefined, async () => {})
  const InlineCode = components.inlineCode

  assert.ok(InlineCode)

  return createElement(
    MessageMarkdownRuntimeProvider,
    { runtime },
    createElement(InlineCode, {}, value)
  )
}

void describe('会话 Markdown 文件路径链接', () => {
  void test('仅把跨平台绝对文件路径识别为可打开文件', () => {
    const absolutePaths = [
      '/Users/example/project/src/game.mjs',
      '/Users/example/project/src/game.mjs:42:7',
      String.raw`C:\project\src\game.mjs`,
      String.raw`\\server\share\src\game.mjs`,
    ]

    for (const path of absolutePaths) {
      assert.equal(isMessageMarkdownFileReference(path), true, path)
      assert.equal(resolveMessageMarkdownHrefTarget(path).kind, 'project-file', path)
    }

    assert.equal(
      normalizeMessageMarkdownFileReference('file:///Users/example/project/src/game.mjs'),
      '/Users/example/project/src/game.mjs'
    )
  })

  void test('文件名和相对路径保持文本语义', () => {
    const relativePaths = [
      'game.mjs',
      'src/game.mjs',
      'test/game.test.mjs',
      './src/game.mjs',
      '../src/game.mjs',
      '~/project/src/game.mjs',
    ]

    for (const path of relativePaths) {
      assert.equal(isMessageMarkdownFileReference(path), false, path)
      assert.equal(normalizeMessageMarkdownFileReference(path), null, path)
      assert.deepEqual(resolveMessageMarkdownHrefTarget(path), {
        kind: 'text',
        text: path,
      })
    }
  })

  void test('显式 Markdown 相对文件目标不生成链接元素', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownLinkProbe, { href: 'test/game.test.mjs' })
    )

    assert.equal(markup, '<span>test/game.test.mjs</span>')
  })

  void test('行内相对路径保留代码样式但不生成链接元素', () => {
    const markup = renderToStaticMarkup(createElement(InlineCodeProbe, { value: 'src/game.mjs' }))

    assert.equal(markup, '<code>src/game.mjs</code>')
  })

  void test('绝对路径仍生成应用内文件链接', () => {
    const markup = renderToStaticMarkup(
      createElement(InlineCodeProbe, {
        value: '/Users/example/project/src/game.mjs',
      })
    )

    assert.match(markup, /<a\b/u)
    assert.match(markup, /data-tour-id="chat-result-link"/u)
  })
})
