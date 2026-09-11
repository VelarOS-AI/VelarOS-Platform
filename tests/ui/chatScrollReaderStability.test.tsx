import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ConversationBlockHooksProvider,
  emptyConversationBlockHooks,
} from '../../packages/ui/src/conversation/blocks/conversationBlockHooks'
import { ThinkingBlock } from '../../packages/ui/src/conversation/blocks/MessageMarkdownBlocks'
import { ConversationLocalizationProvider } from '../../packages/ui/src/conversation/i18n'
import {
  ConversationScrollFollowProvider,
  registerConversationScrollFollow,
  resolveConversationScrollFollow,
  useConversationAutoCollapseHold,
  useConversationScrollFollow,
} from '../../packages/ui/src/conversation/react-hooks/conversationScrollFollow'
import {
  type AutoCollapseHoldState,
  resolveAutoCollapseHold,
  resolveAutoScrollPinnedAfterScroll,
  resolveScrollClampGuard,
  ScrollClampGuardCssVariable,
  ScrollClampGuardSlackPx,
} from '../../packages/ui/src/conversation/react-hooks/scrollBehavior'

const ViewportHeight = 900

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8')
}

function FollowProbe(): ReactElement {
  const follow = useConversationScrollFollow()
  return createElement('output', null, String(follow.isFollowingBottom()))
}

function HoldProbe({ collapseRequested }: { collapseRequested: boolean }): ReactElement {
  return createElement('output', null, String(useConversationAutoCollapseHold(collapseRequested)))
}

function renderThinkingBlock(props: { defaultExpanded?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ConversationLocalizationProvider,
      { value: { locale: 'zh-CN', t: (key: string) => key } },
      createElement(
        ConversationBlockHooksProvider,
        { value: emptyConversationBlockHooks },
        createElement(ThinkingBlock, {
          block: { type: 'thinking', text: 'weighing the options' },
          isStreaming: false,
          messageId: 'assistant-1',
          blockIndex: 0,
          ...props,
        })
      )
    )
  )
}

