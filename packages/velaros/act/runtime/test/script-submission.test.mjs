import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { runtimeFrame } from './support/model-turn.mjs'
import { done, turn } from './support/model-turn.mjs'

const observe =
  "import {output} from 'velaros'; import {read} from 'test:world'; output({value:await read()});"
const execute = "import {write} from 'test:world'; await write(2);"
const platformHasDefaultConfinement = process.platform === 'darwin' || process.platform === 'linux'
async function fixture(
  t,
  stream = async function* (request) {
    yield* done(request)
  }
) {
  const root = await mkdtemp(join(tmpdir(), 'script-submit-'))
  const path = join(root, 'state.sqlite')
  const world = { value: 1, writes: 0, reads: 0 }
  const frames = []
  const model = {
    id: 'submission',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      assert.equal(request.response.type, 'text')
      frames.push(runtimeFrame(request))
      yield* stream(request, frames)
    },
  }
  const modules = [
    {
      binding: { moduleId: 'test:world', instanceId: 'world', generation: 1, schemaRevision: '1' },
      summary: 'world',
      operations: {
        read: {
          summary: 'read',
          input: { type: 'null' },
          output: { type: 'integer' },
          effects: 'none',
          run: () => {
            world.reads++
            return world.value
          },
        },
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
  let runtime = await createRuntime({ storage, modules, model })
  let session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'Maintain a counter.' })
  const f = {
    world,
    frames,
    path,
    get session() {
      return session
    },
    get runtime() {
      return runtime
    },
    get storage() {
      return storage
    },
    state: () => new ProgramContext('s', session.context, storage).state(),
    restart: async () => {
      await runtime.close()
      storage = localContextStorage({ path })
      runtime = await createRuntime({ storage, modules, model })
      session = await runtime.openSession('s')
    },
    submit: async () => {
      const events = []
      for await (const event of session.submit('Continue')) events.push(event)
      assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
    },
  }
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}

function holdMetadataRead(storage) {
  const original = storage.loadMetadata.bind(storage)
  let release
  let notify
  const gate = new Promise((resolve) => (release = resolve))
  const entered = new Promise((resolve) => (notify = resolve))
  let held = false
  storage.loadMetadata = async (id) => {
    const metadata = await original(id)
    if (id === 's' && !held) {
      held = true
      notify()
      await gate
    }
    return metadata
  }
  return { entered, release }
}

test('model admission owns recovery before another model or host script can enter', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      yield turn(request, { execute: { source: execute } })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const gate = holdMetadataRead(f.storage)
  const first = f.submit()
  const competing = f.session.submit('Competing input')[Symbol.asyncIterator]()
  try {
    await gate.entered
    assert.equal((await f.storage.load('s')).records.filter((r) => r.kind === 'user').length, 1)
    assert.equal(f.frames.length, 0)
    await assert.rejects(competing.next(), { code: 'CONFLICT' })
    await assert.rejects(f.session.script({ execute: { source: execute } }), { code: 'CLOSED' })
    assert.equal(f.world.writes, 0)
  } finally {
    gate.release()
    await competing.return()
    await first
  }
  assert.equal(f.world.writes, 1)
  assert.equal(f.frames.length, 2)
  await f.submit()
  assert.equal(f.frames.length, 3)
  assert.equal(f.world.writes, 1)
})

