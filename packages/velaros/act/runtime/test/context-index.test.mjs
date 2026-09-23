import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { ActRuntimeTuning } from '../../../dist/act/runtime/utils/tuning.js'

async function fixture(t, mode = 'indexed') {
  const root = await mkdtemp(join(tmpdir(), 'runtime-index-'))
  const path = join(root, 'context.sqlite')
  const storage = localContextStorage({ path })
  t.after(async () => {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  const port =
    mode === 'indexed' || mode === 'legacy-selector'
      ? storage
      : {
          load: (...args) => storage.load(...args),
          compareAndSwap: (...args) => storage.compareAndSwap(...args),
          put: (...args) => storage.put(...args),
          get: (...args) => storage.get(...args),
          close: () => storage.close(),
          ...(mode === 'read-only-index'
            ? { selectSnapshot: (...args) => storage.selectSnapshot(...args) }
            : {}),
        }
  if (mode === 'legacy-selector') {
    const select = storage.selectSnapshot.bind(storage)
    t.mock.method(storage, 'selectSnapshot', (id, queries) =>
      select(
        id,
        queries.map((query) =>
          Object.fromEntries(
            Object.entries(query).filter(
              ([key]) => !['titleSuffix', 'sequence', 'last', 'latestPerTitle'].includes(key)
            )
          )
        )
      )
    )
  }
  const context = createContextRuntime({ sessionId: 's', storage: port })
  const goal = await context.append({ kind: 'user', body: 'goal' })
  const view = createContextView({ sessionId: 's', storage: port, context, sources: [] })
  await view.begin(goal.ref)
  const programs = new ProgramContext('s', context, port)
  const memory = new ContextMemory('s', context, port, view, programs, {})
  return { storage, port, context, view, programs, memory, goal, path }
}
const signal = () => new AbortController().signal

for (const mode of ['indexed', 'fallback', 'read-only-index', 'legacy-selector'])
  test(`${mode}: program commits and notes preserve conflict, replay and task reset semantics`, async (t) => {
    const f = await fixture(t, mode)
    if (mode === 'indexed')
      t.mock.method(f.storage, 'load', () => {
        throw Error('unexpected full snapshot')
      })
    await Promise.all([
      f.programs.observeHealth('source', 'one', false, false),
      f.programs.observeHealth('source', 'two', false, false),
    ])
    assert.equal((await f.programs.state()).health.failures, 2)
    const control = { id: crypto.randomUUID(), fingerprint: 'same', expectedObservation: null }
    const receipt = { status: 'prepared', executed: false }
    const published = await Promise.all([
      f.programs.publish([], control, receipt, false, false, signal()),
      f.programs.publish([], control, receipt, false, false, signal()),
    ])
    assert.equal(published.filter((result) => result.claimed).length, 1)
    await f.programs.finish(control, { status: 'completed', executed: true })
    assert.equal((await f.programs.receipt(control)).status, 'completed')
    await assert.rejects(f.programs.receipt({ ...control, fingerprint: 'different' }), {
      code: 'SCRIPT_CALL_CONFLICT',
    })
    const note = await f.memory.update(
      { key: 'plan', baseRevision: 0, body: 'first', sources: [f.goal.ref] },
      signal()
    )
    const writes = await Promise.allSettled([
      f.memory.update({ key: 'plan', baseRevision: 1, body: 'left' }, signal()),
      f.memory.update({ key: 'plan', baseRevision: 1, body: 'right' }, signal()),
    ])
    assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(
      writes.find((result) => result.status === 'rejected').reason.code,
      'WORKSPACE_CONFLICT'
    )
    assert.equal((await f.memory.list({}, signal())).items[0].revision, 2)
    assert.equal(JSON.parse((await f.memory.read(note.ref, 0, 10000, signal())).text).body, 'first')
    const frame = await f.context.append({
      kind: 'audit',
      title: 'context:frame:one',
      body: JSON.stringify({ frameId: 'one', entries: [] }),
    })
    await f.memory.acknowledge('one', signal())
    await f.memory.acknowledge('one', signal())
    assert.equal((await f.storage.records('s', { title: 'context:delivered' })).items.length, 1)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(f.memory.acknowledge('one', controller.signal), { name: 'AbortError' })
    assert.equal((await f.storage.records('s', { refId: frame.ref.id })).items.length, 1)
    await f.view.end('completed')
    const next = await f.context.append({ kind: 'user', body: 'new task' })
    await f.view.begin(next.ref, signal(), 'new')
    assert.deepEqual(await f.programs.state(), { completedTurns: 0, leases: [] })
    assert.deepEqual((await f.memory.list({}, signal())).items, [])
    await assert.rejects(
      f.memory.update(
        { key: 'invalid', baseRevision: 0, body: 'old source', sources: [f.goal.ref] },
        signal()
      ),
      { code: 'SCOPE_MISMATCH' }
    )
    await f.context.append({ kind: 'user', body: 'reattach', sources: [f.goal.ref] })
    assert.equal(
      (
        await f.memory.update(
          { key: 'valid', baseRevision: 0, body: 'reattached', sources: [f.goal.ref] },
          signal()
        )
      ).revision,
      1
    )
  })

test('program publication rolls back all additions if lease publication fails', async (t) => {
  const f = await fixture(t)
  const db = new DatabaseSync(f.path)
  t.after(() => db.close())
  const before = await f.storage.load('s')
  const sourceRef = crypto.randomUUID()
  const id = crypto.randomUUID()
  const version = { sourceRef, kind: 'observation', baseObservation: null, reason: 'first' }
  const program = { source: 'export default 1' }
  const receipt = {
    status: 'completed',
    executed: false,
    observe: { status: 'updated', sourceRef, executed: false },
  }
  db.exec(
    "CREATE TRIGGER fail_program BEFORE INSERT ON context_records WHEN NEW.title='script:lease-state' BEGIN SELECT RAISE(ABORT,'lease failed'); END"
  )
  await assert.rejects(
    f.programs.publish(
      [{ program, version }],
      { id, fingerprint: id, expectedObservation: null },
      receipt,
      true,
      false,
      signal()
    ),
    /lease failed/
  )
  assert.deepEqual(await f.storage.load('s'), before)
  db.exec('DROP TRIGGER fail_program')
  await f.programs.publish(
    [{ program, version }],
    { id, fingerprint: id, expectedObservation: null },
    receipt,
    true,
    false,
    signal()
  )
  assert.deepEqual(await f.programs.version(sourceRef), version)
})

test('note source authorization retries when a reset lands between selected snapshots', async (t) => {
  const f = await fixture(t)
  const read = f.storage.selectSnapshot.bind(f.storage)
  let changed = false
  t.mock.method(f.storage, 'selectSnapshot', async (id, selections) => {
    if (!changed && selections.some((item) => item.kind === 'user')) {
      changed = true
      await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
    }
    return read(id, selections)
  })
  await assert.rejects(
    f.memory.update(
      { key: 'race', baseRevision: 0, body: 'must reject', sources: [f.goal.ref] },
      signal()
    ),
    { code: 'SCOPE_MISMATCH' }
  )
  assert.deepEqual((await f.memory.list({}, signal())).items, [])
})

const historyFrame = {
  body: JSON.stringify({ results: [], goals: [] }),
  images: [{ marker: 'image' }],
  prompt: '',
}

test('history projection caches immutable result classification, preserves discovery and honors reset', async (t) => {
  const f = await fixture(t)
  const recent = new RecentContext('s', f.context, f.storage)
  const records = []
  for (const mode of ['execute', 'observe', 'execute'])
    records.push(
      await f.context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: JSON.stringify({ mode, n: records.length }),
      })
    )
  const get = f.storage.get.bind(f.storage)
  let reads = 0
  t.mock.method(f.storage, 'get', async (...args) => {
    reads++
    return get(...args)
  })
  t.mock.method(f.storage, 'load', () => {
    throw Error('full history snapshot')
  })
  const first = await recent.project(historyFrame, 4096, signal(), 1)
  assert.equal(reads, 3)
  const summaries = first.history.map((message) => JSON.parse(message.content))
  assert.equal(summaries[0].omittedRecords, 1)
  assert.equal(summaries[0].through, records[0].sequence)
  assert.equal(summaries[1].ref.id, records[2].ref.id)
  reads = 0
  assert.deepEqual(await recent.project(historyFrame, 4096, signal(), 1), first)
  assert.equal(reads, 0)
  const directory = await recent.list({}, signal())
  assert.equal(directory.items.length, 3)
  const tail = await f.context.append({ kind: 'event', title: 'unrelated', body: 'latest event' })
  assert.equal((await recent.list({}, signal())).through, tail.sequence)
  const zero = await new RecentContext('s', f.context, f.storage).project(
    historyFrame,
    0,
    signal(),
    0
  )
  assert.equal(reads, 0)
  assert.deepEqual(zero.history, [])
  const reset = await f.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'reset',
  })
  const fresh = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: JSON.stringify({ mode: 'execute', n: 0 }),
  })
  reads = 0
  const next = await recent.project(historyFrame, 4096, signal(), 2)
  assert.equal(reads, 1)
  assert.deepEqual(next.images, [])
  assert.deepEqual(
    next.history.map((message) => JSON.parse(message.content).ref.id),
    [fresh.ref.id]
  )
  const page = await recent.list({}, signal())
  assert.equal(page.resetAfter, reset.sequence)
  assert.equal(page.items.length, 1)
})

