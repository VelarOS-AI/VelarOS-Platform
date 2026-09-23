import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

import { done } from './support/model-turn.mjs'

const signal = new AbortController().signal
async function fixture(t, options = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    ...options,
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  const input = await session.context.append({
    kind: 'user',
    body: 'Investigate the failure. Do not send any external messages.',
  })
  await session.view.begin(input.ref)
  const state = new ContextMaintenanceState('root', storage)
  const programs = new ProgramContext('root', session.context, storage)
  const memory = new ContextMemory(
    'root',
    session.context,
    storage,
    session.view,
    programs,
    new RecentContext('root', session.context, storage)
  )
  return {
    storage,
    runtime,
    session,
    state,
    input,
    programs,
    memory,
    note: async () =>
      memory.update(
        { key: 'progress', baseRevision: 0, body: 'Original primary note', sources: [input.ref] },
        signal
      ),
  }
}
const patch = (snapshot, extra = {}) => ({
  baseRevision: snapshot.baseRevision,
  summary: 'Kept the task and unresolved investigation.',
  unresolved: ['Find the cause'],
  ...extra,
})

test('cancelling a stalled candidate validator returns promptly and a late result cannot publish', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers()
  const late = Promise.withResolvers()
  const state = new ContextMaintenanceState('root', f.storage, {
    validateCandidate: () => {
      entered.resolve()
      return late.promise
    },
  })
  const note = await f.note()
  const snapshot = await state.snapshot(8000, signal)
  const controller = new AbortController()
  const pending = state.apply(
    snapshot,
    patch(snapshot, { notes: [{ ref: note.ref, summary: 'unpublished' }] }),
    controller.signal
  )
  await entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  late.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert(
    !(await f.storage.load('root')).records.some(
      (record) => record.title === 'context:projection-policy'
    )
  )
  assert.equal((await state.snapshot(8000, signal)).baseRevision, snapshot.baseRevision)
})

test('derived note presentations persist for the task through a rebuilt base and a new task starts clean', async (t) => {
  const f = await fixture(t)
  const note = await f.memory.update(
    { key: 'capacity', baseRevision: 0, body: 'x'.repeat(2400) },
    signal
  )
  const memory = new ContextMemory(
    'root',
    f.session.context,
    f.storage,
    f.session.view,
    f.programs,
    new RecentContext('root', f.session.context, f.storage)
  )
  const view = await f.session.view.preview({ maxChars: 16000 }, signal)
  const before = await memory.project(view, undefined, [], signal, 16000)
  assert.match(before.history[0].content, /x{2400}/)
  const snapshot = await f.state.snapshot(8000, signal)
  await f.state.apply(
    snapshot,
    patch(snapshot, { notes: [{ ref: note.ref, summary: 'Temporary summary' }] }),
    signal
  )
  const first = await memory.project(view, undefined, [], signal, 16000)
  const frame = JSON.parse(first.body)
  assert.equal(frame.memoryStatus.maintenance.active, true)
  // 策略换了就重建底座：同一段、底座版本加一，笔记快照换成派生展示
  assert.equal(first.segment.index, before.segment.index)
  assert.equal(first.segment.revision, before.segment.revision + 1)
  assert.match(first.history[0].content, /Temporary summary/)
  assert.doesNotMatch(first.history[0].content, /x{2400}/)
  await f.programs.consume(frame.frameId, signal)
  const later = await memory.project(view, undefined, [], signal, 16000)
  assert.equal(JSON.parse(later.body).memoryStatus.maintenance.active, true)
  assert.equal(later.history[0].content, first.history[0].content)
  const input = await f.session.context.append({ kind: 'user', body: 'Independent task' })
  await f.session.view.end('completed')
  await f.session.view.begin(input.ref, signal, 'new')
  await f.memory.update({ key: 'capacity', baseRevision: 0, body: 'y'.repeat(2400) }, signal)
  const fresh = await memory.project(
    await f.session.view.preview({ maxChars: 16000 }, signal),
    undefined,
    [],
    signal,
    16000
  )
  assert.equal(fresh.segment.index, 1)
  assert.match(fresh.history[0].content, /y{2400}/)
  assert.equal(JSON.parse(fresh.body).memoryStatus.maintenance, undefined)
})

test('context patches publish all validated changes together and preserve original inputs', async (t) => {
  const f = await fixture(t)
  const note = await f.note()
  const snapshot = await f.state.snapshot(8000, signal)
  f.state.acknowledge(snapshot, f.state.material(snapshot, 8000))
  const result = await f.state.apply(
    snapshot,
    patch(snapshot, {
      notes: [{ ref: note.ref, summary: 'Investigating the failure' }],
      inputs: [
        {
          ref: f.input.ref,
          baseRevision: 0,
          summary: 'Investigate the failure',
          constraints: ['Do not send external messages'],
          unresolved: ['Find the cause'],
        },
      ],
    }),
    signal
  )
  const state = await f.storage.load('root')
  assert(state.records.some((record) => record.ref.id === result.id))
  assert.equal(
    state.records.filter((record) => record.title === 'workspace:note:progress').length,
    1
  )
  assert.equal(
    JSON.parse((await f.memory.read(note.ref, 0, 60000, signal)).text).body,
    'Original primary note'
  )
  assert.equal(state.inputSummaries[0].revision, 1)
  assert.equal(
    (await f.session.context.readInput(f.input.ref)).text,
    'Investigate the failure. Do not send any external messages.'
  )
  assert.match(
    (await f.session.context.projectInput(f.input.ref, 8000)).text,
    /Do not send external messages/
  )
  await assert.rejects(f.state.apply(snapshot, patch(snapshot), signal), {
    code: 'CONTEXT_CONFLICT',
  })
})

