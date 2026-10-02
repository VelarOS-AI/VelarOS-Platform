import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal, createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'

function fixture() {
  const storage = localContextStorage({ path: ':memory:' })
  const context = createContextRuntime({ sessionId: 's', storage })
  const journal = createContextInvocationJournal(storage)
  const trace = new RuntimeTrace('s', storage, journal)
  const add = (title, value) =>
    context.append({ kind: 'audit', title, body: JSON.stringify(value) })
  const start = async (kind = 'snapshot-capture') => {
    const executionId = crypto.randomUUID()
    const record = await add(`script:execution:${executionId}`, {
      executionId,
      taskId: 'task',
      mode: 'observe',
      ...(kind === 'snapshot-capture' ? { kind } : {}),
    })
    const prepared = {
      id: `${executionId}:1`,
      sessionId: 's',
      executionId,
      mode: 'observe',
      binding: {
        moduleId: 'velaros:project',
        instanceId: 'project',
        generation: 1,
        schemaRevision: '1',
      },
      operation: 'snapshot',
      input: { paths: ['out.json'] },
      inputFingerprint: 'input',
      requestFingerprint: 'request',
    }
    await journal.claim(prepared)
    await journal.prepare(prepared)
    return { executionId, record, prepared }
  }
  return { storage, add, start, journal, trace }
}

test('session activity exposes real storage and prepared journal without a model request', async () => {
  const f = fixture()
  try {
    const capture = await f.start()
    const page = await f.trace.page({ fullContent: true })
    assert.deepEqual(page.turns, [])
    assert.equal(page.nextAfter, null)
    assert.deepEqual(page.accounting.modelRequests, { known: 0, unknown: 0, inflight: 0 })
    assert.equal(page.sessionActivity.scope, 'session')
    assert.equal(page.sessionActivity.snapshotVersion, page.snapshotVersion)
    const entry = page.sessionActivity.entries[0]
    assert.equal(entry.executionId, capture.executionId)
    assert.equal(entry.taskId, 'task')
    assert.equal(entry.mode, 'observe')
    assert.equal(entry.kind, 'snapshot-capture')
    assert.equal(entry.startedSequence, capture.record.sequence)
    assert.deepEqual(entry.startRef, capture.record.ref)
    assert.equal(entry.resultRef, null)
    assert.ok(entry.records[0].body.includes(capture.executionId))
    assert.equal(entry.invocations[0].summary.status, 'pending')
    assert.equal(entry.invocations[0].summary.effect, 'unknown')
  } finally {
    await f.storage.close()
  }
})

test('pre-request and unsent post-response activity stays separate from frozen model turns', async () => {
  const f = fixture()
  try {
    const before = await f.start()
    const request = await f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
    await f.add('model-response', { status: 'accepted' })
    const after = await f.start()
    const page = await f.trace.page({ fullContent: true })
    assert.equal(page.turns.length, 1)
    assert.equal(page.turns[0].turnId, request.ref.id)
    assert.deepEqual(page.turns[0].invocations, [])
    assert.equal(page.turns[0].observation.run, null)
    assert.deepEqual(
      page.sessionActivity.entries.map((entry) => entry.executionId),
      [before.executionId, after.executionId]
    )
    assert.equal(JSON.parse(page.turns[0].request.body).request, undefined)
  } finally {
    await f.storage.close()
  }
})