void describe('scroll clamp guard', () => {
  void test('holds an unfollowing reader when a shrink in the viewport clamps scrollTop', () => {
    // 读者停在 98233，视口里的内容变矮：浏览器把 scrollTop 夹到新底部 98100。
    const decision = resolveScrollClampGuard({
      following: false,
      cause: 'content-resize',
      guardPx: 0,
      previousScrollTop: 98_233,
      currentScrollTop: 98_100,
      maxScrollTop: 98_100,
      viewportHeight: ViewportHeight,
    })

    assert.deepEqual(decision, { guardPx: 133 + ScrollClampGuardSlackPx, restoreScrollTop: 98_233 })
    // 撑住后读者离（含占位的）底部正好一段余量：各处到底判定都不会把他当成回到底部。
    const extendedMaxScrollTop = 98_100 + decision.guardPx
    assert.equal(extendedMaxScrollTop - 98_233, ScrollClampGuardSlackPx)
    assert.equal(
      resolveAutoScrollPinnedAfterScroll({
        previousPinned: false,
        previousScrollTop: 98_233,
        currentScrollTop: 98_233,
        isNearBottom: extendedMaxScrollTop - 98_233 <= 24,
        isAtBottom: extendedMaxScrollTop - 98_233 <= 2,
      }),
      false
    )
  })

  void test('never guards while the reader follows the bottom', () => {
    assert.deepEqual(
      resolveScrollClampGuard({
        following: true,
        cause: 'content-resize',
        guardPx: 181,
        previousScrollTop: 98_233,
        currentScrollTop: 98_100,
        maxScrollTop: 98_100,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
  })

  void test('lets the browser clamp when the content the reader saw is gone', () => {
    // 真机取证那一次：「已处理」整段收起 17.6k，读者看的内容已不在了，撑住只剩一屏空白。
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: 0,
        previousScrollTop: 98_233,
        currentScrollTop: 83_045,
        maxScrollTop: 83_045,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
  })

  void test('respects native scroll anchoring for shrinks above the viewport', () => {
    // 视口上方收起 400px，原生锚定把 scrollTop 从 5000 挪到 4600；新底部 4700 并不是夹出来的。
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: 0,
        previousScrollTop: 5_000,
        currentScrollTop: 4_600,
        maxScrollTop: 4_700,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
    // 视口下方的变化够不着视口：不夹底，也就不需要占位。
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: 0,
        previousScrollTop: 1_000,
        currentScrollTop: 1_000,
        maxScrollTop: 1_200,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
  })

  void test('ignores sub-pixel overshoot', () => {
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: 0,
        previousScrollTop: 1_000.5,
        currentScrollTop: 1_000,
        maxScrollTop: 1_000,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
  })

  void test('shrinks the guard as content grows back and releases it once the content covers the reader', () => {
    const heldGuardPx = 133 + ScrollClampGuardSlackPx
    // 自然底部从 98100 长到 98200：占位缩小，视口不动。
    const grown = resolveScrollClampGuard({
      following: false,
      cause: 'content-resize',
      guardPx: heldGuardPx,
      previousScrollTop: 98_233,
      currentScrollTop: 98_233,
      maxScrollTop: 98_200 + heldGuardPx,
      viewportHeight: ViewportHeight,
    })
    assert.deepEqual(grown, { guardPx: 33 + ScrollClampGuardSlackPx, restoreScrollTop: null })

    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: grown.guardPx,
        previousScrollTop: 98_233,
        currentScrollTop: 98_233,
        maxScrollTop: 98_300 + grown.guardPx,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 0, restoreScrollTop: null }
    )
  })

  void test('regrows the guard when the slack absorbs a further shrink, and restores through a bigger one', () => {
    const heldGuardPx = 133 + ScrollClampGuardSlackPx
    // 再矮 30px：余量吸收了，没有夹底，占位加高把余量补回来。
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: heldGuardPx,
        previousScrollTop: 98_233,
        currentScrollTop: 98_233,
        maxScrollTop: 98_070 + heldGuardPx,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 163 + ScrollClampGuardSlackPx, restoreScrollTop: null }
    )
    // 再矮 100px：越过余量被夹到 98181，放回 98233。
    assert.deepEqual(
      resolveScrollClampGuard({
        following: false,
        cause: 'content-resize',
        guardPx: heldGuardPx,
        previousScrollTop: 98_233,
        currentScrollTop: 98_181,
        maxScrollTop: 98_181,
        viewportHeight: ViewportHeight,
      }),
      { guardPx: 233 + ScrollClampGuardSlackPx, restoreScrollTop: 98_233 }
    )
  })

  void test('only lets the reader shrink the guard by scrolling', () => {
    const heldGuardPx = 133 + ScrollClampGuardSlackPx
    const extendedMaxScrollTop = 98_100 + heldGuardPx
    const readerScroll = (currentScrollTop: number): number =>
      resolveScrollClampGuard({
        following: false,
        cause: 'reader-scroll',
        guardPx: heldGuardPx,
        previousScrollTop: 98_233,
        currentScrollTop,
        maxScrollTop: extendedMaxScrollTop,
        viewportHeight: ViewportHeight,
      }).guardPx

    // 上滑 50px：占位跟着缩 50px，余量仍留在读者下方。
    assert.equal(readerScroll(98_183), 83 + ScrollClampGuardSlackPx)
    // 滑回自然内容里：占位撤掉。
    assert.equal(readerScroll(98_000), 0)
    // 往下滚进余量：占位不加高，滚完余量即到底，由贴底判定恢复跟随。
    assert.equal(readerScroll(98_260), heldGuardPx)
  })
})

void describe('auto-collapse hold', () => {
  const idle: AutoCollapseHoldState = { collapseRequested: false, holdExpanded: false }

  void test('collapses as before when the reader follows the bottom', () => {
    assert.deepEqual(resolveAutoCollapseHold(idle, true, () => true), {
      collapseRequested: true,
      holdExpanded: false,
    })
  })

  void test('holds a collapse that appears while the reader is away from the bottom', () => {
    const held = resolveAutoCollapseHold(idle, true, () => false)
    assert.deepEqual(held, { collapseRequested: true, holdExpanded: true })
    // 判定只在请求出现时做一次：读者后来回到底部，也不会在他眼前补收。
    assert.equal(resolveAutoCollapseHold(held, true, () => true), held)
  })

  void test('does not treat a mount that is already collapsed as a new request', () => {
    const mountedCompleted: AutoCollapseHoldState = { collapseRequested: true, holdExpanded: false }
    let asked = false
    assert.equal(
      resolveAutoCollapseHold(mountedCompleted, true, () => {
        asked = true
        return false
      }),
      mountedCompleted
    )
    assert.equal(asked, false)
  })

  void test('releases the hold when the request is withdrawn and re-evaluates the next one', () => {
    const held = resolveAutoCollapseHold(idle, true, () => false)
    const resumed = resolveAutoCollapseHold(held, false, () => false)
    assert.deepEqual(resumed, { collapseRequested: false, holdExpanded: false })
    assert.deepEqual(resolveAutoCollapseHold(resumed, true, () => true), {
      collapseRequested: true,
      holdExpanded: false,
    })
  })
})