test('a late invalid operation rolls back the entire context patch', async (t) => {
  const f = await fixture(t)
  const note = await f.note()
  const snapshot = await f.state.snapshot(8000, signal)
  await assert.rejects(
    f.state.apply(
      snapshot,
      patch(snapshot, {
        notes: [
          { ref: note.ref, summary: 'must stay unpublished' },
          { ref: { sessionId: 'root', id: 'missing' }, summary: 'stale' },
        ],
      }),
      signal
    ),
    { code: 'WORKSPACE_CONFLICT' }
  )
  const state = await f.storage.load('root')
  assert.equal(
    state.records.filter((record) => record.title.startsWith('workspace:note:')).length,
    1
  )
  assert(!state.records.some((record) => record.title === 'context:projection-policy'))
  assert.equal((await f.state.snapshot(8000, signal)).baseRevision, snapshot.baseRevision)
})

test('new user input invalidates maintenance while accounting and heartbeats do not', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.state.snapshot(8000, signal)
  await f.session.view.reserveModel('context', 2000)
  await f.session.view.recordUsage(100, 30)
  await f.session.view.renew(signal)
  const receipt = await f.state.apply(snapshot, patch(snapshot), signal)
  assert(receipt.id)
  const current = await f.state.snapshot(8000, signal)
  await f.session.context.append({
    kind: 'user',
    body: 'New constraint: only inspect local files.',
  })
  await assert.rejects(f.state.apply(current, patch(current), signal), { code: 'CONTEXT_CONFLICT' })
  assert.equal((await f.session.view.inspect()).usage.inputTokens, 100)
})

test('maintenance reads are paged and tied to the fixed parent snapshot', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.state.snapshot(8000, signal)
  const page = await f.state.list(snapshot, 0, 1, signal)
  assert.equal(page.items.length, 1)
  assert.equal((await f.state.read(snapshot, f.input.ref, 0, 11, signal)).text, 'Investigate')
  await assert.rejects(
    f.state.read(snapshot, { sessionId: 'other', id: f.input.ref.id }, 0, 10, signal),
    { code: 'SCOPE_MISMATCH' }
  )
  await assert.rejects(f.state.list(snapshot, 0, 65, signal), /1–64/)
  await assert.rejects(f.state.read(snapshot, f.input.ref, 0, 10, AbortSignal.abort()), {
    name: 'AbortError',
  })
})

test('observation display policy applies to fresh results each turn and reports original references', async (t) => {
  const requests = []
  const model = {
    id: 'maintenance-fixture',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      requests.push(request)
      yield* done(request)
    },
  }
  const f = await fixture(t, { model })
  await f.session.view.end()
  const observe = await f.session.observe({
    source: "import {output} from 'velaros';output('x'.repeat(20000));",
  })
  for await (const event of f.session.submit('Observe')) {
    assert.equal(typeof event.type, 'string')
  }
  const snapshot = await f.state.snapshot(12000, signal)
  await f.state.apply(
    snapshot,
    patch(snapshot, {
      observation: { sourceRef: observe.sourceRef, config: { maxChars: 100 } },
    }),
    signal
  )
  for await (const event of f.session.submit('Continue')) {
    assert.equal(typeof event.type, 'string')
  }
  for await (const event of f.session.submit('Continue again')) {
    assert.equal(typeof event.type, 'string')
  }
  const first = JSON.parse(requests.at(-2).materials[0].text)
  const second = JSON.parse(requests.at(-1).materials[0].text)
  assert(first.partitions.observation.text.length <= 100)
  assert(second.partitions.observation.text.length <= 100)
  assert.notEqual(first.partitions.observation.resultRef, second.partitions.observation.resultRef)
  assert.notEqual(second.partitions.observation.sourceRef, observe.sourceRef)
  assert.match(second.partitions.observation.source, /configure/)
  assert.equal(
    second.partitions.observation.read.input.ref,
    second.partitions.observation.resultRef
  )
  assert(second.memoryStatus.maintenance.report.id)
  assert((await f.programs.read(second.partitions.observation.resultRef)).totalChars > 20000)
})

const driver = (
  stream,
  estimate = async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' })
) => ({
  id: 'maintenance-integration',
  limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 8192 },
  estimate,
  stream,
})
const finish = { type: 'finish', reason: 'stop' }
const execute = (request, source) => ({
  type: 'text',
  text: `${request.compiledPrompt.match(/当前帧标记：(\S+)。普通/)[1]} execute()\n${source}\n${request.compiledPrompt.match(/当前帧标记：(\S+)。普通/)[1]}`,
})
const snapshotOf = (request) =>
  JSON.parse(JSON.parse(request.materials[0].text).partitions.task.goals[0].text).snapshot
