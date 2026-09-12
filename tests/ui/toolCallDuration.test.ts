import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ConversationTranslator } from '../../packages/ui/src/conversation/i18n/conversationTranslator'
import {
  formatToolDurationMs,
  getToolDurationMs,
  getToolGroupStatusLabel,
} from '../../packages/ui/src/conversation/tool-render/toolCallSummary'

const translator: ConversationTranslator = {
  translate: (_locale, key, params) => `${key}:${JSON.stringify(params ?? {})}`,
  lookupMessage: () => null,
}

void describe('tool call duration', () => {
  void test('measures a tool from when the executor started it, not from when the call arrived', () => {
    // 同一批里排在三个有副作用工具后面：到达 1s，等到 13s 才拿到调用槽，15s 结束。
    assert.equal(
      getToolDurationMs({ startedAt: 1_000, finishedAt: 15_000, result: {}, metadata: { executionStartedAt: 13_000 } }),
      2_000
    )
  })

  void test('falls back to the arrival time for blocks recorded before the executor stamped a start', () => {
    assert.equal(getToolDurationMs({ startedAt: 1_000, finishedAt: 15_000, result: {} }), 14_000)
    assert.equal(
      getToolDurationMs({ startedAt: 1_000, finishedAt: 15_000, result: {}, metadata: { executionStartedAt: 'soon' } }),
      14_000
    )
  })

  void test('a duration reported by the tool itself wins', () => {
    assert.equal(
      getToolDurationMs({
        startedAt: 1_000,
        finishedAt: 15_000,
        result: { durationMs: 1_200 },
        metadata: { executionStartedAt: 13_000 },
      }),
      1_200
    )
  })

  void test('a group of concurrent tools counts overlapping time once', () => {
    const blocks = [
      { isRunning: false, startedAt: 1_000, finishedAt: 4_000, result: {}, metadata: { executionStartedAt: 1_000 } },
      { isRunning: false, startedAt: 1_000, finishedAt: 3_000, result: {}, metadata: { executionStartedAt: 1_000 } },
      { isRunning: false, startedAt: 1_000, finishedAt: 4_000, result: {}, metadata: { executionStartedAt: 2_000 } },
    ]
    assert.equal(getToolGroupStatusLabel(blocks, 'en-US', translator), formatToolDurationMs(3_000, 'en-US', translator))
  })

  void test('a group of sequential tools adds up', () => {
    const blocks = [
      { isRunning: false, startedAt: 1_000, finishedAt: 5_000, result: {}, metadata: { executionStartedAt: 1_000 } },
      { isRunning: false, startedAt: 1_000, finishedAt: 9_000, result: {}, metadata: { executionStartedAt: 5_000 } },
      { isRunning: false, startedAt: 1_000, finishedAt: 13_000, result: {}, metadata: { executionStartedAt: 9_000 } },
    ]
    assert.equal(getToolGroupStatusLabel(blocks, 'en-US', translator), formatToolDurationMs(12_000, 'en-US', translator))
  })
})