void describe('conversation scroll follow', () => {
  void test('defaults to following without a provider so auto-collapse keeps its old behaviour', () => {
    assert.equal(renderToStaticMarkup(createElement(FollowProbe)), '<output>true</output>')
    assert.equal(
      renderToStaticMarkup(createElement(HoldProbe, { collapseRequested: true })),
      '<output>false</output>'
    )
  })

  void test('reads the follow state registered for the pane scrollRef', () => {
    const scrollRef = { current: null }
    const renderProbe = (): string =>
      renderToStaticMarkup(
        createElement(ConversationScrollFollowProvider, { scrollRef }, createElement(FollowProbe))
      )

    // 宿主自己管滚动、没有 useScrollToBottom 登记：按跟随处理。
    assert.equal(renderProbe(), '<output>true</output>')

    const unregister = registerConversationScrollFollow(scrollRef, {
      isFollowingBottom: () => false,
    })
    assert.equal(renderProbe(), '<output>false</output>')

    unregister()
    assert.equal(renderProbe(), '<output>true</output>')
  })

  void test('looks the registry up at call time', () => {
    const scrollRef = { current: null }
    const follow = resolveConversationScrollFollow(scrollRef)
    assert.equal(follow.isFollowingBottom(), true)

    let following = false
    const unregister = registerConversationScrollFollow(scrollRef, {
      isFollowingBottom: () => following,
    })
    assert.equal(follow.isFollowingBottom(), false)
    following = true
    assert.equal(follow.isFollowingBottom(), true)

    // 注销只撤自己登记的那一份，不误删后来者。
    const replacement = { isFollowingBottom: () => false }
    registerConversationScrollFollow(scrollRef, replacement)
    unregister()
    assert.equal(follow.isFollowingBottom(), false)
  })

  void test('mounts a completed thinking block collapsed unless the reader hold keeps it open', () => {
    assert.match(renderThinkingBlock({}), /aria-expanded="false"/)

    const held = renderThinkingBlock({ defaultExpanded: true })
    assert.match(held, /aria-expanded="true"/)
    assert.match(held, /weighing the options/)
  })
})

void describe('reader-stable auto-collapse wiring', () => {
  void test('every programmatic collapse consults the reader follow state', () => {
    const toolActivity = readSource('packages/ui/src/conversation/blocks/MessageToolActivity.tsx')
    assert.match(
      toolActivity,
      /if \(!scrollFollow\.isFollowingBottom\(\)\) return;\s*setExpanded\(false\);/u
    )

    const thinking = readSource('packages/ui/src/conversation/blocks/MessageMarkdownBlocks.tsx')
    assert.match(thinking, /autoCollapse && scrollFollow\.isFollowingBottom\(\)/u)
    assert.match(thinking, /wasStreaming && !isStreaming && scrollFollow\.isFollowingBottom\(\)/u)

    const segments = readSource('packages/ui/src/conversation/blocks/AssistantMessageSegments.tsx')
    assert.match(segments, /useConversationAutoCollapseHold\(!isStreaming\)/u)
    assert.equal(segments.match(/defaultExpanded=\{holdExpandedForReader\}/gu)?.length, 3)
    assert.match(segments, /thinkingDefaultExpanded=\{holdExpandedForReader\}/u)

    const actionCard = readSource('packages/ui/src/conversation/cards/UserActionCard.tsx')
    assert.match(actionCard, /viewModel\.autoCollapsed && !holdExpandedForReader/u)
  })

  void test('the pane provides the follow state and ends its scroll content with the guard spacer', () => {
    const pane = readSource('packages/ui/src/conversation/shell/ChatConversationPane.tsx')
    assert.match(pane, /<ConversationScrollFollowProvider scrollRef=\{scrollRef\}>/u)
    assert.match(
      pane,
      /<\/Stack>\s*\{\/\*[\s\S]*?\*\/\}\s*<div aria-hidden="true" className=\{styles\.scrollClampGuard\} \/>\s*<\/ScrollArea>/u
    )

    const stylesheet = readSource('packages/ui/src/conversation/shell/ChatConversationPane.module.css')
    assert.ok(
      stylesheet.includes(`height: var(${ScrollClampGuardCssVariable}, 0px);`),
      'the spacer must consume the CSS variable useScrollToBottom writes'
    )
    assert.match(stylesheet, /\.scrollClampGuard \{[^}]*overflow-anchor: none;/u)
  })
})
