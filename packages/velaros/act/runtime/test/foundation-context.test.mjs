import assert from 'node:assert/strict'

function expandPending(value) {
  return Array.isArray(value)
    ? value
    : value.groups.flatMap(({ sessionId, ids }) => ids.map((id) => ({ sessionId, id })))
}

test('pending groups preserve interleaved sessions, duplicates and reduce large histories', () => {
  const refs = Array.from({ length: 1000 }, (_, i) => ({
    sessionId: i < 500 || i > 750 ? 's' : 'other',
    id: String(i % 10),
  }))
  const active = {
    revision: 1,
    status: 'pending-review',
    items: [],
    pendingInputs: refs,
    pendingSources: [],
  }
  const before = structuredClone(active)
  const projected = taskActiveProjection(active, { sessionId: 's', id: 'latest' })
    .historicalInterpretation.pendingInputs
  assert.equal(projected.count, 1000)
  assert.deepEqual(expandPending(projected), refs)
  assert(JSON.stringify(projected).length < JSON.stringify(refs).length / 2)
  assert.deepEqual(active, before)
})

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
import { memoryPrompt } from '../../../dist/act/runtime/utils/context-memory.js'
import { taskActiveProjection } from '../../../dist/act/runtime/utils/task-projection.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

test('task projection: lossless pending history split preserves constraints and reference identity', () => {
  const refs = Array.from({ length: 1000 }, (_, i) => ({ sessionId: 's', id: String(i) }))
  const constraint = {
    id: 'c',
    kind: 'constraint',
    text: 'Do not publish',
    sources: [refs[0]],
    origin: 'model-interpretation',
  }
  const question = {
    id: 'q',
    kind: 'question',
    text: 'done resolved 完成 does not prove completion',
    sources: [refs[1]],
    origin: 'model-interpretation',
  }
  const active = {
    revision: 9,
    status: 'pending-review',
    items: [question, constraint],
    pendingInputs: refs,
    pendingSources: [refs[2]],
  }
  const original = structuredClone(active)
  const projected = JSON.parse(JSON.stringify(taskActiveProjection(active, refs.at(-1))))
  assert.deepEqual(projected.active.items, [constraint])
  assert.deepEqual(projected.active.pendingInputs, [refs.at(-1)])
  assert.deepEqual(projected.historicalInterpretation.items, [question])
  assert.deepEqual(
    [
      ...expandPending(projected.historicalInterpretation.pendingInputs),
      ...projected.active.pendingInputs,
    ],
    refs
  )
  assert.deepEqual(projected.active.pendingSources, active.pendingSources)
  assert.equal(projected.active.status, 'pending-review')
  assert.deepEqual(active, original)
  assert.deepEqual(taskActiveProjection(active).active, active)
  const reviewed = { ...active, status: 'reviewed', pendingInputs: [] }
  assert.deepEqual(taskActiveProjection(reviewed, refs.at(-1)).active, reviewed)
  const otherSession = taskActiveProjection(active, { sessionId: 'other', id: '999' })
  assert.deepEqual(otherSession.active.pendingInputs, [])
  assert.deepEqual(expandPending(otherSession.historicalInterpretation.pendingInputs), refs)
})

