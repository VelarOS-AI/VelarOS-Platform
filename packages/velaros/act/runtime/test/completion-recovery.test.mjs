import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, turn } from './support/model-turn.mjs'
async function setup(t, beforeComplete, stream, modules = []) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules,
    context: { maintenance: false },
    model: {
      id: 'recovery',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      stream,
    },
  })
  t.after(async () => {
    await runtime.close()
    await storage.close()
  })
  const session = await runtime.openSession('root')
  if (beforeComplete) {
    const complete = session.view.complete.bind(session.view)
    session.view.complete = async (...args) => (await beforeComplete()) ?? complete(...args)
  }
  return session
}
async function run(session) {
  const events = []
  for await (const event of session.submit('Finish the task')) events.push(event)
  return events
}

test('INV-28 a stale view returns feedback to the next round and a refreshed task can finish', async (t) => {
  let calls = 0
  let checks = 0
  const session = await setup(
    t,
    async () =>
      ++checks === 1 ? { completed: false, reason: 'STALE_VIEW', recovery: 'refresh' } : undefined,
    async function* (request) {
      if (++calls === 2) assert.match(request.compiledPrompt, /STALE_VIEW/)
      yield* done(request)
    }
  )
  const events = await run(session)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(calls, 2)
  assert.equal(events.filter((e) => e.type === 'completion').length, 2)
})

test('repeated missing required evidence is bounded and retains the actual failure reason', async (t) => {
  let calls = 0
  const session = await setup(
    t,
    async () => ({ completed: false, reason: 'REQUIRED_EVIDENCE_MISSING', recovery: 'repair' }),
    async function* (request) {
      calls++
      yield* done(request)
    }
  )
  const events = await run(session)
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(calls, 3)
  assert.equal(events.findLast((e) => e.type === 'completion').recovery, 'repair')
})

test('uncertain world effects do not stop the run, and the script is never replayed automatically', async (t) => {
  let writes = 0
  let calls = 0
  const module = {
    binding: { moduleId: 'test:uncertain', instanceId: 'one', generation: 1, schemaRevision: '1' },
    summary: 'uncertain',
    operations: {
      write: {
        summary: 'write',
        input: { type: 'null' },
        output: { type: 'null' },
        effects: 'write',
        run: () => {
          writes++
          throw Error('response lost')
        },
      },
    },
  }
  const session = await setup(
    t,
    undefined,
    async function* (request) {
      if (++calls === 1) {
        yield turn(request, {
          execute: { source: "import {write} from 'test:uncertain';await write();" },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    },
    [module]
  )
  const events = await run(session)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(writes, 1)
  assert.equal(calls, 2)
  assert.equal((await session.inspect()).status, 'completed')
})
