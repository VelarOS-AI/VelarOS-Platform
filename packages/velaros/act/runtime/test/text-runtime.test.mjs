import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'

import { modelText } from './support/model-turn.mjs'
import { historyEntries, runtimeFrame } from './support/model-turn.mjs'
import { done, marker } from './support/model-turn.mjs'

const block = (request, head, source = '') =>
  `${marker(request)} ${head}\n${source}${source ? '\n' : ''}${marker(request)}\n`
const finish = { type: 'finish', reason: 'stop' }
test('INV-86 a whitespace-stalled response performs no write and starts no repair request', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield {
      type: 'text',
      text: block(request, 'execute', "import {write} from 'test:ops';await write('unsafe');"),
    }
    yield { type: 'text', text: ' '.repeat(4096) }
    yield { type: 'text', text: '\n' }
    yield { type: 'usage', inputTokens: 1000, outputTokens: 1100 }
    yield finish
  })
  const events = await collect(f)
  assert.equal(f.calls, 1)
  assert.deepEqual(f.writes, [])
  assert(events.some((event) => event.type === 'error' && /持续输出空白/u.test(event.message)))
  const trace = await f.runtime.trace('s', { fullContent: true })
  assert.equal(trace.turns.length, 1)
  assert.equal(trace.turns[0].executions.length, 0)
  const decision = JSON.parse(trace.turns[0].decision.body)
  assert.equal(decision.status, 'rejected')
  assert(!decision.usage)
  assert(trace.turns[0].response.body.endsWith(`${' '.repeat(4096)}\n`))
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check) {
  const deadline = Date.now() + 4000
  while (!(await check())) {
    assert(Date.now() < deadline, 'test condition timed out')
    await wait(5)
  }
}
async function fixture(t, stream, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'scriptact-text-'))
  const storage = localContextStorage({ path: join(root, 'state.sqlite') })
  const f = {
    root,
    frames: [],
    calls: 0,
    writes: [],
    started: [],
    reads: 0,
    release: () => {},
    activeWrites: 0,
    maxWrites: 0,
  }
  const barrier = new Promise((resolve) => {
    f.release = resolve
  })
  const model = {
    id: 'text-test',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(request) {
      f.frames.push(runtimeFrame(request))
      f.calls++
      yield* stream(request, f)
    },
  }
  const module = {
    binding: { moduleId: 'test:ops', instanceId: 'ops', generation: 1, schemaRevision: '1' },
    summary: 'controlled test host',
    operations: {
      read: {
        summary: 'read',
        effects: 'none',
        input: { type: 'null' },
        output: { type: 'integer' },
        run: () => ++f.reads,
      },
      wait: {
        summary: 'barrier',
        effects: 'none',
        input: { type: 'integer' },
        output: { type: 'integer' },
        run: async (value) => {
          f.started.push(value)
          await barrier
          return value
        },
      },
      write: {
        summary: 'write',
        effects: 'write',
        input: { type: 'string' },
        output: { type: 'null' },
        run: async (value) => {
          f.activeWrites++
          f.maxWrites = Math.max(f.maxWrites, f.activeWrites)
          await wait(15)
          f.writes.push(value)
          await writeFile(join(root, 'result.txt'), value)
          f.activeWrites--
          return null
        },
      },
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [module],
    ...extra,
  })
  const session = await runtime.openSession('s')
  Object.assign(f, {
    runtime,
    session,
    storage,
    model,
    programs: new ProgramContext('s', session.context, storage),
  })
  t.after(async () => {
    f.release()
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}
async function collect(f, input = 'Continue', signal) {
  const events = []
  for await (const event of f.session.submit(input, signal)) events.push(event)
  return events
}
const assertDone = (events) =>
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
const write = "import {write} from 'test:ops';await write('one');"

test('INV-13 two identical execute blocks both run once, in order, with separate identities', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(request, 'execute', write) + block(request, 'execute()', write),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.deepEqual(f.writes, ['one', 'one'])
  assert.equal(f.maxWrites, 1)
  const jobs = f.frames[1].jobs
  assert.equal(jobs.length, 2)
  assert.notEqual(jobs[0].executionId, jobs[1].executionId)
  assert.equal(f.frames[1].results.length, 2)
})