test('task projection: SQLite frame, recall, reopen and Node serialization preserve pending history', async (t) => {
  const f = await setup(t)
  const first = await f.context.append({
    kind: 'user',
    body: 'Investigate failures; do not publish.',
  })
  await f.task.begin(first.ref)
  await f.context.summarizeInput({
    ref: first.ref,
    baseRevision: 0,
    summary: 'Investigate',
    constraints: ['Do not publish'],
    unresolved: [],
  })
  const text = 'Historical failure remains unverified. '.repeat(20)
  const narrative = await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({ volume: first.ref, negativeAttempts: [], unresolved: [text] }),
  })
  const next = await f.context.append({
    kind: 'user',
    body: 'Continue investigating the same failure.',
  })
  await f.task.appendGoal(next.ref)
  const latest = await f.context.append({ kind: 'user', body: 'Also inspect its retry path.' })
  await f.task.appendGoal(latest.ref)
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const goals = await Promise.all(
    [first, next, latest].map((record) => f.context.projectInput(record.ref, 6000))
  )
  const projected = await f.memory.project({ ...view('s'), goals }, undefined, [], signal(), 24000)
  const frame = JSON.parse(projected.body)
  const task = frame.partitions.task
  assert.deepEqual(task.latestInput, latest.ref)
  assert.deepEqual(
    task.active.items.map((item) => item.text),
    ['Do not publish']
  )
  assert.deepEqual(
    task.historicalInterpretation.items.map((item) => item.text),
    [text]
  )
  assert.deepEqual(task.historicalInterpretation.pendingInputs, [first.ref, next.ref])
  assert.deepEqual(task.active.pendingInputs, [latest.ref])
  assert.deepEqual(task.historicalInterpretation.items[0].sources, [narrative.ref])
  assert.equal(
    (await f.context.read(narrative.ref)).text,
    JSON.stringify({ volume: first.ref, negativeAttempts: [], unresolved: [text] })
  )
  assert.deepEqual(await active.read(signal()), before)
  frame.presentation = 'node'
  frame.memoryStatus.maintenance = { unresolved: [text] }
  const encoded = JSON.stringify(frame)
  const prompt = memoryPrompt(encoded)
  assert(prompt.includes('historicalInterpretation'))
  const shown = JSON.parse(prompt.split('内存状态：\n')[1]).maintenance
  assert.deepEqual(shown.unresolved, [text], 'no dangling pointer into filtered active.items')
  assert.equal(JSON.stringify(frame), encoded)
  const reopened = await f.reopen()
  assert.deepEqual(await new ActiveContext('s', reopened.context, f.storage).read(signal()), before)
})

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