async function* deliverPatch(request, extra = {}) {
  const snapshot = snapshotOf(request)
  const part = execute(
    request,
    `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(patch(snapshot, extra))}));`
  )
  yield {
    ...part,
    text: `${part.text}\n${request.compiledPrompt.match(/当前帧标记：(\S+)。普通/)[1]} done`,
  }
  yield finish
}
async function setupTool(t, main, maintenance, extra = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    model: main,
    context: { sources: [], maintenance: { model: maintenance } },
    ...extra,
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('root')
  await session.context.append({ kind: 'user', body: 'work' })
  return { storage, runtime, session }
}
async function runTool(f, input = 'work') {
  const events = []
  for await (const event of f.session.submit(input)) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  return events
}

test('explicit context request runs a separate leaf at a safe boundary; scripts and observer are not replayed', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const main = driver(async function* (request) {
    mainCalls++
    assert.equal(request.mode, 'work')
    if (mainCalls === 1) {
      yield execute(
        request,
        "import {output} from 'velaros';import {memory as context} from 'velaros:system';output(await context.organize({focus:'next investigate'}));"
      )
      yield finish
    } else {
      assert.match(JSON.stringify(request), /model-interpretation/)
      yield* done(request)
    }
  })
  const maintenance = driver(async function* (request) {
    toolCalls++
    assert.match(request.compiledPrompt, /上下文整理工具/)
    yield { type: 'usage', inputTokens: 11, outputTokens: 7 }
    yield* deliverPatch(request)
  })
  const f = await setupTool(t, main, maintenance, { modelTools: { concurrency: 1 } })
  await f.session.observe({ source: "import {output} from 'velaros';output('fresh observation');" })
  await runTool(f)
  assert.equal(mainCalls, 2)
  assert.equal(toolCalls, 1)
  const saved = await f.storage.load('root')
  const results = await Promise.all(
    saved.records
      .filter((r) => /^script:.*:result$/.test(r.title))
      .map(async (r) => JSON.parse(await f.storage.get('root', r.objectId)))
  )
  assert.equal(results.filter((r) => r.mode === 'observe').length, 2)
  assert.equal(results.filter((r) => r.mode === 'execute').length, 1)
  assert.equal((await f.session.view.inspect()).usage.inputTokens, 11)
  assert(saved.records.some((r) => r.title === 'context-maintenance:applied'))
  const binding = saved.records.findLast((r) => r.title.startsWith('model-tool:node:'))
  assert.equal(JSON.parse(await f.storage.get('root', binding.objectId)).status, 'closed')
})

test('a frame about to overflow delegates to maintenance before the first business request and preserves native user images', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const main = driver(
    async function* (request) {
      mainCalls++
      assert.equal(request.mode, 'work')
      assert(
        request.images.length +
          request.history.flatMap((m) =>
            Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image') : []
          ).length >
          0
      )
      yield* done(request)
    },
    // 窗口 90000：89000 剩余不足两轮，又没有可封的历史，交给整理支线
    async (request) => ({
      tokens: JSON.stringify(request).includes('model-interpretation') ? 1000 : 89000,
      precision: 'exact',
      basis: 'fixture',
    })
  )
  const f = await setupTool(
    t,
    main,
    driver(async function* (request) {
      toolCalls++
      yield* deliverPatch(request)
    })
  )
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  await runTool(f, {
    text: 'inspect image',
    images: [{ type: 'image-data', mediaType: 'image/png', data: pixel, label: 'pixel' }],
  })
  assert.equal(mainCalls, 1)
  assert.equal(toolCalls, 1)
})

test('verified pressure capacity avoids repeated maintenance across successful business turns', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const main = driver(
    async function* (request) {
      mainCalls++
      if (mainCalls < 3) {
        yield execute(request, "import {output} from 'velaros';output('next business step');")
        yield finish
      } else yield* done(request)
    },
    // 笔记在段底座里：看整个请求有没有带这份大笔记的正文
    async (request) => ({
      tokens: JSON.stringify(request).includes('x'.repeat(2400)) ? 85000 : 1000,
      precision: 'exact',
      basis: 'visible capacity fixture',
    })
  )
  const f = await setupTool(
    t,
    main,
    driver(async function* (request) {
      toolCalls++
      yield* deliverPatch(request)
    })
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.update({key:'large',baseRevision:0,body:'x'.repeat(2400)});",
  })
  await runTool(f)
  assert.equal(mainCalls, 3)
  assert.equal(toolCalls, 1)
})

test('maintenance has only fixed-snapshot reads and cannot discover or import system management', async (t) => {
  let calls = 0
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    driver(async function* (request) {
      calls++
      assert(!request.instructions.includes('memory.organize'))
      assert(!request.instructions.includes('modules.describe'))
      assert.match(request.instructions, /declare module ["']velaros:context-materials/)
      if (calls === 1) {
        yield execute(request, "import {modules} from 'velaros:system';await modules.list({});")
        yield finish
      } else if (calls === 2) {
        assert.match(JSON.stringify(request), /SCRIPT_CHECK/)
        yield execute(
          request,
          "import {output} from 'velaros';import {list,read} from 'velaros:context-materials';const page=await list({limit:1});if(page.items.length)output((await read({ref:page.items[0].ref,limit:1000})).text);else output(page);"
        )
        yield finish
      } else yield* deliverPatch(request)
    })
  )
  const receipt = await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'next investigate'});",
  })
  assert(receipt.checked)
  await runTool(f)
  assert.equal(calls, 3)
  await assert.rejects(
    f.session.execute({ source: "import {list} from 'velaros:context-materials';await list({});" }),
    { code: 'SCRIPT_CHECK' }
  )
})

