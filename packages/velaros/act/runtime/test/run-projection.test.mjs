import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createActEventProjector } from '../../../dist/act/runtime/renderer.js'

const ref = (id) => ({ sessionId: 'session', id })
const input = (id, source = 'steer', inputId = id) => ({
  type: 'input',
  runId: 'run',
  ref: ref(id),
  source,
  inputId,
})
const receipt = (type, id, inputId = id) => ({
  type,
  runId: 'run',
  ref: ref(id),
  inputId,
  ...(type === 'input-applied' ? { turnId: 'turn-one' } : {}),
})

test('INV-44 live and durable run projections agree on turns, queued inputs and explicit retained receipts', () => {
  const events = [
    input('root', 'submit'),
    input('guide'),
    { type: 'turn', runId: 'run', turnId: 'turn-one' },
    receipt('input-applied', 'root'),
    receipt('input-applied', 'guide'),
    input('next'),
    receipt('input-retained', 'next'),
    { type: 'state', runId: 'run', status: 'cancelled' },
  ]
  const live = createActEventProjector()
  const replay = createActEventProjector()
  events.forEach((event, index) => {
    live.applyLive(event)
    replay.apply({ sessionId: 'session', runId: 'run', sequence: index * 3 + 2, event })
  })
  assert.deepEqual(live.snapshot().runs, replay.snapshot().runs)
  const state = live.snapshot().runs.run
  assert.equal(state.turn, 1)
  assert.equal(state.status, 'cancelled')
  assert.deepEqual(state.queuedInputIds, ['next'])
  assert.deepEqual(state.retainedInputIds, ['next'])
  assert.equal(live.snapshot().cursor, 0)
  assert.equal(replay.snapshot().cursor, 23)
})

test('throttle and stall notices show while they apply and clear on the next turn or a terminal state', () => {
  const p = createActEventProjector()
  p.applyLive({ type: 'turn', runId: 'run', turnId: 'turn-one' })
  p.applyLive({ type: 'throttled', runId: 'run', retryAfterMs: 1200 })
  assert.deepEqual(p.snapshot().runs.run.notice, { kind: 'throttled', retryAfterMs: 1200 })
  p.applyLive({ type: 'turn', runId: 'run', turnId: 'turn-two' })
  assert.equal('notice' in p.snapshot().runs.run, false)
  const stall = { type: 'stalled', runId: 'run', repeatedSteps: 9, message: 'paused' }
  p.applyLive(stall)
  p.applyLive({ type: 'state', runId: 'run', status: 'waiting' })
  // 暂停等用户时提示保留；运行结束才清除
  assert.deepEqual(p.snapshot().runs.run.notice, {
    kind: 'stalled',
    repeatedSteps: 9,
    message: 'paused',
  })
  const other = createActEventProjector()
  other.applyLive({ type: 'throttled', runId: 'run', retryAfterMs: 5 })
  other.applyLive({ type: 'state', runId: 'run', status: 'cancelled' })
  assert.equal('notice' in other.snapshot().runs.run, false)
})

test('the last failed completion check stays on the run so hosts can explain how it ended', () => {
  const p = createActEventProjector()
  const check = (completed, reason, recovery) => ({
    type: 'verification',
    runId: 'run',
    completed,
    verified: false,
    reason,
    ...(recovery ? { recovery } : {}),
  })
  p.applyLive(check(false, 'GOAL_ACTIVE: 目标仍在推进', 'repair'))
  assert.deepEqual(p.snapshot().runs.run.verification, {
    reason: 'GOAL_ACTIVE: 目标仍在推进',
    recovery: 'repair',
  })
  p.applyLive(check(true, 'ok'))
  assert.equal(p.snapshot().runs.run.verification, undefined)
  p.applyLive(check(false, 'STALE_VIEW', 'refresh'))
  p.applyLive({ type: 'state', runId: 'run', status: 'failed' })
  assert.equal(p.snapshot().runs.run.verification.reason, 'STALE_VIEW')
})

test('an end state an older version stored as needs_reconcile reads as failed', () => {
  const projector = createActEventProjector()
  projector.applyLive({ type: 'state', runId: 'old', status: 'needs_reconcile' })
  assert.equal(projector.snapshot().runs.old.status, 'failed')
})

test('duplicate turns cannot count twice or rewind the active preview', () => {
  const projector = createActEventProjector()
  projector.applyLive({ type: 'turn', runId: 'run', turnId: 'one' })
  projector.applyLive({ type: 'turn', runId: 'run', turnId: 'two' })
  projector.applyLive({ type: 'text', runId: 'run', text: 'current' })
  const before = projector.snapshot()
  for (const turnId of ['one', 'two'])
    assert.deepEqual(projector.applyLive({ type: 'turn', runId: 'run', turnId }), before)
  assert.equal(before.runs.run.turn, 2)
  assert.equal(before.runs.run.turnId, 'two')
})

