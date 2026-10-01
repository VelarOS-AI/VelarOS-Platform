import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { volatileStorageBackend } from '../../../../context/test/support/storage-contract.mjs'
import { createRuntime } from '../../../dist/act/runtime/index.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function boundedClose(runtime) {
  let timer
  try {
    await assert.rejects(
      Promise.race([
        runtime.close({ timeoutMs: 20 }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(Error('observer hung'), { code: 'TEST_WATCHDOG' })),
            200
          )
        }),
      ]),
      { code: 'TIMEOUT' }
    )
  } finally {
    clearTimeout(timer)
  }
}

test('INV-47 full runtime close preserves noncooperative writes, real effects and storage until settlement', async () => {
  const backend = volatileStorageBackend()
  const storage = await backend.open()
  const audit = createContextInvocationJournal(await backend.open())
  const entered = deferred()
  const release = deferred()
  let disposed = false
  let writes = 0
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    context: { maintenance: false },
    modules: [
      {
        binding: { moduleId: 'test:slow', instanceId: 'one', generation: 1, schemaRevision: '1' },
        summary: 'slow effect',
        operations: {
          write: {
            summary: 'write',
            input: { type: 'null' },
            output: { type: 'null' },
            effects: 'write',
            run: async (_input, context) => {
              entered.resolve()
              await release.promise
              writes++
              context.recordEffect('committed')
              return null
            },
          },
        },
        dispose: () => {
          disposed = true
        },
      },
    ],
  })
  const session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'write once' })
  const execution = session
    .execute({ source: "import {write} from 'test:slow'; await write()" })
    .catch(() => null)
  try {
    await entered.promise
    await boundedClose(runtime)
    assert.equal(backend.closes, 0)
    assert.equal(disposed, false)
    assert.equal(writes, 0)
    assert.equal(
      runtime.pending().some((item) => item.moduleId === 'test:slow' && item.cancelRequested),
      true
    )
    const records = await audit.list('s')
    assert.equal(
      records.some((item) => item.prepared.binding.moduleId === 'test:slow' && !item.receipt),
      true
    )
    await assert.rejects(runtime.openSession('new'), { code: 'CLOSED' })
  } finally {
    release.resolve()
    await execution
    await runtime.close()
  }
  assert.equal(disposed, true)
  assert.equal(backend.closes, 1)
  assert.equal(writes, 1)
  assert.deepEqual(runtime.pending(), [])
  const final = (await audit.list('s')).find(
    (item) => item.prepared.binding.moduleId === 'test:slow'
  )
  assert.equal(final.receipt.effect, 'committed')
  assert.ok(final.receipt.lifecycle.startedAt)
})

test('INV-47 close deadline covers session shutdown before Kernel disposal', async () => {
  const backend = volatileStorageBackend()
  const entered = deferred()
  const release = deferred()
  const runtime = await createRuntime({
    storage: await backend.open(),
    modules: [],
    context: { maintenance: false },
    runner: {
      run: async () => {
        entered.resolve()
        await release.promise
        return { ok: true, value: 1, logs: [] }
      },
    },
  })
  const session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'run' })
  const execution = session.execute({ source: 'export default 1' }).catch(() => null)
  try {
    await entered.promise
    await boundedClose(runtime)
    assert.equal(backend.closes, 0)
    await assert.rejects(runtime.openSession('new'), { code: 'CLOSED' })
  } finally {
    release.resolve()
    await execution
    await runtime.close()
  }
  assert.equal(backend.closes, 1)
})

test('INV-47 caller cancellation keeps the actual write lock until the handler exits', async () => {
  const backend = volatileStorageBackend()
  const entered = deferred()
  const release = deferred()
  const started = []
  const runtime = await createRuntime({
    storage: await backend.open(),
    runner: nodeSubprocessCodeRunner,
    context: { maintenance: false },
    modules: [
      {
        binding: { moduleId: 'test:serial', instanceId: 'one', generation: 1, schemaRevision: '1' },
        summary: 'serialized writes',
        operations: {
          write: {
            summary: 'write',
            input: { type: 'integer' },
            output: { type: 'null' },
            effects: 'write',
            run: async (input) => {
              started.push(input)
              if (input === 1) {
                entered.resolve()
                await release.promise
              }
              return null
            },
          },
        },
      },
    ],
  })
  const a = await runtime.openSession('a')
  const b = await runtime.openSession('b')
  await a.context.append({ kind: 'user', body: 'first write' })
  await b.context.append({ kind: 'user', body: 'second write' })
  const controller = new AbortController()
  const first = a
    .execute(
      { source: "import {write} from 'test:serial'; await write(1)" },
      undefined,
      controller.signal
    )
    .catch(() => null)
  let second
  try {
    await entered.promise
    controller.abort()
    await first
    second = b.execute({ source: "import {write} from 'test:serial'; await write(2)" })
    for (let i = 0; i < 200 && !runtime.pending().some((item) => item.sessionId === 'b'); i++)
      await new Promise((resolve) => setTimeout(resolve, 2))
    assert.ok(runtime.pending().some((item) => item.sessionId === 'b'))
    assert.deepEqual(started, [1])
    release.resolve()
    await second
    assert.deepEqual(started, [1, 2])
  } finally {
    release.resolve()
    await Promise.allSettled([first, second])
    await runtime.close()
  }
})
