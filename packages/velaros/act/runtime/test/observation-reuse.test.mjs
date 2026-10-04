import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import { nodeSubprocessCodeRunner, scriptOutputs } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { ScriptTurnDecoder } from '../../../dist/act/runtime/impl/ScriptTurnDecoder.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, marker, runtimeFrame, turn } from './support/model-turn.mjs'

const source =
  "import {read} from 'test:observation';import {output} from 'velaros';output(await read());"
const noop = "import {output} from 'velaros';output('next');"
const finish = { type: 'finish', reason: 'stop' }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const block = (request, options) =>
  `${marker(request)} observe(${JSON.stringify(options)})\n${marker(request)}\n`

async function fixture(t, stream, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scriptact-observation-reuse-'))
  const storage = localContextStorage({ path: join(root, 'state.sqlite') })
  const f = {
    reads: 0,
    value: 1,
    token: 1,
    providerId: 'provider-incarnation:1',
    scope: 'authorization:1',
    frames: [],
    requests: [],
    probes: [],
    calls: 0,
    mode: 'versioned',
    failRead: false,
    registered: new Set(),
    image: false,
    delayedReadMs: 0,
    onRead: () => {},
  }
  const register = (program) =>
    f.registered.add(
      JSON.stringify({
        sourceHash: scriptOutputs.hash({
          source: program.source,
          modules: program.modules,
          language: program.language ?? 'node',
        }),
        inputHash: scriptOutputs.hash({ input: program.input, blobs: program.blobs }),
      })
    )
  register({ source })
  const observation = {
    scope: async (_sessionId, signal) => {
      signal.throwIfAborted()
      return f.scope
    },
    reuse: {
      coversNativeIO: true,
      async probe(input, signal) {
        f.probes.push(input)
        if (
          !f.registered.has(
            JSON.stringify({ sourceHash: input.sourceHash, inputHash: input.inputHash })
          )
        )
          return { kind: 'unknown', reason: 'program-not-registered' }
        if (f.mode === 'error') throw new AppError('UNAVAILABLE', 'version service unavailable')
        if (f.mode === 'timeout')
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        signal.throwIfAborted()
        if (f.mode === 'unknown') return { kind: 'unknown', reason: 'coverage-unknown' }
        return { kind: 'versioned', providerId: f.providerId, token: String(f.token) }
      },
    },
    ...options.observation,
  }
  const model = {
    id: 'observation-proof',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'proof-fixture' }),
    async *stream(request) {
      f.frames.push(runtimeFrame(request))
      f.requests.push(request)
      f.calls++
      yield* stream(request, f)
    },
  }
  const module = {
    binding: {
      moduleId: 'test:observation',
      instanceId: 'world',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'Host-owned monotonic revision proof',
    operations: {
      read: {
        summary: 'read current host fact',
        input: { type: 'null' },
        output: { type: 'integer' },
        effects: 'none',
        async run(_input, context) {
          f.reads++
          await f.onRead()
          if (f.delayedReadMs) await wait(f.delayedReadMs)
          if (f.failRead) throw new AppError('UNAVAILABLE', 'collection unavailable')
          if (f.image)
            context.attach({
              type: 'image-data',
              origin: 'capability',
              label: 'observed',
              mediaType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YLlPysAAAAASUVORK5CYII=',
            })
          return f.value
        },
      },
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [module],
    context: { maintenance: false, ...(options.disabled ? {} : { observation }) },
  })
  const session = await runtime.openSession('s')
  Object.assign(f, {
    root,
    storage,
    runtime,
    session,
    register,
    observation,
    programs: new ProgramContext('s', session.context, storage),
  })
  await session.observe({ source })
  f.reopen = async (generation) => {
    await f.runtime.close()
    if (generation) module.binding = { ...module.binding, generation }
    f.storage = localContextStorage({ path: join(root, 'state.sqlite') })
    f.runtime = await createRuntime({
      storage: f.storage,
      runner: nodeSubprocessCodeRunner,
      model,
      modules: [module],
      context: { maintenance: false, ...(options.disabled ? {} : { observation }) },
    })
    f.session = await f.runtime.openSession('s')
    f.programs = new ProgramContext('s', f.session.context, f.storage)
  }
  t.after(async () => {
    await f.runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}

async function collect(f, input = 'Read and continue', signal) {
  const events = []
  for await (const event of f.session.submit(input, signal)) events.push(event)
  return events
}
const next = async function* (request) {
  yield turn(request, { execute: { source: noop } })
  yield finish
}
const completed = (events) =>
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))