test('INV-14 opaque blobs and host input arrive unchanged and frozen inside the real JS runner', async (t) => {
  const payload = 'const value = `Hello, ${name}`;\n```html\n<div title="quoted">世界</div>\n```\n'
  const inputs = { target: { path: 'result.txt' } }
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        inputs.target.path = 'changed-after-frame'
        yield {
          type: 'text',
          text: `Before\n${block(request, 'blobs("payload")', payload)}${block(request, 'execute({inputRef:"host:target"})', `import {input,blobs} from 'velaros:program';import {write} from 'test:ops';import {output} from 'velaros';output({frozen:Object.isFrozen(input),path:input.path});await write(blobs.payload);`)}After\n`,
        }
        yield finish
      } else {
        assert(modelText(request).includes('import {input,blobs}'))
        yield* done(request)
      }
    },
    { inputs: () => inputs }
  )
  const events = await collect(f)
  assertDone(events)
  assert.equal(await readFile(join(f.root, 'result.txt'), 'utf8'), payload)
  assert.equal(
    events
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join(''),
    'Before\n'
  )
  const stored = await f.storage.load('s')
  const response = stored.records.find((record) => record.title === 'model-response')
  const decision = JSON.parse(await f.storage.get('s', response.objectId))
  assert.equal(decision.decoded.message, 'Before\n')
  assert.match((await f.session.context.read(decision.rawRef)).text, /After\n$/)
  assert.match(f.frames[1].results[0].text, /"frozen":true/)
  assert.match(f.frames[1].results[0].text, /result.txt/)
})

test('whole-response preflight rejects later invalid code without executing an earlier valid block', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(request, 'execute', write) + block(request, 'execute', 'const = ;'),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.deepEqual(f.writes, [])
  assert.match(f.frames[1].results[0].text, /SCRIPT_CHECK/)
})

test('background reads overlap, plain Markdown waits for events, and completion waits for real results', async (t) => {
  let afterWait = false
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: [1, 2]
          .map((n) =>
            block(
              request,
              'execute({async:true})',
              `import {wait} from 'test:ops';import {output} from 'velaros';output(await wait(${n}));`
            )
          )
          .join(''),
      }
      yield finish
    } else if (f.calls === 2) {
      await until(() => f.started.length === 2)
      setTimeout(() => {
        afterWait = true
        f.release()
      }, 40)
      yield { type: 'text', text: 'Waiting for the results.' }
      yield finish
    } else {
      assert(afterWait)
      yield* done(request)
    }
  })
  const events = await collect(f)
  assertDone(events)
  assert(events.some((event) => event.type === 'state' && event.status === 'waiting'))
  assert(f.calls <= 5)
  assert.equal(f.frames.at(-1).results.length, 2)
})

test('a retain=1 background result arriving during model generation survives that frame acknowledgement', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute({async:true,retain:1})',
          "import {wait} from 'test:ops';import {output} from 'velaros';output(await wait(7));"
        ),
      }
      yield finish
    } else if (f.calls === 2) {
      assert.equal(f.frames.at(-1).results.length, 0)
      await until(() => f.started.length === 1)
      f.release()
      await until(async () => (await f.programs.state()).leases.length === 1)
      yield* done(request)
    } else {
      assert.equal(f.frames.at(-1).results.length, 1)
      assert.equal(f.frames.at(-1).results[0].remainingTurns, 1)
      yield* done(request)
    }
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.equal((await f.programs.state()).leases.length, 0)
})

test('protocol repair reuses the frame and does not rerun stable observation', async (t) => {
  const tags = []
  const f = await fixture(t, async function* (request, f) {
    tags.push(marker(request))
    if (f.calls === 1) {
      yield { type: 'text', text: `${marker(request)} invalid()` }
      yield finish
    } else yield* done(request)
  })
  await f.session.observe({
    source: "import {read} from 'test:ops';import {output} from 'velaros';output(await read());",
  })
  assertDone(await collect(f))
  assert.equal(f.reads, 1)
  assert.equal(tags[0], tags[1])
  assert.equal(f.frames[0].programFrame.id, f.frames[1].programFrame.id)
})

