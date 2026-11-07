import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 's', storage })
  const view = createContextView({ sessionId: 's', storage, context, sources: [] })
  const input = await context.append({ kind: 'user', body: 'Complete this task.' })
  await view.begin(input.ref)
  await view.build({ maxChars: 12000 })
  return { storage, context, view }
}

test('INV-21 task completion and host records publish atomically despite unrelated CAS races', async (t) => {
  const { storage, context, view } = await fixture(t)
  const atomic = storage.compareAndSwapMetadata.bind(storage)
  let raced = false
  storage.compareAndSwapMetadata = async (...args) => {
    if (!raced && args[2].task?.status === 'completed') {
      raced = true
      await context.append({ kind: 'tool', title: 'unrelated', body: 'another event' })
    }
    return atomic(...args)
  }
  let preparations = 0
  const result = await view.complete(undefined, {
    prepare: async () => {
      preparations++
      const state = await storage.loadMetadata('s')
      const body = 'finalized target'
      return {
        version: state.version,
        records: [
          {
            ref: { sessionId: 's', id: crypto.randomUUID() },
            kind: 'audit',
            title: 'domain:complete',
            objectId: await storage.put('s', body),
            chars: body.length,
            sources: [],
            createdAt: new Date().toISOString(),
          },
        ],
      }
    },
  })
  assert.deepEqual(result, { completed: true, reason: 'COMPLETED' })
  assert.equal(preparations, 2)
  const state = await storage.load('s')
  assert.equal(state.task.status, 'completed')
  assert.equal(state.records.filter((record) => record.title === 'domain:complete').length, 1)
})
