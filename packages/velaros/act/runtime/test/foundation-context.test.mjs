import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { ActiveContext } from '../../../dist/act/runtime/impl/ActiveContext.js'
import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

const signal = () => new AbortController().signal
const view = (id) => ({
  id: 'frame',
  scope: { sessionId: id, revision: 0 },
  goals: [],
  capsule: {},
  mandatory: [],
  evidence: [],
  gaps: [],
  readSet: [],
  progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
})

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'foundation-context-'))
  const path = join(root, 'context.sqlite')
  let storage = localContextStorage({ path })
  const objects = () => {
    const context = createContextRuntime({ sessionId: 's', storage })
    const task = createContextView({ sessionId: 's', storage, context, sources: [] })
    const recent = new RecentContext('s', context, storage)
    const memory = new ContextMemory(
      's',
      context,
      storage,
      task,
      new ProgramContext('s', context, storage),
      recent
    )
    return { context, task, recent, memory }
  }
  t.after(async () => {
    await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    path,
    get storage() {
      return storage
    },
    ...objects(),
    async reopen() {
      await storage.close()
      storage = localContextStorage({ path })
      return objects()
    },
  }
}

test('foundation: collection preserves accepted segment bytes after close and reopen', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'Preserve current evidence' })
  await f.task.begin(goal.ref)
  await f.context.append({ kind: 'assistant', body: 'Immutable accepted history' })
  const first = await f.memory.project(view('s'), undefined, [], signal(), 24000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal())
  await f.storage.put('s', 'genuine unreferenced orphan')
  const db = new DatabaseSync(f.path)
  db.prepare('UPDATE objects SET touched=? WHERE session=?').run(Date.now() - 7_200_000, 's')
  db.close()
  const state = await f.storage.loadMetadata('s')
  const result = await f.storage.collect('s', {
    expectedVersion: state.version,
    before: Date.now() - 3_700_000,
    dryRun: false,
  })
  assert.equal(result.deleted, 1, 'only the real orphan may be collected')
  const reopened = await f.reopen()
  const next = await reopened.memory.project(view('s'), undefined, [], signal(), 24000)
  assert.deepEqual(next.history, first.history)
})

test('foundation: active history selection is independent of sealed history size', async (t) => {
  const f = await setup(t)
  for (let index = 0; index < 1000; index++)
    await f.context.append({ kind: 'assistant', body: `Past ${index}` })
  const counts = []
  const select = f.storage.selectSnapshot.bind(f.storage)
  t.mock.method(f.storage, 'selectSnapshot', async (...args) => {
    const selected = await select(...args)
    counts.push(selected?.records.length ?? 0)
    return selected
  })
  const result = await f.recent.project({ from: 998, carried: [], entries: [] }, [], 4000, signal())
  assert.equal(result.messages.length, 2)
  assert(Math.max(...counts) <= 2, `selected ${counts} records for only two active messages`)
})

test('foundation: legacy collection fails closed until the runtime migrates nested references', async (t) => {
  const f = await setup(t)
  await f.context.append({ kind: 'user', body: 'legacy session' })
  const objectId = await f.storage.put('s', 'legacy stable prefix')
  await f.context.append({
    kind: 'audit',
    title: 'context:segment',
    body: JSON.stringify({
      base: { objectId, chars: 20 },
      entries: [],
      from: 0,
    }),
  })
  const state = await f.storage.load('s')
  const { objectReferencesVersion, ...legacy } = state
  assert.equal(objectReferencesVersion, 1)
  await f.storage.compareAndSwap('s', state.version, { ...legacy, version: state.version + 1 })
  await assert.rejects(
    f.storage.collect('s', { expectedVersion: state.version + 1, before: 0, dryRun: false }),
    { code: 'CONTEXT_REFERENCES_UNVERIFIED' }
  )
  await f.recent.segment(signal())
  const migrated = await f.storage.load('s')
  assert.equal(migrated.objectReferencesVersion, 1)
  assert(migrated.records.some((record) => record.objectId === objectId))
  assert.deepEqual(
    await f.storage.collect('s', { expectedVersion: migrated.version, before: 0, dryRun: false }),
    { candidates: 0, deleted: 0 }
  )
})