test('foundation: unverified persistent references fail closed without rewriting or collecting objects', async (t) => {
  const f = await setup(t)
  await f.context.append({ kind: 'user', body: 'Unverified persistent state' })
  const body = 'Unregistered persistent prefix'
  const objectId = await f.storage.put('s', body)
  await f.context.append({
    kind: 'audit',
    title: 'context:segment',
    body: JSON.stringify({ base: { objectId, chars: body.length }, entries: [], from: 0 }),
  })
  const state = await f.storage.load('s')
  const { objectReferencesVersion, ...unverified } = state
  assert.equal(objectReferencesVersion, 1)
  await f.storage.compareAndSwap('s', state.version, { ...unverified, version: state.version + 1 })
  const saved = await f.storage.load('s')
  const db = new DatabaseSync(f.path)
  db.prepare('UPDATE objects SET touched=? WHERE session=?').run(Date.now() - 7_200_000, 's')
  db.close()
  const options = { expectedVersion: saved.version, before: Date.now() - 3_700_000, dryRun: false }
  await assert.rejects(f.storage.collect('s', options), { code: 'CONTEXT_REFERENCES_UNVERIFIED' })
  await assert.rejects(f.recent.segment(signal()), { code: 'CONTEXT_REFERENCES_UNVERIFIED' })
  await assert.rejects(f.recent.currentBoundary(signal()), {
    code: 'CONTEXT_REFERENCES_UNVERIFIED',
  })
  assert.deepEqual(await f.storage.load('s'), saved)
  assert.equal(await f.storage.get('s', objectId), body)
  const reopened = await f.reopen()
  await assert.rejects(reopened.recent.segment(signal()), { code: 'CONTEXT_REFERENCES_UNVERIFIED' })
  await assert.rejects(f.storage.collect('s', options), { code: 'CONTEXT_REFERENCES_UNVERIFIED' })
  assert.deepEqual(await f.storage.load('s'), saved)
  assert.equal(await f.storage.get('s', objectId), body)
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

// 轻量更新复用整理器的证据和发布链，但不把 question 更新冒充为输入审阅。
test('active questions: resolve and supersede persist across segments and reopen; explicit maintenance can reopen', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({
    kind: 'user',
    body: 'Investigate both failures; do not publish.',
  })
  await f.task.begin(goal.ref)
  await f.context.summarizeInput({
    ref: goal.ref,
    baseRevision: 0,
    summary: 'Investigate',
    constraints: ['Do not publish'],
    unresolved: [],
  })
  const body = JSON.stringify({
    volume: goal.ref,
    negativeAttempts: [],
    constraints: [],
    unresolved: ['Failure one', 'Failure two'],
  })
  const old = await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body,
  })
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'first fixed; second narrowed',
  })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const questions = before.items.filter((item) => item.kind === 'question')
  const proof = [{ ref: result.ref, offset: 0, quote: 'first fixed; second narrowed' }]
  const receipt = await f.memory.updateActive(
    {
      baseRevision: before.revision,
      changes: [
        { id: questions[0].id, status: 'resolved', evidence: proof },
        {
          id: questions[1].id,
          status: 'superseded',
          replacement: 'Second failure: narrowed boundary',
          evidence: proof,
        },
      ],
    },
    signal()
  )
  assert.equal(receipt.revision, before.revision + 1)
  assert.deepEqual(
    receipt.updated.map(({ id, status }) => ({ id, status })),
    questions.map((item, i) => ({ id: item.id, status: i ? 'superseded' : 'resolved' }))
  )
  assert.notEqual(receipt.updated[1].replacement.id, questions[1].id)
  const after = await active.read(signal())
  assert.deepEqual(after.pendingInputs, before.pendingInputs)
  assert.equal(after.status, 'pending-review')
  assert.deepEqual(
    after.items.filter((item) => item.kind === 'constraint'),
    before.items.filter((item) => item.kind === 'constraint')
  )
  assert.deepEqual(
    after.items.filter((item) => item.kind === 'question').map((item) => item.text),
    ['Second failure: narrowed boundary']
  )
  const state = await f.storage.load('s')
  const transitionRecord = state.records.findLast(
    (item) => item.title === 'context:active-transition'
  )
  const transition = JSON.parse(await f.storage.get('s', transitionRecord.objectId))
  assert.equal(transition.actor, 'main-model')
  assert.equal(transition.reviewedInput, undefined)
  assert.deepEqual(transition.transitions[0].prior, questions[0])
  assert.deepEqual(transition.transitions[0].evidence, proof)
  assert.equal((await f.context.read(old.ref)).text, body)
  await f.recent.seal(0, state.records.at(-1).sequence, signal())
  await f.context.append({ kind: 'checkpoint', title: 'context:volume-narrative', body })
  assert.deepEqual((await active.read(signal())).items, after.items)
  const reopened = await f.reopen()
  const restored = new ActiveContext('s', reopened.context, f.storage)
  const current = await restored.read(signal())
  assert.deepEqual(current.items, after.items)
  await restored.apply(
    {
      baseRevision: current.revision,
      reviewedInput: goal.ref,
      changes: [],
      additions: [{ kind: 'question', text: questions[0].text, evidence: proof }],
    },
    [goal.ref],
    signal()
  )
  const added = (await restored.read(signal())).items.find(
    (item) => item.text === questions[0].text
  )
  assert(added)
  assert.notEqual(added.id, questions[0].id)
})