test('input receipt identity is its archival reference, while displayed host identities are deduplicated', () => {
  const p = createActEventProjector()
  p.applyLive(input('a', 'steer', 'same'))
  p.applyLive(input('b', 'steer', 'same'))
  p.applyLive(receipt('input-applied', 'a', 'same'))
  assert.deepEqual(p.snapshot().runs.run.queuedInputIds, ['same'])
  p.applyLive(receipt('input-retained', 'b', 'same'))
  assert.deepEqual(p.snapshot().runs.run.retainedInputIds, ['same'])
  p.applyLive(receipt('input-applied', 'b', 'same'))
  const state = p.snapshot()
  assert.deepEqual(state.runs.run.queuedInputIds, [])
  assert.deepEqual(state.runs.run.retainedInputIds, [])
  p.applyLive(input('a', 'steer', 'same'))
  p.applyLive(receipt('input-retained', 'b', 'same'))
  assert.deepEqual(p.snapshot(), state)
})

test('cancel and delivery finish do not infer retained identities from accepted inputs', () => {
  for (const terminal of ['cancelled', 'failed', undefined]) {
    const p = createActEventProjector()
    p.applyLive(input('root', 'submit'))
    p.applyLive(input('guide'))
    assert.deepEqual(p.snapshot().runs.run.queuedInputIds, ['guide'])
    if (terminal) p.applyLive({ type: 'state', runId: 'run', status: terminal })
    p.finish()
    assert.deepEqual(p.snapshot().runs.run.retainedInputIds, [])
  }
})

test('root input becomes queued only on retained receipt; protocol rejection is not a runtime failure', () => {
  const p = createActEventProjector()
  p.applyLive(input('root', 'submit'))
  assert.deepEqual(p.snapshot().runs.run.queuedInputIds, [])
  p.applyLive(receipt('input-retained', 'root'))
  assert.deepEqual(p.snapshot().runs.run.queuedInputIds, ['root'])
  p.applyLive({ type: 'rejected', runId: 'run', turnId: 'one', message: 'repair protocol' })
  assert.equal(p.snapshot().runs.run.failure, undefined)
  p.applyLive({ type: 'error', runId: 'run', message: 'provider failed' })
  assert.equal(p.snapshot().runs.run.failure, 'provider failed')
  p.applyLive({ type: 'state', runId: 'run', status: 'failed' })
  const ended = p.snapshot()
  p.applyLive(receipt('input-applied', 'root'))
  assert.deepEqual(p.snapshot(), ended)
})

test('INV-44 an error the run recovers from stops being its failure once a later turn is accepted', () => {
  const p = createActEventProjector()
  p.applyLive({ type: 'turn', runId: 'run', turnId: 'one' })
  p.applyLive({ type: 'rejected', runId: 'run', turnId: 'one', message: 'no decision' })
  p.applyLive({ type: 'error', runId: 'run', message: '协议未通过，正在修复：no decision' })
  assert.equal(p.snapshot().runs.run.failure, '协议未通过，正在修复：no decision')
  p.applyLive({ type: 'turn', runId: 'run', turnId: 'two' })
  p.applyLive({ type: 'accepted', runId: 'run', turnId: 'two', text: 'done', ref: ref('answer') })
  assert.equal(p.snapshot().runs.run.failure, undefined)
  assert.deepEqual(p.snapshot().runs.run.errors, [
    'no decision',
    '协议未通过，正在修复：no decision',
  ])
  // 之后没有回合再被接纳的 error 照旧留着，宿主据此说明运行为什么停下
  p.applyLive({ type: 'error', runId: 'run', message: '任务的模型用量已到上限，已暂停' })
  p.applyLive({ type: 'state', runId: 'run', status: 'waiting' })
  assert.equal(p.snapshot().runs.run.failure, '任务的模型用量已到上限，已暂停')
})

test('runs remain isolated and snapshots cannot mutate internal input facts', () => {
  const p = createActEventProjector()
  p.applyLive(input('guide'))
  p.applyLive({ ...receipt('input-applied', 'guide'), runId: 'other' })
  assert.deepEqual(p.snapshot().runs.run.queuedInputIds, ['guide'])
  assert.deepEqual(p.snapshot().runs.other.queuedInputIds, [])
  const state = p.snapshot()
  state.runs.run.queuedInputIds.length = 0
  assert.deepEqual(p.snapshot().runs.run.queuedInputIds, ['guide'])
})
