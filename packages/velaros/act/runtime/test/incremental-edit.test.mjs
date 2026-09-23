import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createKernelScriptSession, nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { runtimeFrame } from './support/model-turn.mjs'
import { done, turn } from './support/model-turn.mjs'

const observed = "import {output} from 'velaros'; const count = 1; output(count);"
const write = "import {write} from 'test:world'; await write(1);"
const signal = () => new AbortController().signal
async function fixture(
  t,
  stream = async function* (request) {
    yield* done(request)
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'incremental-edit-'))
  const path = join(root, 'state.sqlite')
  const world = { writes: 0, value: 0 }
  const frames = []
  const model = {
    id: 'incremental-test',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      frames.push(runtimeFrame(request.materials.at(-1).text))
      yield* stream(request, frames)
    },
  }
  const modules = [
    {
      binding: { moduleId: 'test:world', instanceId: 'world', generation: 1, schemaRevision: '1' },
      summary: 'world',
      operations: {
        write: {
          summary: 'write',
          input: { type: 'integer' },
          output: { type: 'integer' },
          effects: 'write',
          run: (value) => {
            world.writes++
            return (world.value = value)
          },
        },
      },
    },
  ]
  let storage = localContextStorage({ path })
  let runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules, model })
  let session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'Update the counter and observe progress.' })
  const f = {
    world,
    frames,
    path,
    get session() {
      return session
    },
    get storage() {
      return storage
    },
    get runtime() {
      return runtime
    },
    records: () => storage.load('s').then((s) => s.records),
    state: async () => new ProgramContext('s', session.context, storage).state(),
    source: async (ref) => {
      const row = (await storage.load('s')).records.find((r) => r.ref.id === ref)
      return JSON.parse(await storage.get('s', row.objectId))
    },
    restart: async () => {
      await runtime.close()
      storage = localContextStorage({ path })
      runtime = await createRuntime({ storage, runner: nodeSubprocessCodeRunner, modules, model })
      session = await runtime.openSession('s')
    },
    submit: async () => {
      const events = []
      for await (const e of session.submit('Continue')) events.push(e)
      assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
      return events
    },
  }
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}
async function rejection(promise, code) {
  try {
    await promise
    assert.fail('expected rejection')
  } catch (error) {
    assert.equal(error.code, code, JSON.stringify(error))
    return error
  }
}

// Exercise the public Script session method; it must remain a pure editing operation.
test('exact edits preserve CRLF, Unicode and comments; insertion/deletion use one baseline', () => {
  const edit = createKernelScriptSession({}).edit.bind(createKernelScriptSession({}))
  const original = {
    source: '// 持续观察\r\nconst a = 1;\r\nconst b = 2;\r\n',
    modules: { 'helper.js': 'export const h = 3;' },
    input: { limit: 4 },
    blobs: { data: 'saved' },
  }
  const result = edit(original, [
    { oldText: 'const a = 1;', newText: 'const a = 10;\r\n// 插入' },
    { oldText: 'const b = 2;\r\n', newText: '' },
    { module: 'helper.js', oldText: '3', newText: '4' },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.program.source, '// 持续观察\r\nconst a = 10;\r\n// 插入\r\n')
  assert.equal(result.program.modules['helper.js'], 'export const h = 4;')
  assert.deepEqual(result.program.input, original.input)
  assert.deepEqual(result.program.blobs, original.blobs)
  assert.equal(original.source.includes('const b'), true)
  for (const edits of [
    [{ oldText: 'x', newText: 'y' }],
    [{ oldText: '', newText: 'y' }],
    [{ oldText: 'const', newText: 'let' }],
    [
      { oldText: 'const a', newText: 'let a' },
      { oldText: 'a = 1', newText: 'a = 3' },
    ],
    [
      { oldText: 'const a', newText: 'let a' },
      { oldText: 'let a', newText: 'var a' },
    ],
    [{ module: 'missing', oldText: 'x', newText: 'y' }],
  ])
    assert.equal(edit(original, edits).ok, false)
  assert.equal(edit(original, []).ok, false)
  assert.equal(edit(original, Array(33).fill({ oldText: 'x', newText: 'y' })).ok, false)
})

test('observe edits publish atomically; no-op and automatic observation reruns reuse the version', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const v2 = await f.session.observe({
    sourceRef: v1.sourceRef,
    edits: [{ oldText: 'count = 1', newText: 'count = 2' }],
  })
  assert.equal(v2.status, 'updated')
  assert.equal(v2.executed, false)
  assert.equal(v2.parentRef, v1.sourceRef)
  assert.equal(v2.effective, 'next-model-turn')
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 2)
  await f.submit()
  await f.submit()
  assert.equal(f.frames[0].observation.resultSourceRef, v2.sourceRef)
  assert.match(f.frames[0].observation.text, /"default": 2/)
  assert.equal((await f.records()).filter((r) => /^script:[0-9a-f-]{36}$/.test(r.title)).length, 2)
  const same = await f.session.observe({
    sourceRef: v2.sourceRef,
    edits: [{ oldText: 'count = 2', newText: 'count = 2' }],
  })
  assert.equal(same.status, 'unchanged')
  assert.equal(same.sourceRef, v2.sourceRef)
})