test('active questions: constraint, additions, retraction, stale version, invalid quotes and invented sources reject atomically', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'Investigate; do not publish.' })
  await f.task.begin(goal.ref)
  await f.context.summarizeInput({
    ref: goal.ref,
    baseRevision: 0,
    summary: 'Investigate',
    constraints: ['Do not publish'],
    unresolved: [],
  })
  await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({ unresolved: ['Failure one', 'Failure two'] }),
  })
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'test passed',
  })
  const note = await f.context.append({ kind: 'note', body: 'test passed' })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const question = before.items.find((item) => item.kind === 'question')
  const constraint = before.items.find((item) => item.kind === 'constraint')
  const change = {
    id: question.id,
    status: 'resolved',
    evidence: [{ ref: result.ref, offset: 0, quote: 'test passed' }],
  }
  const patch = { baseRevision: before.revision, changes: [change] }
  const cases = [
    [{ ...patch, baseRevision: before.revision - 1 }, 'CONFLICT'],
    [{ ...patch, changes: [] }, 'VALIDATION'],
    [{ ...patch, additions: [] }, 'VALIDATION'],
    [{ ...patch, changes: [{ ...change, status: 'retracted' }] }, 'VALIDATION'],
    [
      {
        ...patch,
        changes: [
          { ...change, id: constraint.id, status: 'superseded', replacement: 'Publish freely' },
        ],
      },
      'VALIDATION',
    ],
    [{ ...patch, changes: [change, { ...change, id: 'unknown' }] }, 'VALIDATION'],
    [{ ...patch, changes: [change, change] }, 'VALIDATION'],
    [
      {
        ...patch,
        changes: [{ ...change, evidence: [{ ref: note.ref, offset: 0, quote: 'test passed' }] }],
      },
      'PERMISSION',
    ],
    [
      {
        ...patch,
        changes: [{ ...change, evidence: [{ ref: result.ref, offset: 1, quote: 'test passed' }] }],
      },
      'CONFLICT',
    ],
    [
      {
        ...patch,
        changes: [
          {
            ...change,
            evidence: [
              { ref: { sessionId: 'other', id: result.ref.id }, offset: 0, quote: 'test passed' },
            ],
          },
        ],
      },
      'VALIDATION',
    ],
    [
      {
        ...patch,
        changes: [
          {
            ...change,
            evidence: [
              { ref: { sessionId: 's', id: 'invented' }, offset: 0, quote: 'test passed' },
            ],
          },
        ],
      },
      'PERMISSION',
    ],
    [{ ...patch, changes: [{ ...change, replacement: 'unexpected' }] }, 'VALIDATION'],
    [{ ...patch, changes: [{ ...change, status: 'superseded' }] }, 'VALIDATION'],
  ]
  for (const [input, code] of cases) {
    await assert.rejects(active.updateQuestions(input, signal()), { code })
    assert.deepEqual(await active.read(signal()), before)
  }
  const save = f.storage.compareAndSwapMetadata.bind(f.storage)
  t.mock.method(f.storage, 'compareAndSwapMetadata', async () => false)
  await assert.rejects(active.updateQuestions(patch, signal()), { code: 'CONFLICT' })
  t.mock.restoreAll()
  assert.deepEqual(await active.read(signal()), before)
  await active.updateQuestions(patch, signal())
  await assert.rejects(active.updateQuestions(patch, signal()), { code: 'CONFLICT' })
  assert(save)
})

test('active questions: history reset forbids old execution evidence and cancellation does not publish', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'Investigate' })
  await f.task.begin(goal.ref)
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'test passed',
  })
  await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({ unresolved: ['Failure'] }),
  })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const patch = {
    baseRevision: before.revision,
    changes: [
      {
        id: before.items[0].id,
        status: 'resolved',
        evidence: [{ ref: result.ref, offset: 0, quote: 'test passed' }],
      },
    ],
  }
  await assert.rejects(active.updateQuestions(patch, signal()), { code: 'PERMISSION' })
  const aborted = AbortSignal.abort()
  await assert.rejects(active.updateQuestions(patch, aborted), { name: 'AbortError' })
  assert.deepEqual(await active.read(signal()), before)
})

