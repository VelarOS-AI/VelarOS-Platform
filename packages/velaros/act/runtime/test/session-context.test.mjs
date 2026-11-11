import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'

import { done, modelText } from './support/model-turn.mjs'
import { createTestRuntime } from './support/runtime-fixture.mjs'

const model = (stream) => ({
  id: 'session-context-test',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
  stream,
})

test('INV-96 one runtime opens independent main contexts and awaits each context resource release', async (t) => {
  const prepared = []
  const closed = []
  const frames = []
  const runtime = await createTestRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    instructions: 'GENERIC_ROOT_CONTEXT',
    prepareSession: async (request) => {
      prepared.push(request)
      return {
        instructions: `PERSON_CONTEXT_${request.sessionId}`,
        environment: () => ({ personResource: request.sessionId }),
        close: async () => {
          await Promise.resolve()
          closed.push(request.sessionId)
        },
      }
    },
    model: model(async function* (request) {
      frames.push(`${request.instructions}\n${modelText(request)}`)
      yield* done(request, 'complete')
    }),
  })
  t.after(() => runtime.close())
  const [first, same] = await Promise.all([runtime.openSession('lin'), runtime.openSession('lin')])
  assert.equal(first, same)
  const second = await runtime.openSession('jiang')
  assert.deepEqual(
    prepared.map((request) => request.sessionId),
    ['lin', 'jiang']
  )
  assert(prepared.every((request) => request.parentSessionId === null && request.profile === null))
  for (const session of [first, second])
    for await (const event of session.submit('do the assigned work'))
      assert.notEqual(event.type, 'error', JSON.stringify(event))
  assert.equal(frames.length, 2)
  assert(frames[0].includes('PERSON_CONTEXT_lin'))
  assert(!frames[0].includes('PERSON_CONTEXT_jiang'))
  assert(frames[1].includes('PERSON_CONTEXT_jiang'))
  assert(!frames[1].includes('PERSON_CONTEXT_lin'))
  assert(frames.every((frame) => !frame.includes('GENERIC_ROOT_CONTEXT')))
  await first.close()
  assert.deepEqual(closed, ['lin'])
  assert.equal(runtime.getSession('lin'), undefined)
  await runtime.close()
  assert.deepEqual(closed, ['lin', 'jiang'])
})

test('INV-96 runtime closing cancels pending main preparation and releases the returned resources', async (t) => {
  const entered = Promise.withResolvers()
  let closed = 0
  let cancelled = false
  const runtime = await createTestRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    prepareSession: async (_request, signal) => {
      entered.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      cancelled = signal.aborted
      return {
        close: async () => {
          closed++
        },
      }
    },
  })
  t.after(() => runtime.close())
  const opening = runtime.openSession('pending')
  const rejected = assert.rejects(opening, { code: 'CLOSED' })
  await entered.promise
  await runtime.close()
  await rejected
  assert.equal(cancelled, true)
  assert.equal(closed, 1)
  assert.equal(runtime.getSession('pending'), undefined)
})
