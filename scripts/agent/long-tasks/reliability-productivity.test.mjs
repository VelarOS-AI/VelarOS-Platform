import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ProductivityLedger } from './reliability-productivity.mjs'

function events(overrides = []) {
  return [
    { type: 'start' },
    { type: 'ack', elapsedMs: 10 },
    { type: 'work', kind: 'transaction', startMs: 0, endMs: 10, elapsedMs: 10 },
    { type: 'idle', startMs: 10, endMs: 160, elapsedMs: 160 },
    { type: 'verified', elapsedMs: 170 },
    { type: 'work', kind: 'verification', startMs: 160, endMs: 170, elapsedMs: 170 },
    { type: 'end', elapsedMs: 175 },
    ...overrides,
  ]
}
function check(input, claimed) {
  const ledger = new ProductivityLedger()
  for (const event of input) ledger.add(event)
  return ledger.finish(claimed)
}

test('real work, explicit idle and unclaimed shutdown reconcile without counting waits', () => {
  assert.deepEqual(check(events(), 20), {
    productiveMs: 20,
    workIntervals: 2,
    excludedExplicitIdleMs: 150,
    segmentElapsedMs: 175,
    structuralTimeVerified: true,
    actualWorkVerified: false,
  })
})
test('the original wall-time-as-productivity failure is rejected', () => {
  assert.throws(() => check(events(), 175), /excluding idle/)
  assert.throws(() => check(events(), 170), /excluding idle/)
})
test('overlapping or duplicated work cannot inflate the total', () => {
  const input = events().slice(0, 3)
  input.push({ type: 'work', kind: 'transaction', startMs: 0, endMs: 10, elapsedMs: 10 })
  assert.throws(() => check(input, 20), /nonoverlapping/)
})
test('an adjacent interval cannot reuse the preceding acknowledgement as new progress', () => {
  const input = events().slice(0, 3)
  input.push({ type: 'work', kind: 'transaction', startMs: 10, endMs: 20, elapsedMs: 20 })
  assert.throws(() => check(input, 20), /observed progress/)
})
test('a work interval must have actual matching progress inside its own bounds', () => {
  for (const kind of ['transaction', 'verification', 'fault']) {
    assert.throws(
      () => check([{ type: 'work', kind, startMs: 0, endMs: 10, elapsedMs: 10 }], 10),
      /observed progress/
    )
  }
  assert.throws(
    () =>
      check(
        [
          { type: 'ack', elapsedMs: 5 },
          { type: 'work', kind: 'transaction', startMs: 6, endMs: 10, elapsedMs: 10 },
        ],
        4
      ),
    /observed progress/
  )
})
test('fault work includes recovery verification and cannot reuse an earlier recovery', () => {
  const input = [
    { type: 'fault', elapsedMs: 5 },
    { type: 'verified', elapsedMs: 9 },
    { type: 'work', kind: 'fault', startMs: 0, endMs: 10, elapsedMs: 10 },
  ]
  assert.equal(check(input, 10).productiveMs, 10)
  assert.throws(() => check([input[0], input[2]], 10), /observed progress/)
  assert.throws(
    () =>
      check(
        [
          { type: 'verified', elapsedMs: 2 },
          { type: 'fault', elapsedMs: 7 },
          { type: 'work', kind: 'fault', startMs: 5, endMs: 10, elapsedMs: 10 },
        ],
        5
      ),
    /observed progress/
  )
})
test('a segment containing only idle or zero-duration intervals is insufficient', () => {
  assert.throws(
    () => check([{ type: 'idle', startMs: 0, endMs: 100, elapsedMs: 100 }], 100),
    /productive intervals/
  )
  assert.throws(
    () =>
      check(
        [
          { type: 'ack', elapsedMs: 0 },
          { type: 'work', kind: 'transaction', startMs: 0, endMs: 0, elapsedMs: 0 },
        ],
        0
      ),
    /productive intervals/
  )
})
test('invalid, future and decreasing time are rejected', () => {
  for (const value of [-1, NaN, Infinity, 1.5])
    assert.throws(() => check([{ type: 'ack', elapsedMs: value }], value), /integer milliseconds/)
  assert.throws(
    () =>
      check(
        [
          { type: 'ack', elapsedMs: 3 },
          { type: 'verified', elapsedMs: 2 },
        ],
        3
      ),
    /Monotonic/
  )
  assert.throws(
    () =>
      check(
        [
          { type: 'ack', elapsedMs: 10 },
          { type: 'work', kind: 'transaction', startMs: 0, endMs: 11, elapsedMs: 10 },
        ],
        11
      ),
    /extend past/
  )
  assert.throws(
    () =>
      check(
        [
          { type: 'ack', elapsedMs: 10 },
          { type: 'work', kind: 'waiting-for-model', startMs: 0, endMs: 10, elapsedMs: 10 },
        ],
        10
      ),
    /Unknown productive/
  )
})
test('actual monotonic CPU work plus actual sleep keep separate measured totals', async () => {
  const start = performance.now(),
    clock = () => Math.floor(performance.now() - start)
  const ledger = new ProductivityLedger()
  const begin = clock()
  let digest = 'seed'
  while (clock() - begin < 25) digest = createHash('sha256').update(digest).digest('hex')
  const computed = clock()
  ledger.add({ type: 'verified', elapsedMs: computed })
  ledger.add({
    type: 'work',
    kind: 'verification',
    startMs: begin,
    endMs: computed,
    elapsedMs: computed,
  })
  await delay(30)
  const ended = clock()
  ledger.add({ type: 'idle', startMs: computed, endMs: ended, elapsedMs: ended })
  const result = ledger.finish(computed - begin)
  assert(result.productiveMs >= 25)
  assert(result.excludedExplicitIdleMs >= 20)
  assert(result.productiveMs < result.segmentElapsedMs)
  assert.equal(digest.length, 64)
})