test('host admission owns recovery while duplicates share the same actual execution', async (t) => {
  const f = await fixture(t)
  const gate = holdMetadataRead(f.storage)
  const input = { execute: { source: execute } }
  const options = { callId: 'recovery-owner' }
  const first = f.session.script(input, undefined, options)
  const competing = f.session.submit('Competing input')[Symbol.asyncIterator]()
  try {
    await gate.entered
    assert.equal(f.frames.length, 0)
    await assert.rejects(competing.next(), { code: 'CLOSED' })
    await assert.rejects(f.session.script(input, undefined, { callId: 'different-owner' }), {
      code: 'SCRIPT_BUSY',
    })
    await assert.rejects(
      f.session.script(
        { execute: { source: `${execute}\n// different payload` } },
        undefined,
        options
      ),
      { code: 'SCRIPT_CALL_CONFLICT' }
    )
    const duplicate = f.session.script(input, undefined, options)
    gate.release()
    const [a, b] = await Promise.all([first, duplicate])
    assert.deepEqual(a, b)
    assert.equal(a.executed, true)
    assert.equal(f.world.writes, 1)
  } finally {
    gate.release()
    await competing.return()
    await first
  }
  await f.submit()
  assert.equal(f.frames.length, 1)
  assert.equal(f.world.writes, 1)
})

test('a host script awaiting its baseline cannot enter a newly admitted model run', async (t) => {
  let releaseModel
  let notifyModel
  const modelGate = new Promise((resolve) => (releaseModel = resolve))
  const modelEntered = new Promise((resolve) => (notifyModel = resolve))
  const f = await fixture(t, async function* (request) {
    notifyModel()
    await modelGate
    yield* done(request)
  })
  const original = f.storage.selectSnapshot.bind(f.storage)
  let releaseBaseline
  let notifyBaseline
  const baselineGate = new Promise((resolve) => (releaseBaseline = resolve))
  const baselineEntered = new Promise((resolve) => (notifyBaseline = resolve))
  let held = false
  f.storage.selectSnapshot = async (id, selections) => {
    const snapshot = await original(id, selections)
    if (!held && selections.some((item) => item.title === 'script:lease-state')) {
      held = true
      notifyBaseline()
      await baselineGate
    }
    return snapshot
  }
  const rejected = assert.rejects(f.session.script({ execute: { source: execute } }), {
    code: 'SCRIPT_BUSY',
  })
  let running
  try {
    await baselineEntered
    running = f.submit()
    await modelEntered
    releaseBaseline()
    await rejected
    assert.equal(f.world.writes, 0)
  } finally {
    releaseBaseline()
    releaseModel()
    await Promise.all([rejected, running])
  }
  assert.equal(f.frames.length, 1)
  const accepted = await f.session.script({ execute: { source: execute } })
  assert.equal(accepted.executed, true)
  assert.equal(f.world.writes, 1)
})

test('a recovery storage failure releases model admission without accepting the input', async (t) => {
  const f = await fixture(t)
  const original = f.storage.loadMetadata.bind(f.storage)
  const failure = new Error('recovery metadata unavailable')
  let injected = false
  f.storage.loadMetadata = async (id) => {
    const metadata = await original(id)
    if (!injected) {
      injected = true
      throw failure
    }
    return metadata
  }
  await assert.rejects(f.submit(), (error) => error === failure)
  assert.equal(f.frames.length, 0)
  assert.equal(f.world.writes, 0)
  assert.equal((await f.storage.load('s')).records.filter((r) => r.kind === 'user').length, 1)
  await f.submit()
  assert.equal(f.frames.length, 1)
})

for (const cancel of ['source', 'session']) {
  test(`${cancel} cancellation during recovery releases admission without starting the model`, async (t) => {
    const f = await fixture(t)
    const gate = holdMetadataRead(f.storage)
    const source = new AbortController()
    const failure = new Error('cancel before model admission completes')
    const rejected = assert.rejects(
      async () => {
        for await (const event of f.session.submit('Cancelled input', source.signal)) {
          assert.fail(`recovery cancellation cannot emit ${event.type}`)
        }
      },
      (error) => (cancel === 'source' ? error === failure : error.name === 'AbortError')
    )
    try {
      await gate.entered
      if (cancel === 'source') source.abort(failure)
      else f.session.cancel()
    } finally {
      gate.release()
      await rejected
    }
    assert.equal(f.frames.length, 0)
    assert.equal(f.world.writes, 0)
    assert.equal((await f.storage.load('s')).records.filter((r) => r.kind === 'user').length, 1)
    await f.submit()
    assert.equal(f.frames.length, 1)
  })
}