test('handoff: mechanical recovery keeps current questions and original evidence across segments and reopen', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({
    kind: 'user',
    body: 'Continue the serializer; do not publish',
  })
  await f.task.begin(goal.ref)
  await f.task.startStep('handoff-plan', signal())
  await f.task.updateCapsule({ nextObjective: 'Verify the serializer', decisions: ['Keep API'] })
  await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({
      volume: goal.ref,
      unresolved: ['First failure', 'Second failure'],
      negativeAttempts: [],
    }),
  })
  const active = new ActiveContext('s', f.context, f.storage)
  const before = await active.read(signal())
  const result = await f.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: 'First failure fixed',
  })
  await f.memory.updateActive(
    {
      baseRevision: before.revision,
      changes: [
        {
          id: before.items[0].id,
          status: 'resolved',
          evidence: [{ ref: result.ref, offset: 0, quote: 'First failure fixed' }],
        },
      ],
    },
    signal()
  )
  const first = await f.memory.project(view('s'), undefined, [], signal(), 24000)
  const base = first.history.map((x) => JSON.stringify(x)).join('\n')
  assert.match(base, /runtime-handoff/)
  const h = await f.recent.handoff(signal())
  assert.deepEqual(
    h.entries.filter((x) => x.kind === 'question').map((x) => x.text),
    ['Second failure']
  )
  assert(h.entries.some((x) => x.kind === 'transition' && x.text === 'First failure'))
  const transition = h.entries.find((x) => x.kind === 'transition')
  assert.match((await f.context.read(transition.ref)).text, /First failure fixed/)
  await f.recent.seal(0, (await f.storage.load('s')).records.at(-1).sequence, signal())
  await f.task.settle([], signal())
  await f.task.end()
  const reopened = await f.reopen()
  assert.deepEqual(
    (await reopened.recent.handoff(signal())).entries
      .filter((x) => x.kind === 'question')
      .map((x) => x.text),
    ['Second failure']
  )
  const secondGoal = await reopened.context.append({ kind: 'user', body: 'Now verify the parser' })
  await reopened.task.begin(secondGoal.ref, signal())
  await reopened.context.append({ kind: 'assistant', body: 'Continue without repeating the write' })
  for (let index = 0; index < 70; index++)
    await reopened.context.append({ kind: 'assistant', body: `Segment work ${index}` })
  assert.equal(await reopened.memory.fold('boundary', 24000, signal()), true)
  const second = await reopened.memory.project(view('s'), undefined, [], signal(), 24000)
  assert.match(JSON.stringify(second.history), /Now verify the parser/)
  assert.equal(JSON.stringify(first.history).includes('Now verify the parser'), false)
  const failure = await reopened.context.append({
    kind: 'audit',
    title: `script:${crypto.randomUUID()}:result`,
    body: JSON.stringify({
      result: { failed: { code: 'PROCESS_FAILED', message: 'parser failed' } },
    }),
  })
  const thirdHandoff = await reopened.recent.handoff(signal())
  assert(
    thirdHandoff.entries.some((item) => item.kind === 'result' && item.ref.id === failure.ref.id)
  )
  await reopened.context.append({ kind: 'assistant', body: 'Failure remains open' })
  for (let index = 0; index < 70; index++)
    await reopened.context.append({ kind: 'assistant', body: `Segment work ${index}` })
  assert.equal(await reopened.memory.fold('boundary', 24000, signal()), true)
  const third = await reopened.memory.project(view('s'), undefined, [], signal(), 24000)
  assert.match(JSON.stringify(third.history), /execution-failed/)
  assert.deepEqual(
    (await reopened.recent.handoff(signal())).entries
      .filter((item) => item.kind === 'question')
      .map((item) => item.text),
    ['Second failure']
  )
  assert.equal(
    JSON.stringify(h).includes('First failure fixed'),
    false,
    'execution body is not copied into handoff'
  )
})

test('handoff: total budget is bounded and reset prevents old state and evidence leakage', async (t) => {
  const f = await setup(t)
  const goal = await f.context.append({ kind: 'user', body: 'OLD_SECRET' })
  await f.task.begin(goal.ref)
  await f.context.append({
    kind: 'checkpoint',
    title: 'context:volume-narrative',
    body: JSON.stringify({
      unresolved: Array.from({ length: 25 }, (_, i) => `OLD_SECRET ${i}${'x'.repeat(800)}`),
    }),
  })
  await new ActiveContext('s', f.context, f.storage).read(signal())
  const h = await f.recent.handoff(signal())
  assert(h.omitted > 0)
  assert(JSON.stringify(h).length <= 6000)
  await f.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  const reset = await f.recent.handoff(signal())
  assert.doesNotMatch(JSON.stringify(reset), /OLD_SECRET/)
  assert.equal(reset.active, undefined)
  assert.deepEqual(reset.entries, [])
})
