import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  DefaultStreamPaceTuning,
  resolveStreamPaceBudget,
} from '../../packages/ui/src/conversation/stream/streamPaceBudget'

function simulateFixedBacklog(frameIntervalMs: number, durationMs: number): number {
  let carriedCharCredit = 0
  let emittedChars = 0
  const frameCount = Math.floor(durationMs / frameIntervalMs)

  for (let frame = 0; frame < frameCount; frame += 1) {
    const budget = resolveStreamPaceBudget(
      { backlogChars: 2_000, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      { elapsedMs: frameIntervalMs, carriedCharCredit }
    )
    emittedChars += budget.charBudget
    carriedCharCredit = budget.availableCharCredit - budget.charBudget
  }

  return emittedChars
}

void describe('chat stream elapsed-time pace budget', () => {
  void test('keeps the same visible rate across 60Hz and 120Hz frame schedules', () => {
    const at60Hz = simulateFixedBacklog(1000 / 60, 2_000)
    const at120Hz = simulateFixedBacklog(1000 / 120, 2_000)

    assert.ok(Math.abs(at60Hz - at120Hz) <= 1, `${at60Hz} vs ${at120Hz}`)
  })

  void test('never converts a long blocked frame into a large catch-up burst', () => {
    const budget = resolveStreamPaceBudget(
      { backlogChars: 100_000, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      { elapsedMs: 5_000, carriedCharCredit: 0 }
    )

    assert.equal(budget.charBudget, DefaultStreamPaceTuning.maxCharsPerFrame)
    assert.ok(budget.charBudget <= 6)
  })

  void test('carries fractional character credit instead of alternating arbitrary chunk sizes', () => {
    const first = resolveStreamPaceBudget(
      { backlogChars: 10, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      { elapsedMs: 1000 / 120, carriedCharCredit: 0 }
    )
    const second = resolveStreamPaceBudget(
      { backlogChars: 10, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      {
        elapsedMs: 1000 / 120,
        carriedCharCredit: first.availableCharCredit - first.charBudget,
      }
    )

    assert.equal(first.charBudget, 0)
    assert.equal(second.charBudget, 1)
  })

  void test('drops stale credit when no text is waiting', () => {
    const budget = resolveStreamPaceBudget(
      { backlogChars: 0, backlogEvents: 2 },
      DefaultStreamPaceTuning,
      { elapsedMs: 16, carriedCharCredit: 6 }
    )

    assert.deepEqual(budget, {
      charBudget: 0,
      eventBudget: 1,
      availableCharCredit: 0,
    })
  })
})
