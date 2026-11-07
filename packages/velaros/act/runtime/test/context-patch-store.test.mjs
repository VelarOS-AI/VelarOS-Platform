import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { ContextPatchStore } from '../../../dist/act/runtime/impl/ContextPatchStore.js'
import { RuntimeDiagnostics } from '../../../dist/act/runtime/impl/RuntimeDiagnostics.js'

test('discarded context patches reserve identities in the durable storage without publishing records', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'context-patch-ids-'))
  const path = join(root, 'context.sqlite')
  const connections = []
  t.after(async () => {
    for (const storage of connections) await storage.close()
    await rm(root, { recursive: true, force: true })
  })
  const storage = localContextStorage({ path })
  connections.push(storage)
  const metrics = []
  const observed = new RuntimeDiagnostics(storage, (metric) => {
    metrics.push(metric)
  }).storage
  const context = createContextRuntime({ sessionId: 's', storage: observed })
  const original = await context.append({ kind: 'user', body: 'original goal' })
  const base = await storage.load('s')
  const patch = new ContextPatchStore('s', observed, base)
  const staged = await createContextRuntime({ sessionId: 's', storage: patch }).append({
    kind: 'note',
    body: 'unpublished interpretation',
  })
  assert.deepEqual(await storage.load('s'), base)
  assert.equal(metrics.filter((metric) => metric.operation === 'allocateReferenceId').length, 2)
  await assert.rejects(patch.allocateReferenceId('other'), { code: 'CLOSED' })
  await patch.close()
  await assert.rejects(patch.allocateReferenceId('s'), { code: 'CLOSED' })
  await storage.close()

  const reopened = localContextStorage({ path })
  connections.push(reopened)
  const collision = t.mock.method(
    crypto,
    'randomUUID',
    () => `${staged.ref.id}-0000-4000-8000-000000000000`
  )
  try {
    await assert.rejects(reopened.allocateReferenceId('s'), { code: 'CONFLICT' })
    assert.equal(collision.mock.callCount(), 64)
  } finally {
    collision.mock.restore()
  }
  assert.deepEqual(await reopened.load('s'), base)
  const published = new ContextPatchStore('s', reopened, base)
  const note = await createContextRuntime({ sessionId: 's', storage: published }).append({
    kind: 'note',
    body: 'accepted interpretation',
  })
  assert.notEqual(note.ref.id, staged.ref.id)
  assert.equal(await published.commit(new AbortController().signal), true)
  const restored = createContextRuntime({ sessionId: 's', storage: reopened })
  assert.equal((await restored.read(original.ref)).text, 'original goal')
  assert.equal((await restored.read(note.ref)).text, 'accepted interpretation')
  await assert.rejects(restored.read(staged.ref), { code: 'REF_NOT_FOUND' })
})