test('cancelled host result is immutable while an old activity page rereads late journal facts', async () => {
  const f = fixture()
  try {
    const capture = await f.start()
    const result = await f.add(`script:${capture.executionId}:result`, {
      executionId: capture.executionId,
      kind: 'snapshot-capture',
      mode: 'observe',
      checked: true,
      result: { failed: { code: 'CANCELLED', message: 'caller stopped before IO settled' } },
    })
    const pending = await f.trace.page({ activityLimit: 1, fullContent: true })
    assert.equal(pending.sessionActivity.entries[0].invocations[0].summary.status, 'pending')
    assert.deepEqual(pending.sessionActivity.entries[0].resultRef, result.ref)
    await f.journal.settle({
      invocation: capture.prepared,
      outcome: 'cancelled',
      effect: 'none',
      retry: 'safe',
      diagnostic: {
        code: 'PROJECT_SNAPSHOT_COST',
        message: JSON.stringify({ readRequests: 1, materialBytes: 53 }),
      },
    })
    const late = await f.trace.page({ activityLimit: 1, fullContent: true })
    assert.equal(late.snapshotVersion, pending.snapshotVersion)
    assert.equal(late.sessionActivity.entries[0].invocations[0].id, capture.prepared.id)
    assert.equal(late.sessionActivity.entries[0].invocations[0].summary.status, 'cancelled')
    assert.equal(late.sessionActivity.entries[0].invocations[0].summary.effect, 'none')
    assert.ok(late.sessionActivity.entries[0].invocations[0].body.includes('PROJECT_SNAPSHOT_COST'))
    assert.equal(
      late.sessionActivity.entries[0].records.find((record) => record.ref.id === result.ref.id)
        .body,
      pending.sessionActivity.entries[0].records.find((record) => record.ref.id === result.ref.id)
        .body
    )
    assert.deepEqual(late.turns, [])
  } finally {
    await f.storage.close()
  }
})

test('activity uses its own prelude cursor and shares the text budget with model turns', async () => {
  const f = fixture()
  try {
    const a = await f.start()
    const b = await f.start('script-execution')
    const c = await f.start()
    const request = await f.add('model-request', {
      runId: 'run',
      turn: 0,
      repair: 0,
      padding: 'x'.repeat(1000),
    })
    const one = await f.trace.page({ activityLimit: 1, fullContent: true })
    assert.deepEqual(
      one.sessionActivity.entries.map((entry) => entry.executionId),
      [a.executionId]
    )
    assert.equal(one.sessionActivity.nextAfter, a.record.sequence)
    assert.equal(one.nextAfter, null)
    const two = await f.trace.page({
      after: request.sequence,
      activityAfter: one.sessionActivity.nextAfter,
      activityLimit: 1,
      fullContent: true,
    })
    assert.deepEqual(two.turns, [])
    assert.deepEqual(
      two.sessionActivity.entries.map((entry) => entry.executionId),
      [b.executionId]
    )
    assert.equal(two.sessionActivity.entries[0].kind, 'script-execution')
    const three = await f.trace.page({
      after: request.sequence,
      activityAfter: two.sessionActivity.nextAfter,
      activityLimit: 1,
      fullContent: true,
    })
    assert.deepEqual(
      three.sessionActivity.entries.map((entry) => entry.executionId),
      [c.executionId]
    )
    assert.equal(three.sessionActivity.nextAfter, null)
    const tiny = await f.trace.page({ maxChars: 1, activityLimit: 3 })
    const turnChars = tiny.turns.reduce(
      (sum, turn) =>
        sum +
        [turn.request, turn.response, turn.decision, ...turn.records, ...turn.invocations].reduce(
          (n, item) => n + (item?.body?.length ?? 0),
          0
        ),
      0
    )
    const activityChars = tiny.sessionActivity.entries.reduce(
      (sum, entry) =>
        sum +
        entry.records.reduce((n, record) => n + (record.body?.length ?? 0), 0) +
        entry.invocations.reduce(
          (n, call) =>
            n + call.body.length + call.summary.input.length + call.summary.output.length,
          0
        ),
      0
    )
    assert.ok(turnChars + activityChars <= 1)
    assert.equal(tiny.sessionActivity.entries.length, 3)
    assert.ok(tiny.sessionActivity.entries.every((entry) => entry.records[0].truncated))
    await assert.rejects(f.trace.page({ activityAfter: -1 }), { code: 'VALIDATION' })
    await assert.rejects(f.trace.page({ activityLimit: 33 }), { code: 'VALIDATION' })
  } finally {
    await f.storage.close()
  }
})