test('Node collects again unless the registered provider explicitly covers native I/O', async (t) => {
  const f = await fixture(t, async function* (request, state) {
    if (state.calls < 3) yield* next(request)
    else yield* done(request)
  })
  delete f.observation.reuse.coversNativeIO
  completed(await collect(f))
  assert.equal(f.reads, 3)
  assert.equal(f.probes.length, 0)
  assert.ok(
    f.frames.every((frame) => frame.observation.freshness.reason === 'native-process-dependencies')
  )
})

test('stable reliable generation reduces actual Runtime observations with original identities and precise traces', async (t) => {
  async function run(disabled) {
    const f = await fixture(
      t,
      async function* (request, f) {
        if (f.calls < 6) yield* next(request)
        else yield* done(request)
      },
      { disabled }
    )
    f.delayedReadMs = 20
    const started = performance.now()
    completed(await collect(f))
    const elapsedMs = performance.now() - started
    const snapshots = (await f.storage.load('s')).records
    const observationResults = []
    for (const record of snapshots.filter((record) =>
      /^script:[0-9a-f-]+:result$/.test(record.title)
    )) {
      const saved = JSON.parse(await f.storage.get('s', record.objectId))
      if (saved.mode === 'observe') observationResults.push(saved)
    }
    return { f, elapsedMs, observationResults }
  }
  const baseline = await run(true)
  const optimized = await run(false)
  assert.equal(baseline.f.reads, 6)
  assert.equal(optimized.f.reads, 1)
  assert.equal(baseline.observationResults.length, 6)
  assert.equal(optimized.observationResults.length, 1)
  assert.deepEqual(
    optimized.f.frames.map((frame) => frame.observation.freshness.status),
    ['collected', 'reused', 'reused', 'reused', 'reused', 'reused']
  )
  assert.equal(new Set(optimized.f.frames.map((frame) => frame.observation.resultRef)).size, 1)
  assert.equal(new Set(optimized.f.frames.map((frame) => frame.observation.observedAt)).size, 1)
  const traces = (await optimized.f.runtime.trace('s', { fullContent: true, limit: 8 })).turns
  assert.equal(traces.length, 6)
  assert.equal(
    traces[0].invocations.filter((item) => item.summary.moduleId === 'test:observation').length,
    1
  )
  for (const trace of traces.slice(1)) {
    assert.equal(trace.observation.run.collection.status, 'reused')
    assert.equal(
      trace.invocations.filter((item) => item.summary.moduleId === 'test:observation').length,
      0
    )
    assert.equal(trace.observation.run.executionId, traces[0].observation.run.executionId)
  }
  const measured = {
    scope:
      'Real Runtime and Node runner with deterministic model decisions; mechanism evidence only',
    turns: 6,
    baseline: {
      realObservations: baseline.f.reads,
      elapsedMs: baseline.elapsedMs,
      scriptMs: baseline.observationResults.reduce(
        (sum, saved) => sum + saved.timing.durationMs,
        0
      ),
    },
    optimized: {
      realObservations: optimized.f.reads,
      elapsedMs: optimized.elapsedMs,
      scriptMs: optimized.observationResults.reduce(
        (sum, saved) => sum + saved.timing.durationMs,
        0
      ),
      probeMs: optimized.f.frames.reduce(
        (sum, frame) => sum + frame.observation.freshness.probeMs,
        0
      ),
    },
  }
  t.diagnostic(JSON.stringify(measured))
  if (process.env.SCRIPT_ACT_OBSERVATION_EVIDENCE_DIR) {
    const directory = process.env.SCRIPT_ACT_OBSERVATION_EVIDENCE_DIR
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'summary.json'),
      `${JSON.stringify(
        {
          collectedAt: new Date().toISOString(),
          sourceHash: scriptOutputs.hash(source),
          ...measured,
          baselineFrames: baseline.f.frames.map((frame) => frame.observation.freshness),
          optimizedFrames: optimized.f.frames.map((frame) => frame.observation.freshness),
          actualProbeCalls: optimized.f.probes.length,
          traceObservationCalls: traces.map(
            (trace) =>
              trace.invocations.filter((item) => item.summary.moduleId === 'test:observation')
                .length
          ),
        },
        null,
        2
      )}\n`
    )
  }
})