test('INV-84 short random markers reject a prior frame before dispatch and preserve same-frame repair', async (t) => {
  const tags = []
  const f = await fixture(t, async function* (request, f) {
    const tag = marker(request)
    tags.push(tag)
    assert.match(tag, /^@@s[0-9a-f]{8}$/u)
    if (f.calls === 1) {
      yield { type: 'text', text: block(request, 'execute()', write) }
      yield finish
    } else if (f.calls === 2) {
      assert.notEqual(tag, tags[0])
      yield {
        type: 'text',
        text: `${tags[0]} execute()\nimport {write} from 'test:ops';await write('stale');\n${tags[0]}\n`,
      }
      yield finish
    } else {
      assert.deepEqual(f.writes, ['one'])
      if (f.calls === 3) assert.equal(tag, tags[1])
      yield* done(request)
    }
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.deepEqual(f.writes, ['one'])
  const trace = await f.runtime.trace('s', { fullContent: true })
  assert.equal(trace.turns[1].requestSummary.system, trace.turns[0].requestSummary.system)
  assert.equal(trace.turns[1].repair, 0)
  assert.equal(trace.turns[2].repair, 1)
})

test('INV-84 short marker collisions extend after a persistent session is reopened', async (t) => {
  const tags = []
  const f = await fixture(t, async function* (request) {
    tags.push(marker(request))
    yield* done(request)
  })
  t.mock.method(crypto, 'getRandomValues', (values) => {
    assert(values instanceof Uint32Array)
    assert.equal(values.length, 4)
    values.set([0x12345678, 0, 0, 0])
    return values
  })
  assertDone(await collect(f))
  assert.equal(tags[0], '@@s12345678')
  await f.session.close()
  const next = await f.runtime.openSession('s')
  assert.notEqual(next, f.session)
  f.session = next
  assertDone(await collect(f))
  assert.equal(tags[1], '@@s123456780')
  assertDone(await collect(f))
  assert.equal(tags[2], '@@s1234567800')
  const state = await f.storage.load('s')
  assert.deepEqual(
    state.records
      .filter((record) => record.title.startsWith('runtime:frame-marker:'))
      .map((record) => record.title.slice('runtime:frame-marker:'.length)),
    tags
  )
})

test('explicit observation clear removes the next-frame rerun', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield { type: 'text', text: block(request, 'observe({clear:true})') }
      yield finish
    } else yield* done(request)
  })
  await f.session.observe({ source: "import {read} from 'test:ops';await read();" })
  assertDone(await collect(f))
  assert.equal(f.reads, 1)
  assert.equal(f.frames[1].observation.sourceRef, null)
})

test('closing marker repair names the same frame and executes the corrected batch only once', async (t) => {
  let originalMarker
  const second = "import {write} from 'test:ops';await write('two');"
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      originalMarker = marker(request)
      yield {
        type: 'text',
        text: `${block(request, 'execute()', write)}${originalMarker} execute()\n${second}\n${originalMarker}x\n`,
      }
      yield finish
    } else if (f.calls === 2) {
      assert.equal(marker(request), originalMarker)
      assert.deepEqual(f.writes, [])
      const repair = modelText(request).split('本帧上次响应未通过校验').at(-1)
      assert(repair.includes(`闭合行必须逐字为：\n${originalMarker}\n`))
      assert.match(repair, /重新输出完整响应/)
      yield {
        type: 'text',
        text: block(request, 'execute()', write) + block(request, 'execute()', second),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.deepEqual(f.writes, ['one', 'two'])
})

test('work narration without a decision exhausts bounded repair without claiming completion', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'text', text: 'Please choose a destination.' }
    yield finish
  })
  const events = await collect(f)
  assert.equal(events.at(-1).status, 'failed')
  assert.equal(f.calls, 3)
  assert.notEqual((await f.session.view.inspect()).status, 'completed')
  assert.deepEqual(f.writes, [])
})

