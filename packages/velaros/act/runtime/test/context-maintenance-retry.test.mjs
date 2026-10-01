import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMaintenance } from '../../../dist/act/runtime/impl/ContextMaintenance.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

const signal = new AbortController().signal
const narrative = {
  summary: 'The sealed work has already been narrated.',
  evidence: [],
  unresolved: [],
  negativeAttempts: [],
}

async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules: [] })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  const input = await session.context.append({ kind: 'user', body: 'Continue the investigation' })
  await session.view.begin(input.ref)
  const recent = new RecentContext('root', session.context, storage)
  let starts = 0
  const dependencies = {
    storage,
    preview: () => undefined,
    model: () => ({ id: 'unused-offline-model' }),
    tools: {
      async begin() {
        starts++
        throw new Error('Offline test stops at the model-resource boundary')
      },
    },
  }
  const maintenance = new ContextMaintenance(dependencies)
  async function volume(from = 0) {
    const record = await session.context.append({ kind: 'assistant', body: 'Recorded local work' })
    return recent.seal(from, record.sequence, signal)
  }
  return { storage, session, recent, maintenance, dependencies, volume, starts: () => starts }
}

test('INV-73 a persisted volume narrative prevents queued automatic narration before model allocation', async (t) => {
  const f = await fixture(t)
  const ref = await f.volume()
  await f.recent.narrate(ref, narrative, signal)
  await f.maintenance.request('root', { focus: 'Refresh the current notes' }, signal)
  assert.equal(
    await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal),
    false
  )
  assert.equal(f.starts(), 0)
  assert.equal((await f.maintenance.status('root', signal)).pending, true)
  const restarted = new ContextMaintenance(f.dependencies)
  assert.equal(
    await restarted.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal),
    false
  )
  assert.equal(
    f.starts(),
    0,
    'the guard uses persisted authorized history, not a process-local flag'
  )
})

test('INV-73 an absent narrative and a failed earlier maintenance still permit automatic narration', async (t) => {
  const f = await fixture(t)
  await f.volume()
  await f.session.context.append({
    kind: 'audit',
    title: 'context-maintenance:outcome',
    body: JSON.stringify({ reason: 'narrate', status: 'failed', error: 'Model was unavailable' }),
  })
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 another volume narrative cannot suppress the latest unnarrated volume', async (t) => {
  const f = await fixture(t)
  const first = await f.volume()
  await f.recent.narrate(first, narrative, signal)
  const latest = (await f.recent.volumes(signal)).at(-1)
  const second = await f.volume(latest.volume.through)
  assert.notEqual(first.id, second.id)
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 existing narration does not suppress pressure maintenance', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.maintenance.maintain('root', { reason: 'pressure', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 existing narration does not consume or suppress an explicit maintenance request', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.maintenance.request('root', { focus: 'Review new evidence' }, signal)
  await f.maintenance.maintain('root', { reason: 'boundary', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})

test('INV-73 authorization reset excludes old narratives while a new authorized volume can be narrated', async (t) => {
  const f = await fixture(t)
  await f.recent.narrate(await f.volume(), narrative, signal)
  await f.session.view.end('completed')
  const input = await f.session.context.append({ kind: 'user', body: 'Begin a separate task' })
  await f.session.view.begin(input.ref, signal, 'new')
  assert.equal((await f.recent.volumes(signal)).length, 0)
  await f.volume()
  await f.maintenance.maintain('root', { reason: 'narrate', targetChars: 8000 }, signal)
  assert.equal(f.starts(), 1)
})
