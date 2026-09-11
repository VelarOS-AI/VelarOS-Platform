import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createChatScrollNavigatorVisibilityStore } from '../../packages/ui/src/conversation/react-hooks/chatScrollNavigatorVisibility'
import {
  resolveAutoScrollPinnedAfterScroll,
  resolveAutoScrollWheelDecision,
  resolveTranscriptWindowFollowEndAfterScroll,
  shouldAutoScrollAfterContentResize,
  shouldCommitScheduledAutoScroll,
  shouldStartImmediateAutoScroll,
} from '../../packages/ui/src/conversation/react-hooks/scrollBehavior'
import { resolveConversationRefreshGeneration } from '../../packages/ui/src/conversation/shell/conversationRefreshGeneration'

void describe('chat auto-scroll ownership', () => {
  void test('keeps native wheel scrolling available in the default unlocked follow mode', () => {
    assert.deepEqual(resolveAutoScrollWheelDecision(false, -120), {
      shouldPreventDefault: false,
      shouldSuspendAutoScroll: true,
    })
    assert.deepEqual(resolveAutoScrollWheelDecision(false, 120), {
      shouldPreventDefault: false,
      shouldSuspendAutoScroll: false,
    })
  })

  void test('does not reclaim the viewport after the user leaves the bottom', () => {
    const movement = {
      pinned: true,
      previousScrollTop: 1600,
      currentScrollTop: 0,
      isNearBottom: false,
      movementTolerancePx: 48,
    }

    assert.equal(shouldAutoScrollAfterContentResize(movement), false)
    assert.equal(shouldStartImmediateAutoScroll(movement), false)
    assert.equal(
      shouldCommitScheduledAutoScroll({
        pinned: true,
        scheduledScrollTop: 1600,
        currentScrollTop: 0,
        isNearBottom: false,
        movementTolerancePx: 48,
      }),
      false
    )
  })

  void test('keeps following ordinary content growth and bottom clamping', () => {
    assert.equal(
      shouldAutoScrollAfterContentResize({
        pinned: true,
        previousScrollTop: 1600,
        currentScrollTop: 1600,
        isNearBottom: false,
        movementTolerancePx: 48,
      }),
      true
    )
    assert.equal(
      shouldCommitScheduledAutoScroll({
        pinned: true,
        scheduledScrollTop: 1600,
        currentScrollTop: 1400,
        isNearBottom: true,
        movementTolerancePx: 48,
      }),
      true
    )
  })

  void test('treats a shrink that clamps the view to the new bottom as still following', () => {
    // 发送多行提问后输入框清空、底部留白收回 40px：scrollTop 被夹到新底部，不是用户上滑。
    assert.equal(
      resolveAutoScrollPinnedAfterScroll({
        previousPinned: true,
        previousScrollTop: 14_910,
        currentScrollTop: 14_870,
        isNearBottom: true,
        isAtBottom: true,
      }),
      true
    )
    assert.equal(
      resolveTranscriptWindowFollowEndAfterScroll({
        currentFollowEnd: true,
        previousScrollTop: 14_910,
        currentScrollTop: 14_870,
        isAtBottom: true,
      }),
      true
    )
    // 真的往上滚、离开了底部：照旧解除跟随，哪怕还在 near-bottom 区内。
    assert.equal(
      resolveAutoScrollPinnedAfterScroll({
        previousPinned: true,
        previousScrollTop: 1_600,
        currentScrollTop: 1_590,
        isNearBottom: true,
        isAtBottom: false,
      }),
      false
    )
    // 已经解除跟随时，夹底也不会把用户拽回跟随。
    assert.equal(
      resolveAutoScrollPinnedAfterScroll({
        previousPinned: false,
        previousScrollTop: 1_600,
        currentScrollTop: 1_560,
        isNearBottom: true,
        isAtBottom: true,
      }),
      false
    )
  })

  void test('keeps the transcript window anchored after upward intent until the user returns down', () => {
    assert.equal(
      resolveTranscriptWindowFollowEndAfterScroll({
        currentFollowEnd: true,
        previousScrollTop: 1600,
        currentScrollTop: 1200,
        isAtBottom: false,
      }),
      false
    )
    assert.equal(
      resolveTranscriptWindowFollowEndAfterScroll({
        currentFollowEnd: false,
        previousScrollTop: 1200,
        currentScrollTop: 1500,
        isAtBottom: false,
      }),
      false
    )
    assert.equal(
      resolveTranscriptWindowFollowEndAfterScroll({
        currentFollowEnd: false,
        previousScrollTop: 1500,
        currentScrollTop: 1600,
        isAtBottom: true,
      }),
      true
    )
  })
})

void describe('chat scroll navigator visibility', () => {
  void test('keeps a host-owned visibility snapshot stable across pane subscribers', () => {
    const store = createChatScrollNavigatorVisibilityStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    assert.equal(store.getSnapshot(), false)
    store.toggle()
    assert.equal(store.getSnapshot(), true)
    assert.equal(notifications, 1)
    store.setHidden(true)
    assert.equal(notifications, 1)
    store.setHidden(false)
    assert.equal(store.getSnapshot(), false)
    assert.equal(notifications, 2)

    unsubscribe()
    store.toggle()
    assert.equal(notifications, 2)
  })
})

void describe('conversation refresh generation', () => {
  void test('freezes high-frequency host refresh keys during a run and accepts them at settlement', () => {
    let generation = resolveConversationRefreshGeneration(null, {
      sessionId: 'session-a',
      key: 1,
      isRunActive: false,
    })
    const mountedGeneration = generation

    generation = resolveConversationRefreshGeneration(generation, {
      sessionId: 'session-a',
      key: 2,
      isRunActive: true,
    })
    assert.equal(generation, mountedGeneration)
    generation = resolveConversationRefreshGeneration(generation, {
      sessionId: 'session-a',
      key: 300,
      isRunActive: true,
    })
    assert.equal(generation.key, 1)

    generation = resolveConversationRefreshGeneration(generation, {
      sessionId: 'session-a',
      key: 300,
      isRunActive: false,
    })
    assert.equal(generation.key, 300)

    generation = resolveConversationRefreshGeneration(generation, {
      sessionId: 'session-b',
      key: 1,
      isRunActive: true,
    })
    assert.equal(generation.sessionId, 'session-b')
    assert.equal(generation.key, 1)
  })

  void test('ignores a discarded speculative generation when an active run renders again', () => {
    const committed = resolveConversationRefreshGeneration(null, {
      sessionId: 'session-a',
      key: 1,
      isRunActive: false,
    })

    // StrictMode / concurrent rendering may evaluate this terminal frame without committing it.
    const discarded = resolveConversationRefreshGeneration(committed, {
      sessionId: 'session-a',
      key: 200,
      isRunActive: false,
    })
    assert.equal(discarded.key, 200)

    // The next render must still derive from the last committed generation, not the discarded one.
    const active = resolveConversationRefreshGeneration(committed, {
      sessionId: 'session-a',
      key: 201,
      isRunActive: true,
    })
    assert.equal(active, committed)
    assert.equal(active.key, 1)
  })
})
