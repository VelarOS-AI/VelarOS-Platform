import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  shouldAutoScrollAfterContentResize,
  shouldCommitScheduledAutoScroll,
  shouldStartImmediateAutoScroll,
} from '../../packages/ui/src/conversation/react-hooks/scrollBehavior'

void describe('chat auto-scroll ownership', () => {
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
})
