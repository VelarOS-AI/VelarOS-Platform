import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { resolveGoalCompletionRunWindow } from '../../packages/ui/src/conversation/shell/useChatConversationTranscriptModel'

void describe('goal completion timing', () => {
  void test('keeps the completed message duration when a follow-up run has already started', () => {
    assert.deepEqual(
      resolveGoalCompletionRunWindow({
        runMarker: {
          messageId: 'completed-run',
          status: 'completed',
          detail: null,
          turnCount: 8,
          turnKind: 'totalTurns',
          goalMode: true,
          startedAt: 1_000,
          durationMs: 5_000,
          timestamp: 6_000,
        },
        lastRunStartedAt: 9_000,
        lastRunFinishedAt: null,
      }),
      {
        startedAt: 1_000,
        finishedAt: 6_000,
        durationMs: 5_000,
      }
    )
  })

  void test('does not turn a later run start into a zero millisecond duration for legacy markers', () => {
    assert.deepEqual(
      resolveGoalCompletionRunWindow({
        runMarker: {
          messageId: 'legacy-completed-run',
          status: 'completed',
          detail: null,
          turnCount: 8,
          turnKind: 'totalTurns',
          goalMode: true,
          timestamp: 6_000,
        },
        lastRunStartedAt: 9_000,
        lastRunFinishedAt: null,
      }),
      {
        startedAt: null,
        finishedAt: 6_000,
        durationMs: null,
      }
    )
  })

  void test('does not attach a later follow-up finish time to a legacy marker', () => {
    assert.deepEqual(
      resolveGoalCompletionRunWindow({
        runMarker: {
          messageId: 'legacy-completed-run',
          status: 'completed',
          detail: null,
          turnCount: 8,
          turnKind: 'totalTurns',
          goalMode: true,
          timestamp: 6_000,
        },
        lastRunStartedAt: 9_000,
        lastRunFinishedAt: 14_000,
      }),
      {
        startedAt: null,
        finishedAt: 6_000,
        durationMs: null,
      }
    )
  })

  void test('keeps the legacy latest-run fallback when its timestamps belong to the same run', () => {
    assert.deepEqual(
      resolveGoalCompletionRunWindow({
        runMarker: {
          messageId: 'legacy-current-run',
          status: 'completed',
          detail: null,
          turnCount: 8,
          turnKind: 'totalTurns',
          goalMode: true,
          timestamp: 6_000,
        },
        lastRunStartedAt: 1_000,
        lastRunFinishedAt: 6_000,
      }),
      {
        startedAt: 1_000,
        finishedAt: 6_000,
        durationMs: 5_000,
      }
    )
  })
})