test('later failed edit does not publish earlier replacements; rejection identifies zero-based index', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const error = await rejection(
    f.session.observe({
      sourceRef: v1.sourceRef,
      edits: [
        { oldText: 'count = 1', newText: 'count = 2' },
        { oldText: 'missing', newText: 'x' },
      ],
    }),
    'SCRIPT_EDIT'
  )
  assert.equal(error.editIndex, 1)
  assert.equal(error.draftRef, undefined)
  assert.equal((await f.state()).observation, v1.sourceRef)
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 1)
})

test('INV-8 failed checks persist a repairable draft, including after restart; stale draft cannot overwrite head', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const bad = await rejection(
    f.session.observe({
      sourceRef: v1.sourceRef,
      edits: [{ oldText: 'count = 1', newText: 'count = missing' }],
    }),
    'OBSERVATION_CHECK'
  )
  assert.ok(bad.draftRef)
  assert.ok(bad.diagnostics.length)
  assert.match(bad.diagnostics[0].frame, /count = missing/)
  assert.match(bad.diagnostics[0].frame, /\^/)
  assert.equal((await f.state()).observation, v1.sourceRef)
  await f.restart()
  const fixed = await f.session.observe({
    sourceRef: bad.draftRef,
    edits: [{ oldText: 'count = missing', newText: 'count = 2' }],
  })
  assert.equal(fixed.parentRef, bad.draftRef)
  assert.match((await f.source(fixed.sourceRef)).source, /count = 2/)
  const stale = await rejection(
    f.session.observe({
      sourceRef: bad.draftRef,
      edits: [{ oldText: 'count = missing', newText: 'count = 3' }],
    }),
    'SCRIPT_CONFLICT'
  )
  assert.equal(stale.currentRef, fixed.sourceRef)
})

test('module edits preserve untouched modules, input and blobs, while explicit overrides replace values', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({
    source: "import {output} from 'velaros';import {n} from './helper.js';output(n);",
    modules: { 'helper.js': 'export const n = 1;', 'untouched.js': 'export const t = 2;' },
    input: { old: true },
    blobs: { a: 'old' },
  })
  const v2 = await f.session.observe({
    sourceRef: v1.sourceRef,
    edits: [{ module: 'helper.js', oldText: 'n = 1', newText: 'n = 5' }],
    input: { new: true },
  })
  const saved = await f.source(v2.sourceRef)
  assert.equal(saved.modules['untouched.js'], 'export const t = 2;')
  assert.deepEqual(saved.input, { new: true })
  assert.deepEqual(saved.blobs, { a: 'old' })
  await f.submit()
  assert.match(f.frames[0].observation.text, /"default": 5/)
})