test('history classification cache is bounded and a missing body is re-read', async (t) => {
  const f = await fixture(t)
  const count = ActRuntimeTuning.historyClassificationEntries + 2
  const metadata = await f.storage.loadMetadata('s')
  const records = Array.from({ length: count }, (_, i) => ({
    ref: { sessionId: 's', id: crypto.randomUUID() },
    sequence: i + 2,
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    objectId: `object-${i}`,
    chars: 10,
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  }))
  let reads = 0
  let missing = true
  const storage = {
    selectSnapshot: async () => ({ metadata, records }),
    get: async () => {
      reads++
      if (missing) {
        missing = false
        return null
      }
      return '{"mode":"execute"}'
    },
  }
  const recent = new RecentContext('s', f.context, storage)
  await recent.project(historyFrame, 4096, signal(), 1)
  assert.equal(reads, count)
  reads = 0
  await recent.project(historyFrame, 4096, signal(), 1)
  assert.equal(reads, 2)
  const cancelled = new AbortController()
  cancelled.abort()
  reads = 0
  await assert.rejects(recent.project(historyFrame, 4096, cancelled.signal, 1), {
    name: 'AbortError',
  })
  assert.equal(reads, 0)
})

test('all projection stages avoid full snapshots and preserve immutable history', async (t) => {
  const f = await fixture(t)
  const recent = new RecentContext('s', f.context, f.storage)
  const memory = new ContextMemory('s', f.context, f.storage, f.view, f.programs, recent)
  await f.memory.update({ key: 'plan', baseRevision: 0, body: 'preserved note' }, signal())
  const original = await f.storage.load('s')
  t.mock.method(f.storage, 'load', () => {
    throw Error('full projection snapshot')
  })
  const view = {
    id: 'frame',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const result = await memory.project(view, undefined, [], signal(), 20000)
  const frame = JSON.parse(result.body)
  assert.equal(frame.partitions.workspace.notes[0].text, 'preserved note')
  for (const record of original.records)
    assert.deepEqual((await f.storage.records('s', { refId: record.ref.id })).items, [record])
  assert(
    (await f.storage.records('s', { title: `context:frame:${frame.frameId}` })).items.length === 1
  )
})

for (const mode of ['indexed', 'fallback', 'read-only-index', 'legacy-selector'])
  test(`${mode}: checkpoint commits preserve recent responses, version conflicts, recovery and reset scope`, async (t) => {
    const f = await fixture(t, mode)
    const recent = new RecentContext('s', f.context, f.port)
    const pairs = []
    for (let i = 0; i < 5; i++) {
      await f.context.append({ kind: 'assistant', body: `response ${i}` })
      pairs.push(
        await f.context.append({
          kind: 'audit',
          title: `script:${crypto.randomUUID()}:result`,
          body: JSON.stringify({ mode: 'execute', i }),
        })
      )
    }
    if (mode === 'indexed') {
      t.mock.method(f.storage, 'load', () => {
        throw Error('full checkpoint snapshot')
      })
      t.mock.method(f.storage, 'compareAndSwap', () => {
        throw Error('full checkpoint CAS')
      })
    }
    const input = {
      baseThrough: 0,
      through: pairs[0].sequence,
      summary: 'completed first result',
      evidence: [pairs[0].ref],
      unresolved: [],
      negativeAttempts: [],
    }
    const writes = await Promise.allSettled([
      recent.checkpoint(input, signal()),
      recent.checkpoint({ ...input, summary: 'competing checkpoint' }, signal()),
    ])
    assert.equal(writes.filter((item) => item.status === 'fulfilled').length, 1)
    assert.equal(writes.find((item) => item.status === 'rejected').reason.code, 'CONTEXT_CONFLICT')
    await assert.rejects(recent.checkpoint(input, signal()), { code: 'CONTEXT_CONFLICT' })
    await assert.rejects(
      recent.checkpoint(
        { ...input, baseThrough: input.through, through: pairs.at(-1).sequence },
        signal()
      ),
      /最近两个响应/
    )
    const saved = (await f.storage.records('s', { title: 'search:history-checkpoint' })).items
    assert.equal(saved.length, 1)
    const reopened = localContextStorage({ path: f.path })
    try {
      assert.equal(JSON.parse(await reopened.get('s', saved[0].objectId)).through, input.through)
    } finally {
      await reopened.close()
    }
    await f.context.append({
      kind: 'audit',
      title: 'search:history-reset',
      body: 'new authorization',
    })
    const next = []
    for (let i = 0; i < 4; i++) {
      await f.context.append({ kind: 'assistant', body: `next ${i}` })
      next.push(
        await f.context.append({
          kind: 'audit',
          title: `script:${crypto.randomUUID()}:result`,
          body: '{}',
        })
      )
    }
    await assert.rejects(
      recent.checkpoint({ ...input, through: next[0].sequence }, signal()),
      /当前授权/
    )
    await recent.checkpoint(
      { ...input, through: next[0].sequence, evidence: [next[0].ref] },
      signal()
    )
    const projection = await recent.project(historyFrame, 4096, signal(), 2)
    assert.equal(JSON.parse(projection.body).historyState.baseThrough, next[0].sequence)
  })

test('checkpoint transaction failure preserves the old state and concurrent changes fail CAS', async (t) => {
  const f = await fixture(t)
  const recent = new RecentContext('s', f.context, f.storage)
  const pairs = []
  for (let i = 0; i < 4; i++) {
    await f.context.append({ kind: 'assistant', body: `response ${i}` })
    pairs.push(
      await f.context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: '{}',
      })
    )
  }
  const input = {
    baseThrough: 0,
    through: pairs[0].sequence,
    summary: 'checkpoint',
    evidence: [pairs[0].ref],
    unresolved: [],
    negativeAttempts: [],
  }
  const before = await f.storage.load('s')
  const db = new DatabaseSync(f.path)
  t.after(() => db.close())
  db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON context_records WHEN NEW.title='search:history-checkpoint' BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END"
  )
  await assert.rejects(recent.checkpoint(input, signal()), /checkpoint failed/)
  assert.deepEqual(await f.storage.load('s'), before)
  db.exec('DROP TRIGGER fail_checkpoint')
  const cas = f.storage.compareAndSwapMetadata.bind(f.storage)
  let raced = false
  const hook = t.mock.method(f.storage, 'compareAndSwapMetadata', async (...args) => {
    if (!raced) {
      raced = true
      await f.context.append({ kind: 'event', body: 'changed while checkpointing' })
    }
    return cas(...args)
  })
  await assert.rejects(recent.checkpoint(input, signal()), { code: 'CONTEXT_CONFLICT' })
  assert.equal(
    (await f.storage.records('s', { title: 'search:history-checkpoint' })).items.length,
    0
  )
  hook.mock.restore()
  await recent.checkpoint(input, signal())
  assert.equal(
    (await f.storage.records('s', { title: 'search:history-checkpoint' })).items.length,
    1
  )
})