test('user-only image input remains multimodal across calls and is recorded as user evidence', async (t) => {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  const f = await fixture(t, async function* (request) {
    assert.equal(request.images[0].data, data)
    assert.equal(request.images[0].origin, 'user')
    assert(!modelText(request).includes(data))
    yield* done(request)
  })
  assertDone(
    await collect(f, {
      images: [{ type: 'image-data', mediaType: 'image/png', data, label: 'pixel' }],
    })
  )
  assertDone(await collect(f, 'Describe that image again'))
})

test('concurrent writes are serialized at the shared capability boundary', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text:
          block(request, 'execute({async:true})', write) +
          block(request, 'execute({async:true})', write),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.equal(f.writes.length, 2)
  assert.equal(f.maxWrites, 1)
})

test('cancellation after effect admission still prevents the handler from running', async (t) => {
  const controller = new AbortController()
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield { type: 'text', text: block(request, 'execute', write) }
        yield finish
      } else yield* done(request)
    },
    {
      onMetric: (metric) => {
        if (metric.phase === 'effect-wait' && metric.operation === 'test:ops.write')
          controller.abort()
      },
    }
  )
  const events = await collect(f, 'cancel at admission', controller.signal)
  assert.equal(events.at(-1).status, 'cancelled')
  assert.deepEqual(f.writes, [])
})

test('host-declared disjoint effects overlap through the real runner and emit wait/run timings', async (t) => {
  const metrics = []
  let active = 0
  let maxActive = 0
  let release
  const both = new Promise((resolve) => {
    release = resolve
  })
  const module = {
    binding: {
      moduleId: 'test:scoped',
      instanceId: 'resources',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'independent resources',
    operations: {
      write: {
        summary: 'write independent key',
        effects: 'write',
        input: { type: 'string' },
        output: { type: 'null' },
        run: async () => {
          active++
          maxActive = Math.max(active, maxActive)
          if (active === 2) release()
          await both
          active--
          return null
        },
      },
    },
  }
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1)
        yield {
          type: 'text',
          text:
            block(
              request,
              'execute({async:true})',
              "import {write} from 'test:scoped';await write('a');"
            ) +
            block(
              request,
              'execute({async:true})',
              "import {write} from 'test:scoped';await write('b');"
            ),
        }
      else yield { type: 'text', text: `${marker(request)} done` }
      yield finish
    },
    {
      modules: [module],
      effectResources: (invocation) =>
        invocation.binding.moduleId === 'test:scoped' ? [String(invocation.input)] : undefined,
      onMetric: (metric) => metrics.push(metric),
    }
  )
  const timeout = setTimeout(() => release(), 5000)
  t.after(() => clearTimeout(timeout))
  assertDone(await collect(f))
  assert.equal(maxActive, 2)
  assert.equal(
    metrics.filter(
      (metric) => metric.phase === 'effect-run' && metric.operation === 'test:scoped.write'
    ).length,
    2
  )
  assert(metrics.some((metric) => metric.phase === 'effect-wait' && metric.succeeded))
})

test('a short ownership lease is renewed while a background task runs', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield {
          type: 'text',
          text: block(
            request,
            'execute({async:true})',
            "import {wait} from 'test:ops';await wait(1);"
          ),
        }
        yield finish
      } else if (f.calls === 2) {
        await until(() => f.started.length === 1)
        await wait(4500)
        f.release()
        yield* done(request)
      } else yield* done(request)
    },
    { context: { sources: [], limits: { leaseMs: 2000 } } }
  )
  assertDone(await collect(f))
  assert.equal((await f.session.view.inspect()).lease, null)
})

test('renewal during an in-flight frame preserves the newly granted exposure', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      const ref = f.frames[0].results[0].ref
      await f.programs.retain(ref, 1)
      yield* done(request)
    } else yield* done(request)
  })
  await f.session.context.append({ kind: 'user', body: 'Keep this result' })
  await f.session.execute({ source: "import {output} from 'velaros';output('keep');" }, 1)
  assertDone(await collect(f))
  assert.equal((await f.programs.state()).leases.length, 1)
  assertDone(await collect(f))
  assert.equal(f.frames[1].results[0].remainingTurns, 1)
  assert.equal((await f.programs.state()).leases.length, 0)
})