test('execution edits run once, return actual identities, and leave stable observer unchanged', async (t) => {
  const f = await fixture(t)
  const observer = await f.session.observe({ source: observed })
  const first = await f.session.execute({ source: write })
  assert.equal(first.checked, true)
  assert.equal(first.result.failed, undefined)
  const input = {
    sourceRef: first.sourceRef,
    edits: [{ oldText: 'write(1)', newText: 'write(2)' }],
  }
  const next = await f.session.execute(input, 2, undefined, { callId: 'edit-and-run' })
  assert.equal(next.result.failed, undefined)
  assert.notEqual(next.sourceRef, first.sourceRef)
  assert.equal(next.parentRef, first.sourceRef)
  assert.equal((await f.source(next.resultRef)).executionId, next.executionId)
  assert.equal(f.world.writes, 2)
  assert.equal((await f.state()).observation, observer.sourceRef)
  const duplicate = await f.session.execute(input, 2, undefined, { callId: 'edit-and-run' })
  assert.deepEqual(duplicate, next)
  assert.equal(f.world.writes, 2)
  await f.restart()
  assert.deepEqual(await f.session.execute(input, 2, undefined, { callId: 'edit-and-run' }), next)
  assert.equal(f.world.writes, 2)
  await rejection(
    f.session.execute(
      { ...input, edits: [{ oldText: 'write(1)', newText: 'write(3)' }] },
      2,
      undefined,
      { callId: 'edit-and-run' }
    ),
    'SCRIPT_CALL_CONFLICT'
  )
})

test('same accepted observe request returns original publication after restart without a second version', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const input = { sourceRef: v1.sourceRef, edits: [{ oldText: 'count = 1', newText: 'count = 2' }] }
  const v2 = await f.session.observe(input, undefined, { callId: 'save-once' })
  await f.restart()
  assert.deepEqual(await f.session.observe(input, undefined, { callId: 'save-once' }), v2)
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 2)
})

test('successive model turns advance the observation precondition and expose separate source/output changes', async (t) => {
  let edited
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      const sourceRef = frames[0].observation.sourceRef
      yield turn(request, {
        observe: { sourceRef, edits: [{ oldText: 'count = 1', newText: 'count = 2' }] },
      })
      yield { type: 'finish', reason: 'stop' }
    } else if (frames.length === 2) {
      yield turn(request, {
        observe: { source: observed.replace('count = 1', 'count = 3') },
        execute: { source: write },
      })
      yield { type: 'finish', reason: 'stop' }
    } else {
      edited = frames.at(-1)
      yield* done(request)
    }
  })
  await f.session.observe({ source: observed })
  await f.submit()
  assert.equal(f.world.writes, 1)
  assert.match(edited.observation.source, /count = 3/)
  assert.match(edited.observation.text, /"default": 3/)
  assert.equal(edited.progress.script.changed, true)
  assert.equal(edited.progress.observation.changed, true)
  const requests = (await f.records()).filter((r) => r.title === 'model-request')
  const controls = (await f.records()).filter((r) => r.title.startsWith('script:control:'))
  assert.equal(requests.length, 3)
  assert.equal(controls.filter((r) => !r.ref.id.endsWith(':completed')).length, 3)
})