test('last maintenance call directly delivers a partial patch with gaps and no recursive maintenance', async (t) => {
  let calls = 0
  const maintenance = driver(async function* (request) {
    calls++
    if (calls === 1) {
      yield execute(
        request,
        "import {output} from 'velaros';import {list,read} from 'velaros:context-materials';const page=await list({limit:1});if(page.items.length)output((await read({ref:page.items[0].ref,limit:1000})).text);else output(page);"
      )
      yield finish
    } else {
      assert.match(request.compiledPrompt, /最后交付轮/)
      assert.equal(request.contextStatus.phase, 'finalizing')
      yield* deliverPatch(request, { unresolved: ['Need more evidence'] })
    }
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance,
    { context: { sources: [], maintenance: { model: maintenance, profile: { modelCalls: 2 } } } }
  )
  await f.session.execute({
    source:
      "import {memory as context} from 'velaros:system';await context.organize({focus:'next investigate'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  const record = state.records.findLast((r) => r.title === 'context-maintenance:applied')
  assert(record)
  assert.match(await f.storage.get('root', record.objectId), /Need more evidence/)
})

test('a changed parent snapshot ends maintenance before another model call and recompiles the main frame', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const maintenance = driver(async function* (request) {
    toolCalls++
    assert.equal(toolCalls, 1)
    await f.session.context.append({
      kind: 'note',
      title: 'concurrent-result',
      body: 'A child completed while maintenance was reading.',
    })
    yield execute(
      request,
      "import {list} from 'velaros:context-materials';import {output} from 'velaros';output(await list({limit:1}));"
    )
    yield finish
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      mainCalls++
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'keep current progress'});",
  })
  await runTool(f)
  assert.equal(toolCalls, 1)
  assert.equal(mainCalls, 1)
  const state = await f.storage.load('root')
  assert(state.records.some((record) => record.title === 'concurrent-result'))
  assert(!state.records.some((record) => record.title === 'context-maintenance:applied'))
  const outcome = state.records.findLast((record) => record.title === 'context-maintenance:outcome')
  assert.equal(JSON.parse(await f.storage.get('root', outcome.objectId)).status, 'failed')
})

test('unhelpful maintenance is bounded and oversize requests never reach the provider', async (t) => {
  let business = 0
  let maintenance = 0
  const main = driver(
    async function* (request) {
      business++
      yield* done(request)
    },
    async () => ({ tokens: 150000, precision: 'exact', basis: 'fixture' })
  )
  const f = await setupTool(
    t,
    main,
    driver(async function* (request) {
      maintenance++
      yield* deliverPatch(request)
    })
  )
  const events = []
  for await (const e of f.session.submit('oversize')) events.push(e)
  assert.equal(events.at(-1).status, 'context_blocked', JSON.stringify(events))
  assert.equal(business, 0)
  assert(maintenance <= 3)
})

test('new user input cancels the old maintenance patch and continues the same business task', async (t) => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let mainCalls = 0
  const maintenance = driver(async function* (request) {
    entered.resolve()
    await release.promise
    yield* deliverPatch(request, {
      notes: [{ key: 'stale', baseRevision: 0, body: 'must not publish' }],
    })
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      mainCalls++
      assert.match(JSON.stringify(request), /only inspect/)
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source:
      "import {memory as context} from 'velaros:system';await context.organize({focus:'next investigate'});",
  })
  const events = []
  const running = (async () => {
    for await (const event of f.session.submit('investigate')) events.push(event)
  })()
  await entered.promise
  await f.session.steer('New constraint: only inspect')
  release.resolve()
  await running
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(mainCalls, 1)
  const state = await f.storage.load('root')
  assert(!state.records.some((r) => r.title === 'workspace:note:stale'))
  assert(!state.records.some((r) => r.title === 'context-maintenance:applied'))
  assert(state.records.some((r) => r.kind === 'user'))
})

test('failed maintenance falls back to reference projection and is not retried on unchanged materials', async (t) => {
  let toolCalls = 0
  let mainCalls = 0
  const f = await setupTool(
    t,
    driver(
      async function* (request) {
        mainCalls++
        yield* done(request)
      },
      async () => ({ tokens: 89000, precision: 'exact', basis: 'fixture' })
    ),
    driver(async function* (request) {
      toolCalls++
      yield* done(request, 'could not produce a patch')
    })
  )
  await runTool(f)
  assert.equal(mainCalls, 1)
  assert.equal(toolCalls, 1)
  const state = await f.storage.load('root')
  const outcome = state.records.findLast((r) => r.title === 'context-maintenance:outcome')
  assert.equal(JSON.parse(await f.storage.get('root', outcome.objectId)).status, 'failed')
  assert(!state.records.some((r) => r.title === 'context-maintenance:applied'))
})