test('cancelling an async job stops later dispatch and releases the task lease', async (t) => {
  const controller = new AbortController()
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute({async:true})',
          "import {wait,write} from 'test:ops';await wait(1);await write('late');"
        ),
      }
      yield finish
    } else {
      await until(() => f.started.length === 1)
      controller.abort()
      setTimeout(f.release, 20)
      yield* done(request)
    }
  })
  const events = await collect(f, 'cancel', controller.signal)
  assert.equal(events.at(-1).status, 'cancelled')
  await wait(80)
  assert.equal(f.writes.length, 0)
  assert.equal((await f.session.view.inspect()).lease, null)
  assert(!(await f.programs.state()).jobs.some((job) => ['queued', 'running'].includes(job.status)))
})

test('a synchronous runtime failure cancels the unstarted remainder of its batch', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text:
          block(request, 'execute', 'throw new Error("stop batch");') +
          block(request, 'execute', write),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.equal(f.writes.length, 0)
  assert(f.frames[1].jobs.some((job) => job.status === 'cancelled'))
})

test('the next run recovers persisted queued and completed jobs without replaying source', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  const goal = await f.session.context.append({ kind: 'user', body: 'Recover saved jobs' })
  const completed = await f.session.execute({ source: write })
  await f.programs.job({
    executionId: completed.executionId,
    sourceRef: completed.sourceRef,
    batchId: 'interrupted',
    status: 'running',
  })
  const queued = crypto.randomUUID()
  await f.programs.job({
    executionId: queued,
    sourceRef: completed.sourceRef,
    batchId: 'interrupted',
    status: 'queued',
  })
  await f.session.view.begin(goal.ref)
  await f.session.view.startStep(completed.executionId, undefined, true)
  await f.session.view.end()
  assertDone(await collect(f))
  assert.equal(f.writes.length, 1)
  const state = await f.programs.state()
  assert.equal(
    state.jobs.find((job) => job.executionId === completed.executionId).status,
    'succeeded'
  )
  assert.equal(state.jobs.find((job) => job.executionId === queued).status, 'cancelled')
  assert.deepEqual((await f.session.view.inspect()).activeExecutions, {})
})

test('raw blob names and nested input keys keep JSON semantics in the isolated runner', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text:
          block(request, 'blobs("__proto__")', 'literal data') +
          block(
            request,
            'execute({input:{"__proto__":{safe:1}}})',
            "import {input,blobs} from 'velaros:program';import {output} from 'velaros';output({blob:blobs['__proto__'],owned:Object.hasOwn(input,'__proto__'),frozen:Object.isFrozen(input['__proto__']),polluted:({}).safe===1});"
          ),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  const text = f.frames[1].results[0].text
  assert.match(text, /"blob":"literal data"/)
  assert.match(text, /"owned":true/)
  assert.match(text, /"frozen":true/)
  assert.match(text, /"polluted":false/)
})

test('missing work decision is repaired before a single actual write and completion', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      assert(modelText(request).includes(`\n${marker(request)} execute()\n`))
      yield { type: 'text', text: 'I will continue the task.' }
      yield finish
    } else if (f.calls === 2) {
      assert.equal(f.writes.length, 0)
      const repair = modelText(request).split('本帧上次响应未通过校验').at(-1)
      assert(repair.includes(`第一行直接输出：\n${marker(request)} execute()`))
      assert(repair.includes(`独立一行写闭合标记：\n${marker(request)}`))
      yield {
        type: 'text',
        text: block(request, 'execute', "import {write} from 'test:ops';await write('recovered');"),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.deepEqual(f.writes, ['recovered'])
  const state = await f.storage.load('s')
  const decisions = await Promise.all(
    state.records
      .filter((record) => record.title === 'model-response')
      .map((record) => f.storage.get('s', record.objectId).then(JSON.parse))
  )
  assert.equal(decisions[0].status, 'rejected')
  assert.equal(decisions[1].status, 'accepted')
})

