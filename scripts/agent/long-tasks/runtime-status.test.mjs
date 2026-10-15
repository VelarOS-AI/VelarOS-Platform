import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runtimeEventStatus } from './runtime-status.mjs'

const summarize = (events) =>
  events.reduce(runtimeEventStatus, { status: 'starting', failure: null })

test('a blocked completion reports its actual reason after an earlier recovered protocol error', () => {
  const events = [
    { type: 'error', message: 'Invalid exec options; recovering' },
    { type: 'state', status: 'executing' },
    { type: 'verification', verified: false, reason: 'Independent review incomplete: terminated' },
    { type: 'state', status: 'waiting' },
  ]
  assert.deepEqual(summarize(events), {
    status: 'waiting',
    failure: 'Independent review incomplete: terminated',
  })
  assert.equal(events[0].message, 'Invalid exec options; recovering')
})

test('successful completion clears recovered errors while a later failure or input request wins', () => {
  const events = [
    { type: 'error', message: 'Recoverable error' },
    { type: 'state', status: 'completed' },
  ]
  assert.deepEqual(summarize(events), { status: 'completed', failure: null })
  assert.deepEqual(
    summarize([
      { type: 'verification', verified: false, reason: 'Delivery gap' },
      { type: 'error', message: 'Storage closed' },
      { type: 'state', status: 'failed' },
    ]),
    { status: 'failed', failure: 'Storage closed' }
  )
  assert.equal(
    summarize([...events, { type: 'interaction' }]).failure,
    'Unattended task requested input'
  )
})