test('scope, input, source and provider incarnation changes collect rather than reuse', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) f.scope = 'authorization:2'
    if (f.calls === 2) f.providerId = 'provider-incarnation:2'
    if (f.calls === 3) {
      const program = { source, input: { view: 2 } }
      f.register(program)
      yield turn(request, { observe: program })
      yield finish
      return
    }
    if (f.calls === 4) {
      const program = { source: `${source}\n// observation phase changed`, input: { view: 2 } }
      f.register(program)
      yield turn(request, { observe: program })
      yield finish
      return
    }
    if (f.calls === 5) {
      f.value = 2
      f.token++
    }
    if (f.calls < 7) yield* next(request)
    else yield* done(request)
  })
  completed(await collect(f))
  assert.equal(f.reads, 6)
  assert.equal(f.frames[6].observation.freshness.status, 'reused')
  assert.notEqual(f.frames[0].observation.resultRef, f.frames[1].observation.resultRef)
  assert.match(f.frames[5].observation.text, /2/)
  assert.notEqual(f.probes[0].scopeFingerprint, f.probes[2].scopeFingerprint)
})

test('unknown, failed and timed-out probes collect and do not resurrect an older baseline', async (t) => {
  for (const mode of ['unknown', 'error', 'timeout'])
    await t.test(mode, async (t) => {
      const f = await fixture(
        t,
        async function* (request, f) {
          if (f.calls === 1) f.mode = mode
          if (f.calls === 2) f.mode = 'versioned'
          if (f.calls < 4) yield* next(request)
          else yield* done(request)
        },
        { observation: { probeTimeoutMs: 10 } }
      )
      completed(await collect(f))
      assert.equal(f.reads, 3)
      assert.equal(f.frames[1].observation.freshness.status, 'collected')
      assert.equal(f.frames[2].observation.freshness.status, 'collected')
      assert.equal(f.frames[3].observation.freshness.status, 'reused')
    })
})

test('collection-time changes including ABA invalidate the candidate baseline', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls < 3) yield* next(request)
    else yield* done(request)
  })
  f.onRead = () => {
    if (f.reads === 1) {
      f.value = 2
      f.token++
      f.value = 1
      f.token++
    }
  }
  completed(await collect(f))
  assert.equal(f.reads, 2)
  assert.equal(f.frames[0].observation.freshness.reason, 'version-changed-during-collection')
  assert.equal(f.frames[1].observation.freshness.status, 'collected')
  assert.equal(f.frames[2].observation.freshness.status, 'reused')
})

test('refresh is accepted atomically, protocol repair keeps its frame, and later invalid code cannot publish refresh', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    const sourceRef = f.frames.at(-1).observation.sourceRef
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: `${block(request, {
          sourceRef,
          refresh: true,
        })}${marker(request)} execute()\nconst = ;\n${marker(request)}\n`,
      }
      yield finish
      return
    }
    if (f.calls === 2) {
      yield {
        type: 'text',
        text: `${marker(request)} observe({sourceRef:"${sourceRef}",refresh:true})\n`,
      }
      yield finish
      return
    }
    if (f.calls === 3) {
      yield { type: 'text', text: block(request, { sourceRef, refresh: true }) }
      yield finish
      return
    }
    yield* done(request)
  })
  completed(await collect(f))
  assert.equal(f.reads, 2)
  assert.equal(f.frames[1].observation.freshness.status, 'reused')
  assert.equal(f.frames[1].programFrame.id, f.frames[2].programFrame.id)
  assert.equal(f.frames[1].observation.resultRef, f.frames[2].observation.resultRef)
  assert.equal(f.frames[3].observation.freshness.reason, 'refresh-requested')
  assert.equal((await f.programs.state()).observationRefresh, undefined)
})