test('business child can request maintenance; the tool cost reaches both parent ledgers', async (t) => {
  let rootCalls = 0
  let childCalls = 0
  let toolCalls = 0
  const child = driver(async function* (request) {
    if (++childCalls === 1) {
      yield execute(
        request,
        "import {memory as context} from 'velaros:system';await context.organize({focus:'next investigate'});"
      )
      yield finish
    } else {
      assert.match(JSON.stringify(request), /model-interpretation/)
      yield* done(request)
    }
  })
  const maintenance = driver(async function* (request) {
    toolCalls++
    yield { type: 'usage', inputTokens: 23, outputTokens: 17 }
    yield* deliverPatch(request)
  })
  const main = driver(async function* (request) {
    if (++rootCalls === 1) {
      yield execute(
        request,
        "import {start,wait} from 'velaros:agents';await wait({id:(await start({task:'work',profile:'worker'})).id});"
      )
      yield finish
    } else yield* done(request)
  })
  const f = await setupTool(t, main, maintenance, {
    modelTools: { concurrency: 1 },
    agents: { concurrency: 1, maxChildren: 2, profiles: { worker: { model: child, modules: [] } } },
  })
  await runTool(f)
  assert.equal(rootCalls, 2)
  assert.equal(childCalls, 2)
  assert.equal(toolCalls, 1)
  const root = await f.session.view.inspect()
  assert.equal(root.usage.contextCalls, 3)
  assert.equal(root.usage.inputTokens, 23)
  const saved = await f.storage.load('root')
  const records = await Promise.all(
    saved.records
      .filter((r) => r.title.startsWith('model-tool:node:'))
      .map(async (r) => JSON.parse(await f.storage.get('root', r.objectId)))
  )
  const agent = records.find((r) => r.kind === 'agent')
  const childState = await f.storage.load(agent.sessionId)
  assert.equal(childState.task.usage.contextCalls, 1)
  assert.equal(childState.task.usage.inputTokens, 23)
  assert(childState.records.some((r) => r.title === 'context-maintenance:applied'))
  t.diagnostic(
    JSON.stringify({
      rootBusinessRequests: rootCalls,
      childBusinessRequests: childCalls,
      maintenanceRequests: toolCalls,
      rootBranchCalls: root.usage.contextCalls,
      rootInputTokens: root.usage.inputTokens,
      childBranchCalls: childState.task.usage.contextCalls,
      childInputTokens: childState.task.usage.inputTokens,
    })
  )
})

test('organize persists semantic intent and automatically reports its request identity on the next frame', async (t) => {
  let frame
  let seenIntent
  const f = await setupTool(
    t,
    driver(async function* (request) {
      frame = JSON.parse(request.materials[0].text)
      yield* done(request)
    }),
    driver(async function* (request) {
      seenIntent = snapshotOf(request).intent
      yield* deliverPatch(request, { unresolved: ['Verify login tests'] })
    })
  )
  const first = await f.session.execute({
    source:
      "import {memory} from 'velaros:system';import {output} from 'velaros';output(await memory.organize({focus:'Fix login; keep constraints'}));",
  })
  assert.equal(first.result.value.default.status, 'scheduled')
  const id = first.result.value.default.requestId
  assert(id)
  assert(
    (await f.storage.load('root')).records.some((r) => r.title === 'context-maintenance:request')
  )
  await runTool(f)
  assert.equal(seenIntent.focus, 'Fix login; keep constraints')
  assert.equal(frame.memoryStatus.maintenance.lastAttempt.requestId, id)
  assert.equal(frame.memoryStatus.maintenance.lastAttempt.status, 'applied')
  assert.deepEqual(frame.memoryStatus.maintenance.lastAttempt.unresolved, ['Verify login tests'])
  assert.equal(frame.memoryStatus.maintenance.pending, undefined)
})

test('maintenance preserves previously confirmed user constraints when replacing an input summary', async (t) => {
  const f = await fixture(t)
  await f.session.context.summarizeInput({
    ref: f.input.ref,
    baseRevision: 0,
    summary: 'Investigate',
    constraints: ['Do not send external messages'],
    unresolved: [],
  })
  const snapshot = await f.state.snapshot(8000, signal)
  f.state.acknowledge(snapshot, f.state.material(snapshot, 8000))
  await assert.rejects(
    f.state.apply(
      snapshot,
      patch(snapshot, {
        inputs: [
          {
            ref: f.input.ref,
            baseRevision: 1,
            summary: 'Investigate',
            constraints: [],
            unresolved: [],
          },
        ],
      }),
      signal
    ),
    { code: 'CONTEXT_CONSTRAINT' }
  )
  assert.equal((await f.storage.load('root')).inputSummaries[0].revision, 1)
  const previous = snapshot.inputRevisions[0].summaryRef
  assert(previous)
  const original = JSON.parse((await f.state.read(snapshot, previous, 0, 8000, signal)).text)
  assert.deepEqual(original.constraints, ['Do not send external messages'])
  await f.state.apply(
    snapshot,
    patch(snapshot, {
      inputs: [
        {
          ref: f.input.ref,
          baseRevision: 1,
          summary: 'Continue the investigation',
          constraints: [...original.constraints, 'Keep the current evidence'],
          unresolved: [],
        },
      ],
    }),
    signal
  )
  assert.equal((await f.storage.load('root')).inputSummaries[0].revision, 2)
})

