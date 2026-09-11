import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  createStreamPaceMotion,
  DefaultStreamPaceTuning,
  resolveStreamPaceBudget,
  resolveStreamPaceTargetRate,
  type StreamPaceMotion,
} from '../../packages/ui/src/conversation/stream/streamPaceBudget'

interface PaceTrace {
  emittedChars: number
  rates: number[]
  /** 每帧吐完之后还剩多少字。 */
  remaining: number[]
}

/** 按固定帧间隔吐完一段积压（或跑满时长），记下每帧的速度。 */
function simulate(
  frameIntervalMs: number,
  durationMs: number,
  arrivals: (frame: number) => number
): PaceTrace {
  let carriedCharCredit = 0
  let motion: StreamPaceMotion = createStreamPaceMotion()
  let backlogChars = 0
  let emittedChars = 0
  const rates: number[] = []
  const remaining: number[] = []
  const frameCount = Math.floor(durationMs / frameIntervalMs)

  for (let frame = 0; frame < frameCount; frame += 1) {
    backlogChars += arrivals(frame)
    const budget = resolveStreamPaceBudget(
      { backlogChars, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      { elapsedMs: frameIntervalMs, carriedCharCredit, motion }
    )
    motion = budget.motion
    backlogChars -= budget.charBudget
    emittedChars += budget.charBudget
    carriedCharCredit = budget.availableCharCredit - budget.charBudget
    rates.push(motion.charsPerSecond)
    remaining.push(backlogChars)
  }

  return { emittedChars, rates, remaining }
}

void describe('chat stream elapsed-time pace budget', () => {
  void test('keeps the same visible rate across 60Hz and 120Hz frame schedules', () => {
    const emitted = (frameIntervalMs: number): number =>
      simulate(frameIntervalMs, 2_000, (frame) => (frame === 0 ? 100_000 : 0)).emittedChars
    const at60Hz = emitted(1000 / 60)
    const at120Hz = emitted(1000 / 120)

    assert.ok(Math.abs(at60Hz - at120Hz) <= at60Hz * 0.01, `${at60Hz} vs ${at120Hz}`)
  })

  void test('never converts a long blocked frame into a large catch-up burst', () => {
    const fromRest = resolveStreamPaceBudget(
      { backlogChars: 100_000, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      { elapsedMs: 5_000, carriedCharCredit: 0 }
    )
    // 从静止起步：长帧只按上限计时，速度也不会一帧里跳到最高。
    assert.ok(fromRest.charBudget <= 4, `${fromRest.charBudget}`)

    const atFullSpeed = resolveStreamPaceBudget(
      { backlogChars: 100_000, backlogEvents: 0 },
      DefaultStreamPaceTuning,
      {
        elapsedMs: 5_000,
        carriedCharCredit: DefaultStreamPaceTuning.maxCharsPerFrame,
        motion: { charsPerSecond: DefaultStreamPaceTuning.maxCharsPerSecond, acceleration: 0 },
      }
    )
    assert.equal(atFullSpeed.charBudget, DefaultStreamPaceTuning.maxCharsPerFrame)
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
        motion: first.motion,
      }
    )

    assert.equal(first.charBudget, 0)
    assert.equal(second.charBudget, 1)
  })

  void test('drops stale credit and speed when no text is waiting', () => {
    const budget = resolveStreamPaceBudget(
      { backlogChars: 0, backlogEvents: 2 },
      DefaultStreamPaceTuning,
      { elapsedMs: 16, carriedCharCredit: 6, motion: { charsPerSecond: 500, acceleration: 900 } }
    )

    assert.deepEqual(budget, {
      charBudget: 0,
      eventBudget: 1,
      availableCharCredit: 0,
      motion: createStreamPaceMotion(),
    })
  })
})

void describe('chat stream speed controller', () => {
  void test('a small backlog types at the steady base speed', () => {
    assert.equal(resolveStreamPaceTargetRate(0), DefaultStreamPaceTuning.baseCharsPerSecond)
    assert.equal(resolveStreamPaceTargetRate(40), DefaultStreamPaceTuning.baseCharsPerSecond)

    // 平时 60 字/秒的输出：一直是基础速度，不忽快忽慢。
    const trace = simulate(1000 / 60, 3_000, (frame) => (frame % 10 === 0 ? 10 : 0))
    assert.ok(trace.rates.every((rate) => rate === DefaultStreamPaceTuning.baseCharsPerSecond))
  })

  void test('a big backlog speeds up smoothly, then slows back down to the base speed before it runs out', () => {
    const trace = simulate(1000 / 60, 12_000, (frame) => (frame === 0 ? 3_000 : 0))
    assert.equal(trace.emittedChars, 3_000)

    const peak = Math.max(...trace.rates)
    assert.ok(peak >= 600, `speeds up to catch up (peak ${peak})`)
    // 速度连续：任意相邻两帧的速度差都很小，没有突变。
    for (let frame = 1; frame < trace.rates.length; frame += 1) {
      const step = Math.abs(trace.rates[frame] - trace.rates[frame - 1])
      assert.ok(step <= 25, `frame ${frame} jumps by ${step} chars/s`)
    }
    // 起步是从基础速度慢慢加上去的。
    assert.ok(trace.rates[0] < 110, `starts near the base speed (${trace.rates[0]})`)
    // 最后几句回到平时的节奏，而不是高速戛然而止。
    const nearEnd = trace.remaining.findIndex((left) => left <= 20)
    assert.ok(trace.rates[nearEnd] <= 115, `ends near the base speed (${trace.rates[nearEnd]})`)
  })

  void test('steady fast output is followed at its own speed with about a second of lag', () => {
    // 600 字/秒的快模型：每 100ms 到 60 字。
    const trace = simulate(1000 / 60, 6_000, (frame) => (frame % 6 === 0 ? 60 : 0))
    const settled = trace.rates.slice(-60)
    const averageRate = settled.reduce((sum, rate) => sum + rate, 0) / settled.length
    const averageLag = trace.remaining.slice(-60).reduce((sum, left) => sum + left, 0) / 60

    assert.ok(Math.abs(averageRate - 600) <= 40, `follows the output speed (${averageRate})`)
    assert.ok(averageLag / 600 <= 1.5, `lags about a second (${(averageLag / 600).toFixed(2)}s)`)
  })
})
