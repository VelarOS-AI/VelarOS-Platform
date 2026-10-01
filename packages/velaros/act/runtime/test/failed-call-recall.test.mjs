import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, turn } from './support/model-turn.mjs'

test('INV-70 failed script exposes a journal recall route in the actual next request without repeating IO', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  let reads = 0
  const original = `host-result-${crypto.randomUUID()}`
  const requests = []
  const model = {
    id: 'failed-call-recall',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      requests.push(request)
      if (requests.length === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {read} from 'test:recall';await read(null);throw new Error('synthetic post-read failure');",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (requests.length === 2) {
        const frame = JSON.parse(request.materials.find((x) => x.origin === 'runtime-view').text)
        const recovery = frame.partitions.runtime.progress.feedback.recovery
        assert(recovery, 'failed request must expose an actionable recall route')
        assert.equal(recovery.selector, 'invocation')
        assert.equal(JSON.stringify(request).includes(original), false)
        yield turn(request, {
          execute: {
            source: `import {output} from 'velaros';import {memory} from 'velaros:system';const index=await memory.read(${JSON.stringify(recovery.index)});for(const call of JSON.parse(index.text)){const page=await memory.read({ref:index.record.ref,invocation:call.id,limit:60000});output(page,{view:{mode:'full'}});}`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(requests.length, 3)
        assert(
          JSON.stringify(request.history).includes(original),
          'actual retained history must contain the recalled result'
        )
        yield* done(request)
      }
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [
      {
        binding: {
          moduleId: 'test:recall',
          instanceId: 'recall',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'read synthetic value',
        operations: {
          read: {
            summary: 'read',
            input: { type: 'null' },
            output: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
            effects: 'none',
            run: () => {
              reads++
              return { value: original }
            },
          },
        },
      },
    ],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('failed-recall')
  const events = []
  for await (const event of session.submit(
    'Read the synthetic value; recover existing results if needed'
  ))
    events.push(event)
  const failedFrame = JSON.parse(
    requests[1].materials.find((x) => x.origin === 'runtime-view').text
  )
  assert(
    failedFrame.partitions.runtime.progress.feedback.recovery,
    'failed request must expose an actionable recall route'
  )
  assert.equal(
    events.at(-1).status,
    'completed',
    JSON.stringify(events.filter((x) => x.type === 'error' || x.type === 'state'))
  )
  assert.equal(reads, 1)
  assert.equal(requests.length, 3)
  const journal = await createContextInvocationJournal(storage).list(session.id)
  assert.equal(journal.filter((x) => x.prepared.binding.moduleId === 'test:recall').length, 1)
  assert.equal(
    journal.filter((x) => x.prepared.binding.moduleId === 'velaros:system-memory').length,
    2
  )
})

async function fixture(t, value = { text: 'synthetic value' }) {
  const storage = localContextStorage({ path: ':memory:' })
  let calls = 0
  const requests = []
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model: {
      id: 'recall-fixture',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        requests.push(request)
        yield* done(request)
      },
    },
    modules: [
      {
        binding: {
          moduleId: 'test:recall',
          instanceId: 'recall',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'synthetic',
        operations: {
          read: {
            summary: 'read',
            input: { type: 'null' },
            output: {},
            effects: 'none',
            run: () => {
              calls++
              return value
            },
          },
        },
      },
    ],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('recall-fixture')
  await session.context.append({ kind: 'user', body: 'Synthetic task' })
  const journal = createContextInvocationJournal(storage)
  const programs = new ProgramContext(session.id, session.context, storage)
  const recent = new RecentContext(session.id, session.context, storage)
  const memoryFor = (port) =>
    new ContextMemory(
      session.id,
      session.context,
      storage,
      session.view,
      programs,
      recent,
      undefined,
      port
    )
  const memory = memoryFor(journal)
  const execute = async (fail = true) =>
    session.execute({
      source: `import {read} from 'test:recall';await read(null);${fail ? "throw new Error('synthetic failure');" : ''}`,
    })
  const result = await execute()
  const records = await journal.list(session.id, result.executionId)
  const id = records[0].prepared.id
  const signal = new AbortController().signal
  return {
    storage,
    session,
    journal,
    programs,
    memory,
    memoryFor,
    execute,
    result,
    id,
    record: records[0],
    signal,
    requests,
    read: (offset, limit, pointer, ref = result.resultRef, invocation = id) =>
      memory.readMaterial(ref, offset, limit, signal, pointer, invocation),
    get calls() {
      return calls
    },
  }
}

test('INV-70 failed-call receipt pages preserve Unicode, statuses and field ranges without copying source payload', async (t) => {
  const value = { text: 'a😀b\n'.repeat(14000) }
  const f = await fixture(t, value)
  const archived = await f.memory.readMaterial(f.result.resultRef, 0, 60000, f.signal)
  const saved = JSON.parse(archived.text)
  assert.equal(saved.recovery.calls.length, 1)
  assert.equal(saved.recovery.calls[0].id, f.id)
  assert.equal(archived.text.includes(value.text.slice(0, 100)), false)
  const pages = []
  let offset = 0
  for (;;) {
    const page = await f.read(offset, 10003)
    assert.equal(page.invocation, f.id)
    assert.equal(page.delivery, undefined)
    pages.push(page.text)
    offset += page.text.length
    if (offset === page.totalChars) break
  }
  assert.deepEqual(JSON.parse(pages.join('')), f.record.receipt)
  assert.equal((await f.read(1, 2, '/value/text')).text, '😀')
  await assert.rejects(f.read(0, 60001), { code: 'INVALID_RANGE' })
  await assert.rejects(f.read(-1, 20), { code: 'INVALID_RANGE' })
  await assert.rejects(f.read(0, 20, '/value/__proto__'), { code: 'NOT_FOUND' })
  await f.memory.retainMaterial(f.result.resultRef, null, f.signal)
  assert.equal((await f.read(0, 30, '/value/text')).text, value.text.slice(0, 30))
  assert.equal(f.calls, 1)
})

test('INV-70 recall binds authorized script result, execution, session and immutable receipt', async (t) => {
  const f = await fixture(t)
  const another = await f.execute()
  await assert.rejects(f.read(0, 100, undefined, another.resultRef), { code: 'SCOPE_MISMATCH' })
  await assert.rejects(f.read(0, 100, undefined, { sessionId: 'other', id: f.result.resultRef }), {
    code: 'SCOPE_MISMATCH',
  })
  const success = await f.execute(false)
  const succeeded = (await f.journal.list(f.session.id, success.executionId))[0]
  await assert.rejects(f.read(0, 100, undefined, success.resultRef, succeeded.prepared.id), {
    code: 'SCOPE_MISMATCH',
  })
  const forged = await f.session.context.append({
    kind: 'audit',
    title: 'script:forged:result',
    body: JSON.stringify({ executionId: 'forged', recovery: { calls: [{ id: f.id }] } }),
  })
  await assert.rejects(f.read(0, 100, undefined, forged.ref), { code: 'SCOPE_MISMATCH' })
  const broken = f.memoryFor({
    read: async () => ({
      ...f.record,
      receipt: { ...f.record.receipt, invocation: { ...f.record.prepared, executionId: 'other' } },
    }),
  })
  await assert.rejects(broken.readMaterial(f.result.resultRef, 0, 100, f.signal, undefined, f.id), {
    code: 'SCOPE_MISMATCH',
  })
})

test('INV-70 original failed and unknown effects remain explicit; pending journals never become successful receipts', async (t) => {
  const f = await fixture(t)
  const failed = {
    ...f.record,
    receipt: {
      ...f.record.receipt,
      outcome: 'failed',
      effect: 'unknown',
      value: undefined,
      error: { code: 'TEST_FAILURE', message: 'synthetic uncertain result' },
    },
  }
  const memory = f.memoryFor({ read: async () => failed })
  const page = await memory.readMaterial(f.result.resultRef, 0, 60000, f.signal, undefined, f.id)
  assert.deepEqual(JSON.parse(page.text), JSON.parse(JSON.stringify(failed.receipt)))
  assert.equal(page.delivery, undefined)
  const pending = f.memoryFor({
    read: async () => ({ phase: 'prepared', prepared: f.record.prepared }),
  })
  await assert.rejects(
    pending.readMaterial(f.result.resultRef, 0, 100, f.signal, undefined, f.id),
    (error) => error.code === 'UNAVAILABLE' && error.message.includes('outcome=unknown')
  )
})

test('INV-70 asynchronous recall rechecks authorization after journal read; explicit reattachment restores access', async (t) => {
  const f = await fixture(t)
  let enter
  let release
  const entered = new Promise((resolve) => {
    enter = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const blocked = f.memoryFor({
    read: async () => {
      enter()
      await gate
      return f.record
    },
  })
  const reading = blocked.readMaterial(f.result.resultRef, 0, 60000, f.signal, undefined, f.id)
  await entered
  await f.session.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  release()
  await assert.rejects(reading, { code: 'SCOPE_MISMATCH' })
  await assert.rejects(f.read(0, 100), { code: 'SCOPE_MISMATCH' })
  await f.session.context.append({
    kind: 'user',
    body: 'Reauthorize original result',
    sources: [{ sessionId: f.session.id, id: f.result.resultRef }],
  })
  assert.equal(JSON.parse((await f.read(0, 60000)).text).outcome, 'succeeded')
  assert.equal(f.calls, 1)
})

test('INV-70 interrupted persisted execution exposes the same discoverable journal route without replay', async (t) => {
  const f = await fixture(t)
  const goal = await f.session.context.append({
    kind: 'user',
    body: 'Recover interrupted synthetic work',
  })
  const executionId = crypto.randomUUID()
  const prepared = { ...f.record.prepared, id: `${executionId}:1`, executionId }
  await f.journal.claim(prepared)
  await f.journal.prepare(prepared)
  await f.journal.settle({ ...f.record.receipt, invocation: prepared })
  await f.programs.job({
    executionId,
    sourceRef: f.result.sourceRef,
    batchId: 'interrupted',
    status: 'running',
  })
  await f.session.view.begin(goal.ref)
  await f.session.context.append({
    kind: 'audit',
    title: `script:execution:${executionId}`,
    body: JSON.stringify({
      executionId,
      taskId: (await f.session.view.inspect()).id,
      mode: 'execute',
    }),
  })
  await f.session.view.startStep(executionId, undefined, true)
  await f.session.view.end()
  const events = []
  for await (const event of f.session.submit('Continue existing work')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(f.calls, 1)
  const frame = JSON.parse(f.requests[0].materials.find((x) => x.origin === 'runtime-view').text)
  const feedback = frame.partitions.runtime.progress.feedback
  assert.equal(feedback.failure.code, 'INTERRUPTED')
  assert.equal(feedback.recovery.selector, 'invocation')
  const index = await f.memory.readMaterial(
    feedback.recovery.index.ref,
    0,
    60000,
    f.signal,
    feedback.recovery.index.pointer
  )
  assert.equal(JSON.parse(index.text)[0].id, prepared.id)
  const page = await f.memory.readMaterial(
    feedback.recovery.index.ref,
    0,
    60000,
    f.signal,
    undefined,
    prepared.id
  )
  assert.equal(JSON.parse(page.text).outcome, 'succeeded')
})

test('INV-70 caught Kernel failure exposes recovery without inventing a script error', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  const requests = []
  let calls = 0
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model: {
      id: 'caught-failure',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield turn(request, {
            execute: {
              source:
                "import {output} from 'velaros';import {read} from 'test:caught';try{await read(null);}catch{}output('handled',{key:'status',type:'text'});",
            },
          })
          yield { type: 'finish', reason: 'stop' }
        } else {
          const frame = JSON.parse(request.materials.find((x) => x.origin === 'runtime-view').text)
          const feedback = frame.partitions.runtime.progress.feedback
          assert(feedback?.recovery, 'caught failure must retain an actionable recall route')
          assert.equal(feedback.failure, undefined)
          assert(
            frame.partitions.runtime.mandatory.some(
              (x) => x.operation === 'test:caught.read' && x.outcome === 'failed'
            )
          )
          yield* done(request)
        }
      },
    },
    modules: [
      {
        binding: {
          moduleId: 'test:caught',
          instanceId: 'caught',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'caught error',
        operations: {
          read: {
            summary: 'read',
            input: { type: 'null' },
            output: {},
            effects: 'none',
            run: () => {
              calls++
              throw new Error('synthetic caught failure')
            },
          },
        },
      },
    ],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('caught-failure')
  const events = []
  for await (const event of session.submit('Handle the failed read explicitly')) events.push(event)
  assert.equal(
    events.at(-1).status,
    'completed',
    JSON.stringify(events.filter((x) => x.type === 'error'))
  )
  assert.equal(requests.length, 2)
  assert.equal(calls, 1)
})