test('INV-60 stable protocol rules survive changing frames and retries with scoped names and input snapshots', async (t) => {
  const inputs = { target: { value: 'original' } }
  let system
  let firstMarker
  const f = await fixture(
    t,
    async function* (request, f) {
      system ??= request.instructions
      assert.equal(request.instructions, system)
      assert.match(system, /sourceRef 复用已保存程序/)
      assert.match(system, /每个实际程序只提交一次/)
      assert.doesNotMatch(system, /@@s[0-9a-z]+|host:target|host:changed/)
      assert.doesNotMatch(request.compiledPrompt, /sourceRef 复用已保存程序/)
      const protocol = request.compiledPrompt.split('本帧协议').at(-1)
      const tag = marker(request)
      assert(protocol.includes(`${tag} run()`))
      assert(protocol.includes(`${tag} finish`))
      assert.doesNotMatch(protocol, /@@s[0-9a-z]+ (?:execute|observe|done)/)
      if (f.calls === 1) {
        firstMarker = tag
        assert.match(protocol, /宿主参数：host:target/)
        delete inputs.target
        inputs.changed = { value: 'new' }
        yield { type: 'text', text: `${tag} run()\n${write}\n` }
      } else if (f.calls === 2) {
        assert.equal(tag, firstMarker)
        assert.deepEqual(f.writes, [])
        assert.match(protocol, /宿主参数：host:target/)
        assert(protocol.includes(`闭合行必须逐字为：\n${tag}`))
        yield {
          type: 'text',
          text: block(
            request,
            'run({inputRef:"host:target"})',
            "import {input} from 'velaros:program';import {write} from 'test:ops';await write(input.value);"
          ),
        }
      } else {
        assert.notEqual(tag, firstMarker)
        assert.match(protocol, /宿主参数：host:changed/)
        assert.doesNotMatch(protocol, /host:target/)
        yield { type: 'text', text: `${tag} finish` }
      }
      yield finish
    },
    {
      protocol: {
        allowed: ['blobs', 'execute', 'done'],
        names: { execute: 'run', done: 'finish' },
      },
      inputs: () => inputs,
    }
  )
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.deepEqual(f.writes, ['original'])
})

test('INV-63 missing closure between blob and program rejects the whole response and repairs once', async (t) => {
  let firstMarker
  const f = await fixture(t, async function* (request, f) {
    const tag = marker(request)
    if (f.calls === 1) {
      firstMarker = tag
      assert(request.instructions.includes('闭合段绑定原文'))
      yield {
        type: 'text',
        text: `${block(request, 'execute()', write)}${tag} blobs("payload")\nrecovered\n${tag} execute()\n`,
      }
      yield finish
    } else if (f.calls === 2) {
      assert.equal(tag, firstMarker)
      assert.deepEqual(
        f.writes,
        [],
        'earlier valid block cannot execute before the whole response passes'
      )
      assert(request.compiledPrompt.includes(`闭合行必须逐字为：\n${tag}\n`))
      assert.match(request.compiledPrompt, /下一控制头不能代替闭合行/)
      yield {
        type: 'text',
        text:
          block(request, 'blobs("payload")', 'recovered') +
          block(
            request,
            'execute()',
            "import {blobs} from 'velaros:program';import {write} from 'test:ops';await write(blobs.payload);"
          ),
      }
      yield finish
    } else yield* done(request)
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 3)
  assert.deepEqual(f.writes, ['recovered'])
})

test('INV-66 trailing closure spaces execute complete blob and program once without a repair call', async (t) => {
  const payload = 'preserved  \n  '
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      const tag = marker(request)
      const response = `${tag} blobs("payload")\n${payload}\n${tag}  \r\n${tag} execute()\nimport {blobs} from 'velaros:program';import {write} from 'test:ops';await write(blobs.payload);\n${tag} `
      for (const char of response) yield { type: 'text', text: char }
      yield finish
    } else {
      assert.deepEqual(f.writes, [payload])
      yield* done(request)
    }
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 2)
  assert.deepEqual(f.writes, [payload])
})

