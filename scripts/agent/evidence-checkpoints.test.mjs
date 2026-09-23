import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEvidenceCheckpoints } from './evidence-checkpoints.mjs'

test('rapid turns share checkpoint work while finalization captures late background state', async () => {
  let state = 1,
    release,
    now = 0
  const snapshots = []
  const checkpoints = createEvidenceCheckpoints(
    async () => {
      snapshots.push(state)
      if (snapshots.length === 1)
        await new Promise((resolve) => {
          release = resolve
        })
    },
    { now: () => now }
  )
  const first = checkpoints.request()
  await Promise.resolve()
  const repeated = Array.from({ length: 40 }, () => checkpoints.request())
  assert(repeated.every((promise) => promise === first))
  const final = checkpoints.flush()
  state = 2
  release()
  await Promise.all([first, final, ...repeated])
  assert.deepEqual(snapshots, [1, 2])
  await checkpoints.request()
  assert.equal(snapshots.length, 2)
  now = 2001
  await checkpoints.request()
  assert.deepEqual(snapshots, [1, 2, 2])
  assert.equal(checkpoints.stats.coalesced, 40)
})

test('final export retries after an in-flight failure while preserving that error', async () => {
  const failure = Error('disk failure')
  let reject,
    calls = 0
  const checkpoints = createEvidenceCheckpoints(async () => {
    if (++calls === 1)
      await new Promise((_resolve, fail) => {
        reject = fail
      })
  })
  const first = assert.rejects(checkpoints.request(), (error) => error === failure)
  await Promise.resolve()
  const final = assert.rejects(checkpoints.flush(), (error) => error === failure)
  reject(failure)
  await Promise.all([first, final])
  assert.equal(calls, 2)
  await checkpoints.flush()
  assert.equal(calls, 3)
})

test('final export preserves a falsy rejection reason', async () => {
  let reject,
    calls = 0
  const checkpoints = createEvidenceCheckpoints(async () => {
    if (++calls === 1)
      await new Promise((_resolve, fail) => {
        reject = fail
      })
  })
  const check = (promise) =>
    promise.then(
      () => assert.fail('expected rejection'),
      (error) => assert.equal(error, null)
    )
  const first = check(checkpoints.request())
  await Promise.resolve()
  const final = check(checkpoints.flush())
  reject(null)
  await Promise.all([first, final])
  assert.equal(calls, 2)
})