test('note head queries keep old versions readable and narrow script history without changing discovery', async (t) => {
  const f = await fixture(t)
  const first = await f.memory.update({ key: 'plan', baseRevision: 0, body: 'v1' }, signal())
  for (let i = 1; i < 12; i++)
    await f.memory.update({ key: 'plan', baseRevision: i, body: `v${i + 1}` }, signal())
  const select = f.storage.selectSnapshot.bind(f.storage)
  const sizes = []
  t.mock.method(f.storage, 'selectSnapshot', async (...args) => {
    const result = await select(...args)
    sizes.push(result?.records.length ?? 0)
    return result
  })
  const list = await f.memory.list({}, signal())
  assert.equal(list.items[0].revision, 12)
  assert.equal(sizes.at(-1), 1)
  assert.equal(JSON.parse((await f.memory.read(first.ref, 0, 10000, signal())).text).body, 'v1')
  for (let i = 0; i < 20; i++)
    await f.context.append({
      kind: 'audit',
      title: `script:control:${crypto.randomUUID()}`,
      body: '{}',
    })
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: '{}',
  })
  const recent = new RecentContext('s', f.context, f.storage)
  const directory = await recent.list({}, signal())
  assert.equal(directory.items.length, 1)
  assert.equal(directory.items[0].ref.id, result.ref.id)
  assert.equal(sizes.at(-1), 1)
})

