import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { createRuntime, openSessionControl } from '../../../dist/act/runtime/index.js'

import { withProjectFixture } from './support/project-fixture.mjs'
import { createTestRuntime, testBinding } from './support/runtime-fixture.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-session-control-'))
  const cleanups = []
  t.after(async () => {
    try {
      for (const cleanup of cleanups.toReversed()) await cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  return {
    root,
    own: (cleanup) => cleanups.push(cleanup),
    open() {
      const storage = localContextStorage({ path: join(root, 'context.sqlite') })
      const connection = { storage, closeCalls: 0, closed: false }
      const close = storage.close.bind(storage)
      storage.close = async () => {
        connection.closeCalls++
        if (connection.closed) return
        await close()
        connection.closed = true
      }
      cleanups.push(async () => {
        if (!connection.closed) await storage.close()
      })
      return connection
    },
  }
}

test('storage-only control restores real Runtime notes and goals without executable modules or model work', async (t) => {
  const f = await fixture(t)
  const projectRoot = join(f.root, 'project')
  await mkdir(projectRoot)
  let modelCalls = 0
  const prior = f.open()
  const runtime = await createTestRuntime(
    await withProjectFixture(
      {
        storage: prior.storage,
        binding: testBinding,
        context: { maintenance: false },
        model: {
          id: 'session-control-no-model-work',
          limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
          estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
          async *stream() {
            modelCalls++
            yield { type: 'error', message: 'Session control must not start the model' }
          },
        },
      },
      { root: projectRoot }
    ),
    { cwd: projectRoot }
  )
  f.own(() => runtime.close())
  assert.equal(runtime.describe('velaros:project').binding.moduleId, 'velaros:project')
  const session = await runtime.openSession('saved')
  await session.context.ingest({ text: 'Keep the notes and goal available while idle' })
  const body = 'revision-two-tail'
  const receipt = await session.execute({
    source: `import {commit} from 'velaros:project'; import {memory} from 'velaros:system';
      await commit({changes:[{path:'proof.txt',before:null,after:'stored-by-full-runtime'}]});
      await memory.update({key:'a',body:'first revision',baseRevision:0});
      await memory.update({key:'a',body:${JSON.stringify(body)},baseRevision:1});
      await memory.update({key:'b',body:'second note',baseRevision:0});`,
  })
  assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
  assert(
    receipt.calls.every((call) => call.ok),
    JSON.stringify(receipt.calls)
  )
  const goal = await session.updateGoal({ baseRevision: 0, objective: 'Preserve idle control' })
  const before = await prior.storage.load('saved')
  await runtime.close()
  assert.equal(prior.closeCalls, 1)

  const current = f.open()
  const lease = await openSessionControl({
    sessionId: 'saved',
    storage: current.storage,
    binding: testBinding,
  })
  f.own(() => lease.close())
  assert.equal(lease.id, 'saved')
  assert.equal('submit' in lease, false)
  assert.equal('execute' in lease, false)
  const first = await lease.listNotes({ limit: 1 })
  assert.equal(first.items[0].key, 'a')
  assert.equal(first.items[0].revision, 2)
  assert.equal(first.nextAfter, 'a')
  const last = await lease.listNotes({ after: first.nextAfter, limit: 1 })
  assert.deepEqual(
    last.items.map((entry) => entry.key),
    ['b']
  )
  assert.equal(last.nextAfter, null)
  const page = await lease.readNote({ key: 'a', revision: 2, offset: body.length - 4, limit: 4 })
  assert.equal(page.text, 'tail')
  assert.equal(page.offset, body.length - 4)
  assert.equal(page.totalChars, body.length)
  await assert.rejects(lease.readNote({ key: 'a', revision: 1 }), { code: 'WORKSPACE_CONFLICT' })
  assert.deepEqual(await lease.getGoal(), goal)
  const paused = await lease.controlGoal({ baseRevision: goal.revision, action: 'pause' })
  assert.equal(paused.status, 'paused')
  await assert.rejects(lease.controlGoal({ baseRevision: goal.revision, action: 'resume' }), {
    code: 'GOAL_CONFLICT',
  })
  const resumed = await lease.controlGoal({ baseRevision: paused.revision, action: 'resume' })
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.id, goal.id)
  assert.equal(resumed.revision, goal.revision + 2)
  const after = await current.storage.load('saved')
  assert.deepEqual(
    after.records.filter((record) => record.title !== 'session:goal'),
    before.records.filter((record) => record.title !== 'session:goal')
  )
  assert.equal(modelCalls, 0)
  assert.equal(await readFile(join(projectRoot, 'proof.txt'), 'utf8'), 'stored-by-full-runtime')
  await lease.close()
  await lease.close()
  assert.equal(current.closeCalls, 1)
})

test('control rejects unsafe recovery and leaves missing sessions empty while close drains accepted reads', async (t) => {
  const f = await fixture(t)
  const prior = f.open()
  const runtime = await createRuntime({
    storage: prior.storage,
    binding: testBinding,
    runner: { run: async () => assert.fail('Binding preparation does not execute programs') },
  })
  f.own(() => runtime.close())
  await runtime.openSession('bound')
  await runtime.close()
  const legacy = f.open()
  await createContextRuntime({ sessionId: 'legacy', storage: legacy.storage }).append({
    kind: 'audit',
    title: 'runtime:workspace',
    body: JSON.stringify({ version: 1, workspace: null }),
  })
  await createContextRuntime({ sessionId: 'corrupt', storage: legacy.storage }).append({
    kind: 'audit',
    title: 'runtime:binding',
    body: JSON.stringify({
      version: 1,
      ...testBinding,
      modules: [{ moduleId: 'incomplete:module' }],
    }),
  })
  await legacy.storage.close()

  for (const options of [
    { sessionId: 'bound', binding: { ...testBinding, executionIdentity: 'other-actor' } },
    { sessionId: 'bound', binding: { ...testBinding, authorizationScope: 'other-scope' } },
    { sessionId: 'legacy', binding: testBinding },
    { sessionId: 'corrupt', binding: testBinding },
  ]) {
    const connection = f.open()
    await assert.rejects(openSessionControl({ ...options, storage: connection.storage }), {
      code: 'CONFLICT',
    })
    assert.equal(connection.closeCalls, 0, 'Failed open leaves storage with its caller')
    assert(await connection.storage.loadMetadata(options.sessionId))
    await connection.storage.close()
  }

  const current = f.open()
  const lease = await openSessionControl({
    sessionId: 'missing',
    storage: current.storage,
    binding: testBinding,
  })
  f.own(() => lease.close())
  assert.equal(await current.storage.loadMetadata('missing'), null)
  assert.equal(await lease.getGoal(), null)
  assert.deepEqual(await lease.listNotes(), { items: [], nextAfter: null })
  await assert.rejects(lease.readNote({ key: 'missing', revision: 1 }), { code: 'NOT_FOUND' })
  await assert.rejects(lease.controlGoal({ baseRevision: 0, action: 'resume' }), {
    code: 'NOT_FOUND',
  })
  assert.equal(await current.storage.loadMetadata('missing'), null)

  let entered
  let release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const selectSnapshot = current.storage.selectSnapshot.bind(current.storage)
  current.storage.selectSnapshot = async (...args) => {
    entered()
    await gate
    return selectSnapshot(...args)
  }
  const reading = lease.getGoal()
  await started
  let closeSettled = false
  const closing = lease.close()
  void closing.then(
    () => {
      closeSettled = true
    },
    () => {
      closeSettled = true
    }
  )
  try {
    await setImmediate()
    assert.equal(current.closeCalls, 0, 'Storage must outlive the accepted read')
    assert.equal(closeSettled, false)
  } finally {
    release()
  }
  assert.equal(await reading, null)
  await closing
  await lease.close()
  assert.equal(current.closeCalls, 1)
  await assert.rejects(lease.getGoal(), { code: 'CLOSED' })
  const verify = f.open()
  assert.equal(await verify.storage.loadMetadata('missing'), null)
})

test('storage-only control registers accepted reads before a storage callback reenters close', async (t) => {
  const f = await fixture(t)
  const current = f.open()
  const lease = await openSessionControl({
    sessionId: 'missing',
    storage: current.storage,
    binding: testBinding,
  })
  f.own(() => lease.close())
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const order = []
  let closing
  let reads = 0
  const selectSnapshot = current.storage.selectSnapshot.bind(current.storage)
  current.storage.selectSnapshot = async (...args) => {
    reads++
    closing = lease.close()
    void closing.catch(() => {})
    entered.resolve()
    await release.promise
    assert.equal(current.closed, false, 'Storage must outlive the accepted read')
    order.push('read-resumed')
    return selectSnapshot(...args)
  }
  const close = current.storage.close.bind(current.storage)
  current.storage.close = async () => {
    order.push('storage-close')
    await close()
  }
  const reading = lease.getGoal()
  void reading.catch(() => {})
  try {
    await entered.promise
    await setImmediate()
    assert.equal(current.closeCalls, 0, 'Reentrant close must observe the accepted operation')
    await assert.rejects(lease.getGoal(), { code: 'CLOSED' })
    assert.equal(reads, 1, 'Closed admission must not call the storage port')
  } finally {
    release.resolve()
  }
  assert.equal(await reading, null)
  await closing
  assert.equal(current.closeCalls, 1)
  assert.deepEqual(order, ['read-resumed', 'storage-close'])
})