test('derived note display preserves the primary version and expires when the primary model edits it', async (t) => {
  const f = await fixture(t)
  const note = await f.note()
  const snapshot = await f.state.snapshot(8000, signal)
  await f.state.apply(
    snapshot,
    patch(snapshot, { notes: [{ ref: note.ref, summary: 'Short derived presentation' }] }),
    signal
  )
  const view = await f.session.view.preview({ maxChars: 16000 }, signal)
  let projected = await f.memory.project(view, undefined, [], signal, 16000)
  let frame = JSON.parse(projected.body)
  const card = projected.history[0].content
    .split('\n')
    .find((line) => line.includes('"key":"progress"'))
  assert.equal(JSON.parse(card).representation, 'summary')
  assert.match(projected.history[0].content, /Short derived presentation/)
  assert.equal(frame.memoryStatus.maintenance.notes, undefined)
  assert.equal(
    JSON.parse((await f.memory.readMaterial(note.ref, 0, 60000, signal)).text).body,
    'Original primary note'
  )
  await f.memory.update(
    { key: 'progress', baseRevision: 1, body: 'Primary model revised the conclusion' },
    signal
  )
  // 主模型改了笔记：新版本出现在本帧尾，注明取代底座里的旧 revision
  projected = await f.memory.project(view, undefined, [], signal, 16000)
  frame = JSON.parse(projected.body)
  assert.equal(frame.partitions.workspace.notes[0].text, 'Primary model revised the conclusion')
  assert.equal(frame.partitions.workspace.notes[0].representation, 'full')
  assert.equal(frame.partitions.workspace.notes[0].supersedes, 1)
  const fresh = await f.state.snapshot(8000, signal)
  await assert.rejects(
    f.state.apply(
      fresh,
      patch(fresh, { notes: [{ ref: note.ref, summary: 'stale view' }] }),
      signal
    ),
    { code: 'WORKSPACE_CONFLICT' }
  )
  await assert.rejects(
    f.state.apply(
      fresh,
      patch(fresh, {
        notes: [{ key: 'progress', baseRevision: 2, body: 'organizer must not rewrite' }],
      }),
      signal
    ),
    /呈现补丁无效/
  )
})

test('organize plus done delivers the actual outcome in another main request before completion', async (t) => {
  let calls = 0
  let tools = 0
  const f = await setupTool(
    t,
    driver(async function* (request) {
      if (++calls === 1) {
        yield {
          type: 'text',
          text: `${execute(request, "import {memory} from 'velaros:system';await memory.organize({focus:'Verify next steps'});").text}\n${request.compiledPrompt.match(/当前帧标记：(\S+)。普通/)[1]} done`,
        }
        yield finish
      } else {
        const status = JSON.parse(request.materials[0].text).memoryStatus.maintenance.lastAttempt
        assert.equal(status.status, 'applied')
        assert(status.requestId)
        yield* done(request)
      }
    }),
    driver(async function* (request) {
      tools++
      yield* deliverPatch(request)
    })
  )
  await runTool(f)
  assert.equal(calls, 2)
  assert.equal(tools, 1)
})

test('failed organize is reported automatically without discarding primary notes or claiming success', async (t) => {
  let calls = 0
  const f = await setupTool(
    t,
    driver(async function* (request) {
      if (++calls === 1) {
        yield execute(
          request,
          "import {memory} from 'velaros:system';await memory.update({key:'plan',baseRevision:0,body:'Run failing tests'});await memory.organize({focus:'Inspect failure'});"
        )
        yield finish
      } else {
        const frame = JSON.parse(request.materials[0].text)
        assert.equal(frame.memoryStatus.maintenance.lastAttempt.status, 'failed')
        assert(frame.memoryStatus.maintenance.lastAttempt.error)
        assert.equal(frame.partitions.workspace.notes[0].text, 'Run failing tests')
        yield* done(request)
      }
    }),
    driver(async function* (request) {
      yield* done(request, 'No supported patch')
    })
  )
  await runTool(f)
  assert.equal(calls, 2)
})

test('organize validates preserve scope, coalesces a pending request and keeps explicit references', async (t) => {
  let snapshot
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    driver(async function* (request) {
      snapshot = snapshotOf(request)
      yield* deliverPatch(request)
    })
  )
  const note = await f.session.execute({
    source:
      "import {memory} from 'velaros:system';import {output} from 'velaros';output(await memory.update({key:'critical',baseRevision:0,body:'Keep this constraint'}));",
  })
  const ref = note.result.value.default.ref
  const result = await f.session.execute({
    source: `import {memory} from 'velaros:system';import {output} from 'velaros';const first=await memory.organize({focus:'First',preserve:[${JSON.stringify(ref)}]});const second=await memory.organize({focus:'Next'});output({first,second});`,
  })
  assert(!result.result.failed)
  assert.equal(
    result.result.value.default.first.requestId,
    result.result.value.default.second.requestId
  )
  const bad = await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({preserve:[{sessionId:'elsewhere',id:'unknown'}]});",
  })
  assert(bad.result.failed)
  await assert.rejects(
    f.session.execute({
      source: "import {memory} from 'velaros:system';await memory.organize({targetChars:1});",
    }),
    { code: 'SCRIPT_CHECK' }
  )
  await runTool(f)
  assert.equal(snapshot.intent.focus, 'Next')
  assert.deepEqual(snapshot.intent.preserve, [ref])
  assert(snapshot.protectedRefs.some((item) => item.id === ref.id))
  const state = new ContextMaintenanceState('root', f.storage)
  const fresh = {
    ...(await state.snapshot(8000, signal)),
    intent: { preserve: [ref] },
    protectedRefs: [ref],
  }
  await assert.rejects(
    state.apply(fresh, patch(fresh, { notes: [{ ref, resident: false }] }), signal),
    /保留的笔记/
  )
})