for (const mode of ['indexed', 'fallback', 'read-only-index', 'legacy-selector'])
  test(`${mode}: material recall isolates unrelated note failures and retains task authorization`, async (t) => {
    const f = await fixture(t, mode)
    const first = await f.memory.update({ key: 'plan', baseRevision: 0, body: 'first' }, signal())
    const latest = await f.memory.update({ key: 'plan', baseRevision: 1, body: 'latest' }, signal())
    const damaged = await f.memory.update(
      { key: 'damaged', baseRevision: 0, body: 'unrelated' },
      signal()
    )
    const result = await f.context.append({
      kind: 'audit',
      title: `script:${crypto.randomUUID()}:result`,
      body: '{}',
      sources: [f.goal.ref],
    })
    const record = (await f.storage.records('s', { refId: damaged.ref.id })).items[0]
    const get = f.storage.get.bind(f.storage)
    const fault = t.mock.method(f.storage, 'get', (...args) =>
      args[1] === record.objectId ? null : get(...args)
    )
    if (mode === 'indexed')
      t.mock.method(f.storage, 'load', () => {
        throw Error('full material history loaded')
      })
    assert.equal((await f.memory.readMaterial(f.goal.ref, 0, 100, signal())).text, 'goal')
    assert.equal(
      JSON.parse((await f.memory.readMaterial(first.ref, 0, 10000, signal())).text).body,
      'first'
    )
    assert.equal(
      JSON.parse((await f.memory.read(latest.ref, 0, 10000, signal())).text).body,
      'latest'
    )
    await assert.rejects(f.memory.readMaterial(damaged.ref, 0, 10000, signal()), {
      code: 'OBJECT_MISSING',
    })
    assert.equal((await f.memory.retainMaterial(result.ref, 2, signal())).remainingTurns, 2)
    assert.equal((await f.memory.retainMaterial(result.ref, null, signal())).released, true)
    fault.mock.restore()
    await assert.rejects(f.memory.retainMaterial(first.ref, null, signal()), {
      code: 'WORKSPACE_CONFLICT',
    })
    assert.equal((await f.memory.retainMaterial(latest.ref, null, signal())).resident, false)
    await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
    await assert.rejects(f.memory.readMaterial(f.goal.ref, 0, 100, signal()), {
      code: 'SCOPE_MISMATCH',
    })
    await f.context.append({ kind: 'user', body: 'reattach', sources: [f.goal.ref] })
    assert.equal((await f.memory.readMaterial(f.goal.ref.id, 0, 100, signal())).text, 'goal')
    await assert.rejects(
      f.memory.readMaterial({ ...f.goal.ref, sessionId: 'other' }, 0, 100, signal()),
      { code: 'SCOPE_MISMATCH' }
    )
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(f.memory.readMaterial(f.goal.ref, 0, 100, cancelled.signal), {
      name: 'AbortError',
    })
  })