test('default text executions preserve earlier evidence across investigation and honor explicit release', async (t) => {
  let firstRef
  let firstBody
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 2) {
      const first = historyEntries(request).find((item) => item.origin === 'runtime-execution')
      firstRef = first.ref.id
      firstBody = first.text
    }
    if (f.calls <= 4) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute',
          "import {output} from 'velaros';import {read} from 'test:ops';output({snapshot:await read()});"
        ),
      }
      yield finish
    } else if (f.calls === 5) {
      const first = historyEntries(request).find((item) => item.ref.id === firstRef)
      assert.equal(first.bodyIncluded, true)
      assert.equal(first.text, firstBody)
      assert.equal(f.reads, 4)
      yield {
        type: 'text',
        text: block(
          request,
          'execute',
          `import {memory} from 'velaros:system';await memory.release({ref:${JSON.stringify(firstRef)}});`
        ),
      }
      yield finish
    } else {
      assert.equal(
        historyEntries(request).find((item) => item.ref.id === firstRef).bodyIncluded,
        false
      )
      yield* done(request)
    }
  })
  assertDone(await collect(f))
  assert.equal(f.reads, 4)
  assert.match(
    (await f.session.context.read({ sessionId: 's', id: firstRef })).text,
    /"snapshot":1/
  )
})

test('an explicit eight-exposure result retires without replaying its producer', async (t) => {
  let firstRef
  const f = await fixture(t, async function* (request, f) {
    const results = historyEntries(request).filter((item) => item.origin === 'runtime-execution')
    if (f.calls === 2) firstRef = results[0].ref.id
    if (f.calls > 1) {
      // 八次曝光后租约结束、帧尾不再列出，已冻结的历史正文逐字保留，请求只往后加
      const first = results.find((item) => item.ref.id === firstRef)
      assert.equal(first.bodyIncluded, true)
      assert.equal(
        runtimeFrame(request).results.some((item) => item.ref === firstRef),
        f.calls <= 9
      )
    }
    if (f.calls === 10) {
      yield* done(request)
      return
    }
    yield {
      type: 'text',
      text: block(
        request,
        'execute({retain:8})',
        f.calls === 1
          ? "import {output} from 'velaros';import {read} from 'test:ops';output({snapshot:await read()});"
          : `import {output} from 'velaros';output({step:${f.calls}});`
      ),
    }
    yield finish
  })
  assertDone(await collect(f))
  assert.equal(f.reads, 1)
  assert.equal(
    (await f.programs.state()).leases.some((lease) => lease.ref === firstRef),
    false
  )
})

test('default results preserve the durable history while cumulative runtime frames stay within actual capacity', async (t) => {
  let prior = []
  let firstRef
  let discardedFrames = false
  let previousFrames = 0
  const f = await fixture(t, async function* (request, f) {
    const stateFrames = request.history.filter((message) =>
      /^(?:Runtime 本帧工作内存|当前运行状态)/u.test(message.content)
    )
    if (stateFrames.length < previousFrames) discardedFrames = true
    previousFrames = stateFrames.length
    const history = request.history
      .filter((message) => !/^(?:Runtime 本帧工作内存|当前运行状态)/u.test(message.content))
      .map(({ role, content }) => ({ role, content }))
    assert.deepEqual(history.slice(0, prior.length), prior)
    prior = history
    if (f.calls === 2)
      firstRef = historyEntries(request).find((item) => item.origin === 'runtime-execution').ref.id
    if (f.calls > 1) {
      assert.equal(
        historyEntries(request).find((item) => item.ref.id === firstRef).bodyIncluded,
        true
      )
      assert(f.frames.at(-1).results.every((item) => item.remainingTurns === 'segment'))
    }
    if (f.calls === 72) yield* done(request)
    else {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {output} from 'velaros';output({step:${f.calls}});`
        ),
      }
      yield finish
    }
  })
  // 用随真实出线增长的计量验证容量边界；固定 1000 token 的替身无法触发实际容量回收。
  f.model.limits = { contextTokens: 100000, inputTokens: 80000, outputTokens: 4000 }
  f.model.estimate = async (request) => ({
    tokens: Math.ceil(
      JSON.stringify({
        instructions: request.instructions,
        history: request.history,
        prompt: request.compiledPrompt,
      }).length / 4
    ),
    precision: 'exact',
    basis: 'deterministic serialized request size',
  })
  assertDone(await collect(f))
  assert.equal(f.calls, 72)
  assert(discardedFrames, 'capacity pressure must rebuild the current authoritative history')
  assert.equal((await f.programs.state()).leases.length, 0)
  assert.match((await f.programs.read(firstRef)).text, /"step":1/)
})