test('foundation: current constraints retire by later user evidence without changing history or resurrecting on summary refresh', async (t) => {
  const f = await setup(t)
  const first = await f.context.append({ kind: 'user', body: 'Use package A.' })
  await f.task.begin(first.ref)
  const oldSummary = await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 0,
    summary: 'Use A',
    constraints: ['Use package A'],
    unresolved: [],
  })
  const second = await f.context.append({ kind: 'user', body: 'Use package B instead of A.' })
  await f.task.appendGoal(second.ref)
  await f.context.summarizeInput({
    ref: second.ref,
    baseRevision: 0,
    summary: 'Use B',
    constraints: ['Use package B'],
    unresolved: [],
  })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const old = before.items.find((item) => item.text === 'Use package A')
  assert.equal(before.status, 'pending-review')
  const patch = {
    baseRevision: before.revision,
    reviewedInput: second.ref,
    changes: [
      {
        id: old.id,
        status: 'retracted',
        evidence: [{ ref: second.ref, offset: 0, quote: 'Use package B instead of A.' }],
      },
    ],
  }
  await assert.rejects(active.apply(patch, [], signal()), { code: 'CONTEXT_INPUT_UNSEEN' })
  await assert.rejects(
    active.apply(
      {
        ...patch,
        changes: [
          {
            ...patch.changes[0],
            evidence: [{ ref: first.ref, offset: 0, quote: 'Use package A.' }],
          },
        ],
      },
      [first.ref, second.ref],
      signal()
    ),
    { code: 'PERMISSION' }
  )
  await assert.rejects(
    active.apply(
      {
        ...patch,
        changes: [
          { ...patch.changes[0], evidence: [{ ref: second.ref, offset: 0, quote: 'fabricated' }] },
        ],
      },
      [second.ref],
      signal()
    ),
    { code: 'CONFLICT' }
  )
  await active.apply(patch, [second.ref], signal())
  const current = await active.read(signal())
  assert.equal(current.status, 'reviewed')
  assert.deepEqual(
    current.items.map((item) => item.text),
    ['Use package B']
  )
  assert.match((await f.context.read(oldSummary)).text, /Use package A/)
  await assert.rejects(active.apply(patch, [second.ref], signal()), { code: 'CONFLICT' })
  await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 1,
    summary: 'Historical requirement A',
    constraints: ['Use package A'],
    unresolved: [],
  })
  assert.deepEqual(
    (await active.read(signal())).items.map((item) => item.text),
    ['Use package B']
  )
  const reopened = await f.reopen()
  assert.deepEqual(
    (await new ActiveContext('s', reopened.context, f.storage).read(signal())).items.map(
      (item) => item.text
    ),
    ['Use package B']
  )
  const goals = await Promise.all(
    [first, second].map((record) => reopened.context.projectInput(record.ref, 6000))
  )
  const frame = await reopened.memory.project(
    { ...view('s'), goals },
    undefined,
    [],
    signal(),
    24000
  )
  assert.equal(JSON.parse(frame.body).partitions.task.active.items[0].text, 'Use package B')
  assert(frame.history.some((message) => message.content.includes('Use package B instead of A.')))
})

test('foundation: unresolved items carry across narratives and require real evidence to close', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'Investigate both failures' })
  await f.task.begin(goal.ref)
  for (const text of ['Failure one', 'Failure two'])
    await f.context.append({
      kind: 'checkpoint',
      title: 'context:volume-narrative',
      body: JSON.stringify({ unresolved: [text] }),
    })
  const active = new ActiveContext('s', f.context, f.storage)
  const state = await active.read(signal())
  assert.deepEqual(
    state.items.map((item) => item.text),
    ['Failure one', 'Failure two']
  )
  const note = await f.context.append({ kind: 'note', body: 'I think it is fixed' })
  const base = {
    baseRevision: state.revision,
    reviewedInput: goal.ref,
    changes: [
      {
        id: state.items[0].id,
        status: 'resolved',
        evidence: [{ ref: note.ref, offset: 0, quote: 'I think it is fixed' }],
      },
    ],
  }
  await assert.rejects(active.apply(base, [goal.ref], signal()), { code: 'PERMISSION' })
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'test passed',
  })
  await active.apply(
    {
      ...base,
      changes: [
        { ...base.changes[0], evidence: [{ ref: result.ref, offset: 0, quote: 'test passed' }] },
      ],
    },
    [goal.ref],
    signal()
  )
  assert.deepEqual(
    (await active.read(signal())).items.map((item) => item.text),
    ['Failure two']
  )
  await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({ unresolved: [] }),
  })
  assert.deepEqual(
    (await active.read(signal())).items.map((item) => item.text),
    ['Failure two']
  )
})

