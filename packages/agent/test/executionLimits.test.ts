import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  DefaultAgentExecutionLimits,
  resolveAgentExecutionLimits,
} from '../src/agent/ExecutionLimits'
import { LoopWindDownGuard } from '../src/agent/LoopSurface'

void describe('agent execution limits', () => {
  void test('defaults to long-running wall clocks and unlimited turns', () => {
    assert.deepEqual(resolveAgentExecutionLimits(), {
      standardExecutionWallClockTimeoutMs: 24 * 60 * 60_000,
      goalExecutionWallClockTimeoutMs: 7 * 24 * 60 * 60_000,
      primaryMaxTurns: null,
      subAgentSoftDeadlineMs: 4 * 60 * 60_000,
      subAgentMaxTurns: null,
      modelStreamIdleTimeoutMs: 5 * 60_000,
    })
    assert.equal(DefaultAgentExecutionLimits.primaryMaxTurns, null)
    assert.equal(DefaultAgentExecutionLimits.subAgentMaxTurns, null)
  })

  void test('accepts a host-provided finite override snapshot', () => {
    assert.deepEqual(
      resolveAgentExecutionLimits({
        standardExecutionWallClockTimeoutMs: 60_000,
        goalExecutionWallClockTimeoutMs: 120_000,
        primaryMaxTurns: 12,
        subAgentSoftDeadlineMs: 30_000,
        subAgentMaxTurns: 8,
        modelStreamIdleTimeoutMs: 15_000,
      }),
      {
        standardExecutionWallClockTimeoutMs: 60_000,
        goalExecutionWallClockTimeoutMs: 120_000,
        primaryMaxTurns: 12,
        subAgentSoftDeadlineMs: 30_000,
        subAgentMaxTurns: 8,
        modelStreamIdleTimeoutMs: 15_000,
      }
    )
  })

  void test('rejects a Goal wall clock shorter than the standard wall clock', () => {
    assert.throws(
      () =>
        resolveAgentExecutionLimits({
          standardExecutionWallClockTimeoutMs: 120_000,
          goalExecutionWallClockTimeoutMs: 60_000,
        }),
      /goalExecutionWallClockTimeoutMs 不得小于/u
    )
  })

  void test('keeps the time deadline effective when the turn cap is disabled', () => {
    const guard = new LoopWindDownGuard({
      hardCapTurns: Number.POSITIVE_INFINITY,
      disabled: true,
      deadlineAt: Date.now() - 1,
    })

    assert.equal(guard.tickTurnStart(1), 'time-deadline')
    assert.equal(guard.recordToolUseTurn(), false)
    assert.equal(guard.recordToolUseTurn(), true)
  })
})