test('close drains a blocked recovery read and never starts its admitted model afterward', async (t) => {
  const f = await fixture(t)
  const gate = holdMetadataRead(f.storage)
  const rejected = assert.rejects(f.submit(), { code: 'CLOSED' })
  let closed = false
  let closing
  try {
    await gate.entered
    closing = f.session.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'close must drain the actual outstanding storage read')
    assert.equal(f.frames.length, 0)
  } finally {
    gate.release()
    await Promise.all([rejected, closing])
  }
  assert.equal(closed, true)
  assert.equal(f.frames.length, 0)
  assert.equal(f.world.writes, 0)
  assert.equal((await f.storage.load('s')).records.filter((r) => r.kind === 'user').length, 1)
  await assert.rejects(f.submit(), { code: 'CLOSED' })
  await assert.rejects(f.session.script({ execute: { source: execute } }), { code: 'CLOSED' })
})

test('one model call publishes observer, executes once and sends fresh context with a leased result', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      yield turn(request, {
        observe: { source: observe },
        execute: { source: execute, retainTurns: 2 },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  await f.submit()
  assert.deepEqual(f.world, { value: 2, writes: 1, reads: platformHasDefaultConfinement ? 1 : 0 })
  if (platformHasDefaultConfinement)
    assert.equal(JSON.parse(f.frames[1].observation.text).value.default.value, 2)
  else assert.match(f.frames[1].observation.text, /SHELL_CONFINEMENT_UNAVAILABLE/)
  assert.equal(f.frames[1].results[0].remainingTurns, 2)
  const journal = await createContextInvocationJournal(f.storage).list('s')
  assert.deepEqual(
    journal.map((x) => [x.prepared.binding.moduleId, x.prepared.operation, x.prepared.mode]),
    [
      ['test:world', 'write', 'execute'],
      ...(platformHasDefaultConfinement ? [['test:world', 'read', 'observe']] : []),
    ]
  )
  t.diagnostic(
    JSON.stringify({
      kind: 'single-script-trace',
      response: 'scriptact-text',
      world: f.world,
      observation: JSON.parse(f.frames[1].observation.text),
      remainingTurns: f.frames[1].results[0].remainingTurns,
      kernelCalls: journal.map((x) => ({
        module: x.prepared.binding.moduleId,
        operation: x.prepared.operation,
        mode: x.prepared.mode,
      })),
    })
  )
})

test('either invalid candidate rejects the entire submission before publishing or writing', async (t) => {
  const f = await fixture(t)
  const initial = await f.session.script({ observe: { source: observe } })
  for (const input of [
    { observe: { source: `${observe}\n// new observer` }, execute: { source: 'const = ;' } },
    { observe: { source: 'const = ;' }, execute: { source: execute } },
    {
      observe: { edits: [{ oldText: 'missing', newText: 'value' }] },
      execute: { source: execute },
    },
  ]) {
    const result = await f.session.script(input)
    assert.equal(result.status, 'rejected')
    assert.equal(result.executed, false)
    assert.equal((await f.state()).observation, initial.observe.sourceRef)
    assert.equal(f.world.writes, 0)
  }
  const versions = (await f.storage.load('s')).records.filter((x) =>
    x.title.startsWith('script:version:')
  )
  const committed = []
  for (const r of versions) {
    const v = JSON.parse(await f.storage.get('s', r.objectId))
    if (v.kind === 'observation') committed.push(v)
  }
  assert.equal(committed.length, 1)
})

test('INV-11 implicit edits bind to the displayed observation and can accompany execution', async (t) => {
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      yield turn(request, {
        observe: { edits: [{ oldText: 'value:await read()', newText: 'current:await read()' }] },
        execute: { source: execute, retainTurns: 1 },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const initial = await f.session.script({ observe: { source: observe } })
  await f.submit()
  assert.notEqual(f.frames[1].observation.sourceRef, initial.observe.sourceRef)
  if (platformHasDefaultConfinement)
    assert.equal(JSON.parse(f.frames[1].observation.text).value.default.current, 2)
  else {
    assert.match(f.frames[1].observation.text, /SHELL_CONFINEMENT_UNAVAILABLE/)
    assert.equal(f.world.reads, 0)
  }
  assert.equal(f.frames[1].results[0].remainingTurns, 1)
  assert.equal(f.world.writes, 1)
})

test('implicit edits require an installed observation; execution edits require an explicit sourceRef', async (t) => {
  const f = await fixture(t)
  const edits = [{ oldText: 'value', newText: 'current' }]
  const missing = await f.session.script({ observe: { edits }, execute: { source: execute } })
  assert.equal(missing.status, 'rejected')
  assert.equal(missing.observe.code, 'SCRIPT_REF')
  assert.equal(f.world.writes, 0)
  for (const input of [
    {},
    { observe: {} },
    { execute: { edits } },
    { observe: { source: observe, sourceRef: 'mixed' } },
    { execute: { source: execute, retainTurns: 33 } },
    { observe: { source: observe }, extra: true },
  ])
    await assert.rejects(f.session.script(input), { code: 'INPUT_SCHEMA' })
  assert.equal((await f.state()).observation, undefined)
})

test('omitted sections preserve observer and do not run one-shot code', async (t) => {
  const f = await fixture(t)
  const first = await f.session.script({ observe: { source: observe } })
  assert.equal(f.world.reads, 0)
  assert.equal(first.executed, false)
  const second = await f.session.script({ execute: { source: execute } })
  assert.equal(second.executed, true)
  assert.equal((await f.state()).observation, first.observe.sourceRef)
  await f.submit()
  assert.equal(f.world.writes, 1)
  assert.equal(f.world.reads, platformHasDefaultConfinement ? 1 : 0)
  if (!platformHasDefaultConfinement)
    assert.match(f.frames[0].observation.text, /SHELL_CONFINEMENT_UNAVAILABLE/)
})

test('combined retries return the original receipt across restart without advancing versions or writing again', async (t) => {
  const f = await fixture(t)
  const input = { observe: { source: observe }, execute: { source: execute } }
  const options = { callId: 'one-submission' }
  const first = await f.session.script(input, undefined, options)
  const duplicate = await f.session.script(input, undefined, options)
  assert.deepEqual(duplicate, first)
  await f.restart()
  assert.deepEqual(await f.session.script(input, undefined, options), first)
  assert.equal(f.world.writes, 1)
  assert.equal((await f.state()).observation, first.observe.sourceRef)
  await assert.rejects(f.session.script({ observe: { source: observe } }, undefined, options), {
    code: 'SCRIPT_CALL_CONFLICT',
  })
})

test('a prepared composite submission cannot replay after lost publication acknowledgement', async (t) => {
  const f = await fixture(t)
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let injected = false
  f.storage.compareAndSwapMetadata = async (id, version, state, append = []) => {
    const committed = await original(id, version, state, append)
    if (committed && !injected && append.some((x) => x.title.startsWith('script:control:'))) {
      injected = true
      throw Error('lost after atomic preparation')
    }
    return committed
  }
  const input = { observe: { source: observe }, execute: { source: execute } }
  const options = { callId: 'prepared' }
  await assert.rejects(f.session.script(input, undefined, options), /lost after atomic/)
  assert.ok((await f.state()).observation)
  assert.equal(f.world.writes, 0)
  await f.restart()
  await assert.rejects(f.session.script(input, undefined, options), { code: 'SCRIPT_UNRESOLVED' })
  assert.equal(f.world.writes, 0)
})

test('in-flight duplicates share one execution and conflicting payloads cannot reuse its identity', async (t) => {
  const f = await fixture(t)
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let release
  let entered
  const gate = new Promise((r) => (release = r))
  const waiting = new Promise((r) => (entered = r))
  let held = false
  f.storage.compareAndSwapMetadata = async (id, version, state, append = []) => {
    if (!held && append.some((x) => x.title.startsWith('script:control:'))) {
      held = true
      entered()
      await gate
    }
    return original(id, version, state, append)
  }
  const input = { observe: { source: observe }, execute: { source: execute } }
  const options = { callId: 'in-flight' }
  const first = f.session.script(input, undefined, options)
  await waiting
  const duplicate = f.session.script(input, undefined, options)
  await assert.rejects(f.session.script({ execute: { source: execute } }, undefined, options), {
    code: 'SCRIPT_CALL_CONFLICT',
  })
  release()
  const [a, b] = await Promise.all([first, duplicate])
  assert.deepEqual(a, b)
  assert.equal(f.world.writes, 1)
})

test('execution runtime failure keeps the published observer available for diagnosis', async (t) => {
  const f = await fixture(t)
  const result = await f.session.script({
    observe: { source: observe },
    execute: { source: "throw Error('business failure');" },
  })
  assert.equal(result.executed, true)
  assert.ok(result.execute.result.failed)
  assert.equal((await f.state()).observation, result.observe.sourceRef)
  await f.submit()
  if (platformHasDefaultConfinement)
    assert.equal(JSON.parse(f.frames[0].observation.text).value.default.value, 1)
  else {
    assert.match(f.frames[0].observation.text, /SHELL_CONFINEMENT_UNAVAILABLE/)
    assert.equal(f.world.reads, 0)
  }
})

test('a stale displayed baseline rejects implicit edits and the accompanying execution', async (t) => {
  let head
  const f = await fixture(t, async function* (request, frames) {
    if (frames.length === 1) {
      const base = frames[0].observation.sourceRef
      head = crypto.randomUUID()
      const receipt = { status: 'updated', executed: false, sourceRef: head }
      await external.publish(
        [
          {
            program: { source: `${observe}\n// Changed by another writer` },
            version: { sourceRef: head, baseObservation: base, kind: 'observation' },
            receipt,
          },
        ],
        { id: crypto.randomUUID(), fingerprint: 'external', expectedObservation: base },
        { status: 'completed', executed: false, observe: receipt },
        true,
        false,
        new AbortController().signal
      )
      yield turn(request, {
        observe: { edits: [{ oldText: 'value:await read()', newText: 'current:await read()' }] },
        execute: { source: execute },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  const external = new ProgramContext('s', f.session.context, f.storage)
  await f.session.script({ observe: { source: observe } })
  await f.submit()
  assert.equal((await f.state()).observation, head)
  assert.equal(f.world.writes, 0)
  assert.match(f.frames[1].results[0].text, /SCRIPT_CONFLICT/)
})

test('a concurrent prepared receipt discovered while publishing rejection still requires reconciliation', async (t) => {
  const f = await fixture(t)
  const original = f.storage.compareAndSwapMetadata.bind(f.storage)
  let raced = false
  f.storage.compareAndSwapMetadata = async (id, version, state, append = []) => {
    const record = append.findLast((r) => r.title.startsWith('script:control:'))
    if (!raced && record) {
      raced = true
      const data = JSON.parse(await f.storage.get(id, record.objectId))
      const body = JSON.stringify({ ...data, receipt: { status: 'prepared', executed: false } })
      const replacement = { ...record, objectId: await f.storage.put(id, body), chars: body.length }
      const committed = await original(
        id,
        version,
        state,
        append.map((r) => (r === record ? replacement : r))
      )
      assert.equal(committed, true)
      return false
    }
    return original(id, version, state, append)
  }
  await assert.rejects(
    f.session.script(
      { observe: { source: 'const = ;' }, execute: { source: execute } },
      undefined,
      { callId: 'raced' }
    ),
    { code: 'SCRIPT_UNRESOLVED' }
  )
  assert.equal(f.world.writes, 0)
})