test('foundation: maintenance publishes current-state changes atomically after real input delivery', async (t) => {
  const f = await setup(t)
  const first = await f.context.append({ kind: 'user', body: 'Use A' })
  await f.task.begin(first.ref)
  await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 0,
    summary: 'Use A',
    constraints: ['Use A'],
    unresolved: [],
  })
  const last = await f.context.append({ kind: 'user', body: 'Replace A with B' })
  await f.task.appendGoal(last.ref)
  const maintenance = new ContextMaintenanceState('s', f.storage)
  const snapshot = await maintenance.snapshot(24000, signal())
  const patch = {
    baseRevision: snapshot.baseRevision,
    summary: 'Follow current user direction',
    unresolved: [],
    active: {
      baseRevision: snapshot.active.revision,
      reviewedInput: last.ref,
      changes: [
        {
          id: snapshot.active.items[0].id,
          status: 'superseded',
          replacement: 'Use B',
          evidence: [{ ref: last.ref, offset: 0, quote: 'Replace A with B' }],
        },
      ],
    },
  }
  await assert.rejects(maintenance.apply(snapshot, patch, signal()), {
    code: 'CONTEXT_INPUT_UNSEEN',
  })
  maintenance.acknowledge(snapshot, maintenance.material(snapshot, 24000))
  await maintenance.apply(snapshot, patch, signal())
  assert.deepEqual(
    (await new ActiveContext('s', f.context, f.storage).read(signal())).items.map(
      (item) => item.text
    ),
    ['Use B']
  )
  assert.equal((await f.context.readInput(first.ref)).text, 'Use A')
})

test('foundation: warm volume projections read the active index and new records only', async (t) => {
  const f = await setup(t)
  await f.context.append({ kind: 'user', body: 'long history' })
  for (let index = 0; index < 100; index++) {
    await f.context.append({
      kind: 'checkpoint',
      title: 'context:volume',
      body: JSON.stringify({
        level: 1,
        from: index,
        through: index + 1,
        turns: 1,
        results: 0,
        failures: 0,
        effects: 0,
        inputs: 0,
        notes: [],
        skeleton: '',
      }),
    })
  }
  await f.recent.volumes(signal())
  const counts = []
  const select = f.storage.selectSnapshot.bind(f.storage)
  t.mock.method(f.storage, 'selectSnapshot', async (...args) => {
    const selected = await select(...args)
    counts.push(selected.records.length)
    return selected
  })
  await f.recent.volumes(signal())
  assert(Math.max(...counts) <= 2, `warm volume projection loaded ${counts}`)
})

for (const size of [100, 1000])
  test(`foundation: reviewed ${size} user inputs are not reloaded on each active projection`, async (t) => {
    const f = await setup(t)
    let last
    for (let index = 0; index < size; index++) {
      last = await f.context.append({ kind: 'user', body: `User direction ${index}` })
      if (!index) await f.task.begin(last.ref)
      else await f.task.appendGoal(last.ref)
    }
    const active = new ActiveContext('s', f.context, f.storage)
    const first = await active.read(signal())
    await active.apply(
      { baseRevision: first.revision, reviewedInput: last.ref, changes: [] },
      [last.ref],
      signal()
    )
    const counts = []
    const select = f.storage.selectSnapshot.bind(f.storage)
    t.mock.method(f.storage, 'selectSnapshot', async (...args) => {
      const selected = await select(...args)
      counts.push(selected.records.length)
      return selected
    })
    assert.equal((await active.read(signal())).status, 'reviewed')
    const next = await f.context.append({ kind: 'user', body: 'Newest correction' })
    await f.task.appendGoal(next.ref)
    assert.deepEqual((await active.read(signal())).pendingInputs, [next.ref])
    assert(Math.max(...counts) <= 3, `active projection reloaded ${counts} records after review`)
  })