test('a new logical task does not consume a previous pending organization request', async (t) => {
  let tools = 0
  const f = await setupTool(
    t,
    driver(async function* (request) {
      assert(!JSON.stringify(request).includes('obsolete focus'))
      yield* done(request)
    }),
    driver(async function* (request) {
      tools++
      yield* deliverPatch(request)
    })
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'obsolete focus'});",
  })
  await runTool(f, { text: 'New independent task', task: 'new' })
  assert.equal(tools, 0)
})

test('automatic pressure and a fresh organize request do not inherit an already consumed focus', async (t) => {
  let pressure = false
  let relieved = false
  const focuses = []
  const main = driver(
    async function* (request) {
      yield* done(request)
    },
    async () => ({
      tokens: pressure && !relieved ? 85000 : 1000,
      precision: 'exact',
      basis: 'pressure boundary',
    })
  )
  const f = await setupTool(
    t,
    main,
    driver(async function* (request) {
      focuses.push(snapshotOf(request).intent.focus)
      if (pressure) relieved = true
      yield* deliverPatch(request)
    })
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'obsolete stage-specific action'});",
  })
  await runTool(f)
  assert.deepEqual(focuses, ['obsolete stage-specific action'])
  pressure = true
  await runTool(f, 'Continue with the current task state')
  assert.equal(focuses.length, 2)
  assert.notEqual(focuses[1], 'obsolete stage-specific action')
  const result = await f.session.execute({
    source:
      "import {memory} from 'velaros:system';import {output} from 'velaros';output(await memory.organize({}));",
  })
  assert(!result.result.failed)
  assert.equal(result.result.value.default.focus, '')
})

test('store reference maintenance releases only presentation and re-access restores the task reference', async (t) => {
  const f = await fixture(t)
  const created = await f.session.execute({
    source:
      "import {store} from 'velaros:system';import {output} from 'velaros';output(await store.create({name:'finished investigation'}));",
  })
  const id = created.result.value.default.id
  const snapshot = await f.state.snapshot(16000, signal)
  assert(snapshot.storeRefs.includes(id))
  await f.state.apply(snapshot, patch(snapshot, { releaseStoreRefs: [id] }), signal)
  let state = await f.storage.load('root')
  assert(!state.task.storeRefs.includes(id))
  assert(state.task.releasedStoreRefs.includes(id))
  assert((await f.storage.stores.describe('session:root', id)).archived === false)
  const listing = await f.session.execute({
    source:
      "import {store} from 'velaros:system';import {output} from 'velaros';output(await store.list({active:true}));",
  })
  assert.deepEqual(listing.result.value.default.items, [])
  await f.session.execute({
    source: `import {store} from 'velaros:system';await store.get({store:${JSON.stringify(id)},key:'x'});`,
  })
  state = await f.storage.load('root')
  assert(state.task.storeRefs.includes(id))
  assert(!state.task.releasedStoreRefs.includes(id))
  const next = await f.state.snapshot(16000, signal)
  await assert.rejects(
    f.state.apply(next, patch(next, { releaseStoreRefs: ['unknown'] }), signal),
    /只能释放/
  )
})

test('maintenance preflight checks the complete candidate without publishing parent metadata', async (t) => {
  const f = await fixture(t)
  const note = await f.note()
  const snapshot = await f.state.snapshot(8000, signal)
  const before = await f.storage.load('root')
  await f.state.validate(
    snapshot,
    patch(snapshot, { notes: [{ ref: note.ref, summary: 'Preview only' }] }),
    signal
  )
  assert.deepEqual(await f.storage.load('root'), before)
  await assert.rejects(
    f.state.validate(
      snapshot,
      patch(snapshot, {
        volume: { summary: 'nothing sealed', evidence: [], unresolved: [], negativeAttempts: [] },
      }),
      signal
    ),
    /快照里还没有卷/
  )
  assert.deepEqual(await f.storage.load('root'), before)
  await f.state.apply(
    snapshot,
    patch(snapshot, { notes: [{ ref: note.ref, summary: 'Published' }] }),
    signal
  )
  assert(
    (await f.storage.load('root')).records.some(
      (record) => record.title === 'context-maintenance:applied'
    )
  )
})