test('incremental failure prevents the paired execution and includes the draft in the next frame', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      yield turn(request, {
        observe: {
          sourceRef: frames[0].observation.sourceRef,
          edits: [{ oldText: 'count = 1', newText: 'count = missing' }],
        },
        execute: { source: write },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const v1 = await f.session.observe({ source: observed })
  await f.submit()
  assert.equal(f.world.writes, 0)
  assert.equal(f.frames[1].observation.sourceRef, v1.sourceRef)
  assert.match(f.frames[1].results[0].text, /draftRef/)
  assert.match(f.frames[1].results[0].source, /count = missing/)
})

test('CAS rejects a concurrent head change and preserves unrelated context appends', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const storage2 = localContextStorage({ path: f.path })
  const context2 = createContextRuntime({ sessionId: 's', storage: storage2 })
  const other = new ProgramContext('s', context2, storage2)
  t.after(() => storage2.close())
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let raced = false
  f.storage.compareAndSwapMetadata = async (id, expected, state, append = []) => {
    if (
      !raced &&
      append.some(
        (r) => r.title.startsWith('script:version:') && r.title !== `script:version:${v1.sourceRef}`
      )
    ) {
      raced = true
      const control = {
        id: crypto.randomUUID(),
        fingerprint: 'other',
        expectedObservation: v1.sourceRef,
      }
      const sourceRef = crypto.randomUUID()
      await other.publish(
        [
          {
            program: { source: observed.replace('count = 1', 'count = 9') },
            version: {
              sourceRef,
              parentRef: v1.sourceRef,
              baseObservation: v1.sourceRef,
              kind: 'observation',
            },
            receipt: { status: 'updated', sourceRef, executed: false },
          },
        ],
        control,
        {
          status: 'completed',
          executed: false,
          observe: { status: 'updated', sourceRef, executed: false },
        },
        true,
        false,
        signal()
      )
      await context2.append({ kind: 'event', title: 'concurrent-event', body: 'must survive' })
    }
    return original(id, expected, state, append)
  }
  const error = await rejection(
    f.session.observe({
      sourceRef: v1.sourceRef,
      edits: [{ oldText: 'count = 1', newText: 'count = 2' }],
    }),
    'SCRIPT_CONFLICT'
  )
  assert.match((await f.source(error.currentRef)).source, /count = 9/)
  assert.ok((await f.records()).some((r) => r.title === 'concurrent-event'))
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 2)
})

test('publication retries an unrelated CAS change without dropping leases or the event', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let injected = false
  f.storage.compareAndSwapMetadata = async (id, expected, state, append = []) => {
    if (
      !injected &&
      append.some(
        (r) => r.title.startsWith('script:version:') && r.title !== `script:version:${v1.sourceRef}`
      )
    ) {
      injected = true
      await f.session.context.append({ kind: 'event', title: 'unrelated', body: 'preserve' })
    }
    return original(id, expected, state, append)
  }
  const v2 = await f.session.observe({
    sourceRef: v1.sourceRef,
    edits: [{ oldText: 'count = 1', newText: 'count = 2' }],
  })
  assert.equal((await f.state()).observation, v2.sourceRef)
  assert.ok((await f.records()).some((r) => r.title === 'unrelated'))
})

test('foreign references and mutually exclusive or empty edits are rejected before execution', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const other = await f.runtime.openSession('other')
  await other.context.append({ kind: 'user', body: 'different session' })
  await assert.rejects(
    other.observe({ sourceRef: v1.sourceRef, edits: [{ oldText: '1', newText: '2' }] })
  )
  for (const input of [
    { source: write, edits: [{ oldText: '1', newText: '2' }] },
    { sourceRef: v1.sourceRef, edits: [] },
    { sourceRef: v1.sourceRef, edits: Array(33).fill({ oldText: '1', newText: '2' }) },
  ])
    await assert.rejects(f.session.execute(input))
  assert.equal(f.world.writes, 0)
})

test('a historical selection creates a fresh commit even when its code matches the active content', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  await f.session.observe({ source: observed.replace('count = 1', 'count = 2') })
  const v3 = await f.session.observe({ source: observed })
  const v4 = await f.session.observe({ sourceRef: v1.sourceRef })
  assert.notEqual(v4.sourceRef, v3.sourceRef)
  assert.notEqual(v4.sourceRef, v1.sourceRef)
  assert.equal(v4.parentRef, v1.sourceRef)
})