test('foundation: current state respects task switch and history reset', async (t) => {
  const f = await setup(t)
  const old = await f.context.append({ kind: 'user', body: 'Old task' })
  await f.task.begin(old.ref)
  await f.context.summarizeInput({
    ref: old.ref,
    baseRevision: 0,
    summary: 'Old',
    constraints: ['Old constraint'],
    unresolved: [],
  })
  const active = new ActiveContext('s', f.context, f.storage)
  const initial = await active.read(signal())
  const next = await f.context.append({ kind: 'user', body: 'New independent task' })
  await f.task.end()
  await f.task.begin(next.ref, undefined, 'new')
  assert.deepEqual((await active.read(signal())).items, [])
  await assert.rejects(
    active.apply(
      { baseRevision: initial.revision, reviewedInput: old.ref, changes: [] },
      [old.ref],
      signal()
    ),
    { code: 'CONFLICT' }
  )
  await f.context.summarizeInput({
    ref: next.ref,
    baseRevision: 0,
    summary: 'New',
    constraints: ['New constraint'],
    unresolved: [],
  })
  assert.equal((await active.read(signal())).items.length, 1)
  await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  assert.deepEqual((await active.read(signal())).items, [])
})

test('foundation: an active assistant keeps its continuation when the cut follows that continuation', async (t) => {
  const f = await setup(t)
  const value = { model: 'fixture', format: 'fixture-v1', data: 'opaque', tokens: 1 }
  const continuation = await f.context.append({
    kind: 'audit',
    title: 'model-continuation',
    body: JSON.stringify(value),
  })
  await f.context.append({
    kind: 'assistant',
    body: 'accepted response',
    sources: [continuation.ref],
  })
  const projected = await f.recent.project(
    { from: continuation.sequence, carried: [], entries: [] },
    [],
    4000,
    signal()
  )
  assert.deepEqual(projected.messages[0].continuation, value)
})

test('foundation: a full active ledger keeps deferred sources and can retire items to resume import', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'Investigate open issues' })
  await f.task.begin(goal.ref)
  for (let batch = 0; batch < 9; batch++)
    await f.context.append({
      kind: 'checkpoint',
      title: 'context:volume-narrative',
      body: JSON.stringify({
        unresolved: Array.from({ length: 32 }, (_, index) => `Issue ${batch * 32 + index}`),
      }),
    })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  assert.equal(before.items.length, 256)
  assert.equal(before.pendingSources.length, 1)
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'First batch tests passed',
  })
  await active.apply(
    {
      baseRevision: before.revision,
      reviewedInput: goal.ref,
      changes: before.items.slice(0, 32).map((item) => ({
        id: item.id,
        status: 'resolved',
        evidence: [{ ref: result.ref, offset: 0, quote: 'First batch tests passed' }],
      })),
    },
    [goal.ref],
    signal()
  )
  const after = await active.read(signal())
  assert.equal(after.items.length, 256)
  assert.deepEqual(after.pendingSources, [])
  assert(after.items.some((item) => item.text === 'Issue 287'))
})

test('foundation: rephrased old summaries cannot restore retired constraints while explicit additions remain available', async (t) => {
  const f = await setup(t)
  const original = 'Use A. Keep C. Keep D.'
  const first = await f.context.append({ kind: 'user', body: original })
  await f.task.begin(first.ref)
  await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 0,
    summary: 'Original task',
    constraints: ['Use A', 'Keep C'],
    unresolved: [],
  })
  const last = await f.context.append({ kind: 'user', body: 'Use B instead of A.' })
  await f.task.appendGoal(last.ref)
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  await active.apply(
    {
      baseRevision: before.revision,
      reviewedInput: last.ref,
      changes: [
        {
          id: before.items.find((item) => item.text === 'Use A').id,
          status: 'superseded',
          replacement: 'Use B',
          evidence: [{ ref: last.ref, offset: 0, quote: 'Use B instead of A.' }],
        },
      ],
    },
    [last.ref],
    signal()
  )
  await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 1,
    summary: 'Historical task revisited',
    constraints: ['Use A', 'Keep C', 'A must be the chosen package', 'Keep D'],
    unresolved: [],
  })
  const after = await active.read(signal())
  assert.deepEqual(
    after.items.map((item) => item.text),
    ['Keep C', 'Use B']
  )
  const patch = {
    baseRevision: after.revision,
    reviewedInput: last.ref,
    changes: [],
    additions: [
      {
        kind: 'constraint',
        text: 'Keep D',
        evidence: [{ ref: first.ref, offset: original.indexOf('Keep D'), quote: 'Keep D.' }],
      },
    ],
  }
  await assert.rejects(active.apply(patch, [last.ref], signal()), { code: 'PERMISSION' })
  await active.apply(patch, [first.ref, last.ref], signal())
  assert.deepEqual(
    (await active.read(signal())).items.map((item) => item.text),
    ['Keep C', 'Use B', 'Keep D']
  )
  assert.equal((await f.context.readInput(first.ref)).text, original)
})