test('a maintenance patch error is corrected within the same leaf before publication', async (t) => {
  let calls = 0
  const maintenance = driver(async function* (request) {
    calls++
    // 类型合法、状态不符：过得了类型检查，由补丁校验在同一支线里报出来
    if (calls === 1) {
      yield* deliverPatch(request, {
        volume: { summary: 'nothing sealed', evidence: [], unresolved: [], negativeAttempts: [] },
      })
    } else {
      assert.equal(calls, 2)
      assert.match(JSON.stringify(request), /快照里还没有卷/)
      yield* deliverPatch(request)
    }
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source: "import {memory} from 'velaros:system';await memory.organize({focus:'keep the task'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  assert.equal(
    state.records.filter((record) => record.title === 'context-maintenance:applied').length,
    1
  )
  const outcomes = state.records.filter((record) => record.title === 'context-maintenance:outcome')
  assert.equal(outcomes.length, 1)
  assert.equal(JSON.parse(await f.storage.get('root', outcomes[0].objectId)).status, 'applied')
})

test('read-only maintenance can deliver a validated patch while its own old preview is unavailable', async (t) => {
  let calls = 0
  const maintenance = driver(async function* (request) {
    calls++
    if (calls === 1) {
      yield execute(
        request,
        "import {output} from 'velaros';output('large'.repeat(1000),{key:'old-preview',required:true,view:{mode:'reference'}});"
      )
      yield finish
    } else {
      assert.equal(calls, 2)
      assert.equal(request.contextStatus.phase, 'work')
      yield* deliverPatch(request, { unresolved: ['Old exploration preview was not displayed.'] })
    }
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'preserve the task'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  const record = state.records.findLast((record) => record.title === 'context-maintenance:applied')
  assert(record)
  assert.match(await f.storage.get('root', record.objectId), /Old exploration preview/)
})

test('input summaries require original pages in the model facts, not a successful hidden read', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.state.snapshot(8000, signal)
  const candidate = patch(snapshot, {
    inputs: [
      {
        ref: f.input.ref,
        baseRevision: 0,
        summary: 'Investigate the failure',
        constraints: ['Do not send external messages'],
        unresolved: [],
      },
    ],
  })
  await f.state.read(snapshot, f.input.ref, 0, 32000, signal)
  await assert.rejects(f.state.validate(snapshot, candidate, signal), {
    code: 'CONTEXT_INPUT_UNSEEN',
  })
  assert.equal((await f.storage.load('root')).inputSummaries?.length ?? 0, 0)
  const material = f.state.material(snapshot, 8000)
  assert.equal(
    material.inputs[0].text,
    'Investigate the failure. Do not send any external messages.'
  )
  await assert.rejects(f.state.validate(snapshot, candidate, signal), {
    code: 'CONTEXT_INPUT_UNSEEN',
  })
  f.state.acknowledge(snapshot, material)
  await f.state.validate(snapshot, candidate, signal)
  assert.equal((await f.storage.load('root')).inputSummaries?.length ?? 0, 0)
  await f.state.apply(snapshot, candidate, signal)
  assert.equal((await f.storage.load('root')).inputSummaries[0].revision, 1)
})

test('input summary coverage joins actual pages, respects fact budgets and resets with the snapshot', async (t) => {
  const f = await fixture(t)
  const input = await f.session.context.append({
    kind: 'user',
    body: `${'a'.repeat(9000)} keep the last condition`,
  })
  const snapshot = await f.state.snapshot(8000, signal)
  const candidate = patch(snapshot, {
    inputs: [
      {
        ref: input.ref,
        baseRevision: 0,
        summary: 'Large input with a final condition',
        constraints: ['keep the last condition'],
        unresolved: [],
      },
    ],
  })
  await f.state.read(snapshot, input.ref, 0, 32000, signal)
  const small = f.state.material(snapshot, 1000)
  assert(JSON.stringify(small).length <= 1000)
  f.state.acknowledge(snapshot, small)
  await assert.rejects(f.state.validate(snapshot, candidate, signal), {
    code: 'CONTEXT_INPUT_UNSEEN',
  })
  await f.state.read(snapshot, input.ref, 0, 4500, signal)
  f.state.acknowledge(snapshot, f.state.material(snapshot, 6000))
  await f.state.read(snapshot, input.ref, 4500, 5000, signal)
  f.state.acknowledge(snapshot, f.state.material(snapshot, 6000))
  await f.state.validate(snapshot, candidate, signal)
  await f.memory.update({ key: 'next', baseRevision: 0, body: 'New parent material' }, signal)
  const fresh = await f.state.snapshot(8000, signal)
  await assert.rejects(
    f.state.validate(fresh, { ...candidate, baseRevision: fresh.baseRevision }, signal),
    { code: 'CONTEXT_INPUT_UNSEEN' }
  )
})

test('INV-34 maintenance receives parent goals directly and acknowledges their evidence before applying a summary', async (t) => {
  let calls = 0
  const goal =
    'Inspect all batches; ask the host before each revision, then resume the same worker.'
  const maintenance = driver(async function* (request) {
    calls++
    const frame = JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)
    const input = frame.partitions.runtime.modelTool.inputs.find((item) => item.text === goal)
    assert(input)
    assert(request.compiledPrompt.includes(goal))
    yield* deliverPatch(request, {
      inputs: [
        {
          ref: input.ref,
          baseRevision: 0,
          summary: 'Inspect batches and continue revisions in order.',
          constraints: [
            'Ask the host before each revision; resume the same worker only after the reply.',
          ],
          unresolved: [],
        },
      ],
    })
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'keep host revision order'});",
  })
  await runTool(f, goal)
  assert.equal(calls, 1)
  const state = await f.storage.load('root')
  assert.equal(state.inputSummaries.length, 1)
  assert(state.records.some((record) => record.title === 'context-maintenance:applied'))
})

test('an accepted maintenance candidate tells the leaf to finish before parent publication', async (t) => {
  let calls = 0
  const maintenance = driver(async function* (request) {
    calls++
    if (calls === 1) {
      const snapshot = JSON.parse(
        JSON.parse(request.materials[0].text).partitions.task.goals[0].text
      ).snapshot
      yield execute(
        request,
        `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(patch(snapshot))}));`
      )
      yield finish
    } else {
      assert.equal(calls, 2)
      assert.match(request.compiledPrompt, /当前候选补丁已通过校验并受理/)
      assert.match(request.compiledPrompt, /applied 回执只在本支线完成之后产生/)
      yield* done(request)
    }
  })
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'finish the candidate'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  assert.equal(
    (await f.storage.load('root')).records.filter(
      (item) => item.title === 'context-maintenance:applied'
    ).length,
    1
  )
})
