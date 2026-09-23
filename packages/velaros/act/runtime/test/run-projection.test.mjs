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