test('a stale model frame cannot replace an observation changed by another runtime', async (t) => {
  let head
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      const sourceRef = frames[0].observation.sourceRef
      const control = {
        id: crypto.randomUUID(),
        fingerprint: 'external',
        expectedObservation: sourceRef,
      }
      head = crypto.randomUUID()
      await external.publish(
        [
          {
            program: { source: observed.replace('count = 1', 'count = 9') },
            version: { sourceRef: head, baseObservation: sourceRef, kind: 'observation' },
            receipt: { status: 'updated', sourceRef: head, executed: false },
          },
        ],
        control,
        {
          status: 'completed',
          executed: false,
          observe: { status: 'updated', sourceRef: head, executed: false },
        },
        true,
        false,
        signal()
      )
      yield turn(request, {
        observe: { source: observed.replace('count = 1', 'count = 4') },
        execute: { source: write },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const external = new ProgramContext('s', f.session.context, f.storage)
  await f.session.observe({ source: observed })
  await f.submit()
  assert.equal((await f.state()).observation, head)
  assert.equal(f.world.writes, 0)
  assert.match(f.frames[1].results[0].text, /SCRIPT_CONFLICT/)
})

test('object saved before failed publication cannot replace the active version', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let fail = true
  f.storage.compareAndSwapMetadata = async (id, expected, state, append = []) => {
    if (
      fail &&
      id === 's' &&
      append.some(
        (r) => r.title.startsWith('script:version:') && r.title !== `script:version:${v1.sourceRef}`
      )
    ) {
      fail = false
      throw Object.assign(new Error('injected publication failure'), {
        code: 'STORAGE_TEST_FAILURE',
      })
    }
    return original(id, expected, state, append)
  }
  await rejection(
    f.session.observe({
      sourceRef: v1.sourceRef,
      edits: [{ oldText: 'count = 1', newText: 'count = 2' }],
    }),
    'STORAGE_TEST_FAILURE'
  )
  assert.equal((await f.state()).observation, v1.sourceRef)
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 1)
})

test('publication survives lost storage acknowledgement and recovers by stable call identity', async (t) => {
  const f = await fixture(t)
  const v1 = await f.session.observe({ source: observed })
  const input = { sourceRef: v1.sourceRef, edits: [{ oldText: 'count = 1', newText: 'count = 2' }] }
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let lost = false
  f.storage.compareAndSwapMetadata = async (id, expected, state, append = []) => {
    const committed = await original(id, expected, state, append)
    if (
      committed &&
      !lost &&
      append.some(
        (r) => r.title.startsWith('script:version:') && r.title !== `script:version:${v1.sourceRef}`
      )
    ) {
      lost = true
      throw Error('injected lost publication acknowledgement')
    }
    return committed
  }
  await assert.rejects(
    f.session.observe(input, undefined, { callId: 'lost-observe' }),
    /injected lost/
  )
  const committed = (await f.state()).observation
  assert.notEqual(committed, v1.sourceRef)
  await f.restart()
  const recovered = await f.session.observe(input, undefined, { callId: 'lost-observe' })
  assert.equal(recovered.sourceRef, committed)
  assert.equal((await f.records()).filter((r) => r.title.startsWith('script:version:')).length, 2)
})

test('INV-9 uncertain submission recovery never reruns a script whose write already happened', async (t) => {
  const f = await fixture(t)
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let fail = true
  f.storage.compareAndSwapMetadata = async (id, expected, state, append = []) => {
    if (
      fail &&
      append.some((r) => r.title.startsWith('script:control:') && r.ref.id.endsWith(':completed'))
    ) {
      fail = false
      throw Error('injected crash before completion receipt')
    }
    return original(id, expected, state, append)
  }
  await assert.rejects(
    f.session.execute({ source: write }, 2, undefined, { callId: 'lost-execute' }),
    /injected crash/
  )
  assert.equal(f.world.writes, 1)
  await f.restart()
  const failure = await rejection(
    f.session.execute({ source: write }, 2, undefined, { callId: 'lost-execute' }),
    'SCRIPT_UNRESOLVED'
  )
  assert.equal(failure.effect, 'unknown')
  assert.equal(f.world.writes, 1)
})