test('partial or failed collections never reuse, and refresh does not revive a paused observer', async (t) => {
  const partial = `import {read} from 'test:observation';import {output} from 'velaros';output('partial');await read();`
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 3) {
      yield {
        type: 'text',
        text: block(request, { sourceRef: f.frames.at(-1).observation.sourceRef, refresh: true }),
      }
      yield finish
      return
    }
    if (f.calls === 4) {
      assert.equal(f.frames[3].observation.health.status, 'paused')
      f.failRead = false
      const program = { source: `${partial}\n// repaired observation program` }
      f.register(program)
      yield turn(request, { observe: program })
      yield finish
      return
    }
    if (f.calls < 6) yield* next(request)
    else yield* done(request)
  })
  f.failRead = true
  f.register({ source: partial })
  await f.session.observe({ source: partial })
  completed(await collect(f))
  assert.equal(f.reads, 4)
  assert.equal(f.frames[0].observation.collection, 'partial')
  assert.equal(f.frames[3].observation.freshness.status, 'paused')
  assert.equal(f.frames[4].observation.health.status, 'healthy')
  assert.equal(f.frames[5].observation.freshness.status, 'reused')
})

test('max age expiry forces real collection', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        await wait(15)
        yield* next(request)
      } else yield* done(request)
    },
    { observation: { maxAgeMs: 5 } }
  )
  completed(await collect(f))
  assert.equal(f.reads, 2)
  assert.equal(f.frames[1].observation.freshness.reason, 'max-age')
})

test('full Runtime and storage restart with a new module binding starts with real collection', async (t) => {
  const controller = new AbortController()
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) yield* next(request)
    else if (f.calls === 2) {
      controller.abort()
      yield { type: 'text', text: 'interrupted' }
      yield finish
    } else yield* done(request)
  })
  assert.equal((await collect(f, 'Read', controller.signal)).at(-1).status, 'cancelled')
  assert.equal(f.reads, 1)
  await f.reopen(2)
  completed(await collect(f, 'Continue after restart'))
  assert.equal(f.reads, 2)
  assert.equal(f.frames.at(-1).observation.freshness.status, 'collected')
  assert.equal(f.frames.at(-1).observation.freshness.reason, 'no-current-process-baseline')
  assert.notEqual(f.probes[0].scopeFingerprint, f.probes.at(-1).scopeFingerprint)
})

test('reused images follow their original references; missing attachment triggers real collection', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 2) {
      const saved = await f.storage.load('s')
      const attachment = saved.records.find((record) => record.title.startsWith('image:'))
      const get = f.storage.get.bind(f.storage)
      let missing = true
      f.storage.get = async (sessionId, objectId) => {
        if (missing && objectId === attachment.objectId) {
          missing = false
          return null
        }
        return get(sessionId, objectId)
      }
    }
    if (f.calls < 3) yield* next(request)
    else yield* done(request)
  })
  f.image = true
  completed(await collect(f))
  assert.equal(f.reads, 2)
  assert.equal(f.frames[1].observation.freshness.status, 'reused')
  assert.equal(f.frames[0].observation.resultRef, f.frames[1].observation.resultRef)
  assert.equal(f.frames[2].observation.freshness.reason, 'attachment-or-result-unavailable')
  assert.notEqual(f.frames[1].observation.resultRef, f.frames[2].observation.resultRef)
  assert.equal(f.requests[0].images.length, 1)
  assert.equal(f.requests[1].images.length, 1)
  assert.deepEqual(f.requests[0].images, f.requests[1].images)
})

test('refresh control validates its observation-only boolean contract', () => {
  for (const options of [
    { sourceRef: 'saved', refresh: 'yes' },
    { sourceRef: 'saved', refresh: 1 },
  ]) {
    const decoder = new ScriptTurnDecoder('@@s12345678')
    decoder.push(`@@s12345678 observe(${JSON.stringify(options)})\n@@s12345678\n`)
    assert.throws(() => decoder.finish(), { code: 'SCRIPT_PROTOCOL' })
  }
  const decoder = new ScriptTurnDecoder('@@s12345678')
  decoder.push('@@s12345678 execute({sourceRef:"saved",refresh:true})\n@@s12345678\n')
  assert.throws(() => decoder.finish(), { code: 'SCRIPT_PROTOCOL' })
})