test('material catalog pagination preserves reset, explicit reattachment, note heads and filtered tails', async (t) => {
  const f = await fixture(t)
  const old = await f.context.append({
    kind: 'audit',
    title: 'uploaded-file',
    body: 'old attachment',
  })
  await f.context.append({ kind: 'assistant', body: 'old response' })
  const reset = await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  const user = await f.context.append({ kind: 'user', body: 'new input', sources: [old.ref] })
  await f.memory.update({ key: 'plan', baseRevision: 0, body: 'old version' }, signal())
  const latest = await f.memory.update(
    { key: 'plan', baseRevision: 1, title: 'Unique Title', body: 'current' },
    signal()
  )
  const response = await f.context.append({ kind: 'assistant', body: 'response' })
  const result = await f.context.append({
    kind: 'audit',
    title: 'script:example:result',
    body: '{}',
  })
  const expected = [old.ref.id, user.ref.id, latest.ref.id, response.ref.id, result.ref.id]
  const actual = []
  let after = 0
  do {
    const page = await f.memory.catalog({ after, limit: 2 }, signal())
    actual.push(...page.items.map((item) => item.ref.id))
    after = page.nextAfter
  } while (after !== null)
  assert.deepEqual(actual, expected)
  assert.deepEqual(
    (
      await f.memory.catalog({ kind: 'history', through: result.sequence, limit: 1 }, signal())
    ).items.map((item) => item.ref.id),
    [response.ref.id]
  )
  assert.equal(
    (await f.memory.catalog({ kind: 'history', after: response.sequence, limit: 1 }, signal()))
      .nextAfter,
    null
  )
  assert.deepEqual(
    (await f.memory.catalog({ kind: 'notes', query: 'UNIQUE' }, signal())).items.map(
      (item) => item.ref.id
    ),
    [latest.ref.id]
  )
  assert.deepEqual(
    (await f.memory.catalog({ through: reset.sequence }, signal())).items.map(
      (item) => item.ref.id
    ),
    [old.ref.id]
  )
})
