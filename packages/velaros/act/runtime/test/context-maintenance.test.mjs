import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { createAiSdkModelDriver } from '@velaros-ai/model'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { VelarContextMaterialsModule } from '../../../dist/act/system/contract/surface.js'
import { ContextMaintenanceState } from '../../../dist/act/system/impl/ContextMaintenanceState.js'

import { baseText, done } from './support/model-turn.mjs'

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

test('archived model image audit does not invalidate maintenance or enter its material snapshot', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.state.snapshot(8000, signal)
  await f.session.context.append({
    kind: 'audit',
    title: 'model-request:image-data',
    body: 'PRIVATE_IMAGE_PIXELS',
  })
  await f.state.apply(snapshot, patch(snapshot), signal)
  const next = await f.state.snapshot(8000, signal)
  assert(!JSON.stringify(next).includes('PRIVATE_IMAGE_PIXELS'))
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

test('cancelling recovery validation cannot publish a late candidate or change the parent revision', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers()
  const late = Promise.withResolvers()
  let previews = 0
  const state = new ContextMaintenanceState('root', f.storage, {
    recoveryChars: 3000,
    validateCandidate: () => {
      if (++previews === 1)
        return Promise.reject(Object.assign(Error('window'), { code: 'CONTEXT_BUDGET' }))
      entered.resolve()
      return late.promise
    },
  })
  const snapshot = await state.snapshot(8000, signal)
  const controller = new AbortController()
  const pending = state.apply(snapshot, patch(snapshot), controller.signal)
  await entered.promise
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  late.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(previews, 2)
  assert.equal((await state.snapshot(8000, signal)).baseRevision, snapshot.baseRevision)
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
})

for (const code of ['CONTEXT_CONFLICT', 'CANCELLED', 'CONTEXT_BUDGET'])
  test(`candidate preparation preserves ${code} and does not retry an unavailable recovery path`, async (t) => {
    const f = await fixture(t)
    const error = Object.assign(Error(code), { code })
    let previews = 0
    const state = new ContextMaintenanceState('root', f.storage, {
      recoveryChars: code === 'CONTEXT_BUDGET' ? 8000 : 3000,
      validateCandidate: async () => {
        previews++
        throw error
      },
    })
    const snapshot = await state.snapshot(8000, signal)
    await assert.rejects(
      state.apply(snapshot, patch(snapshot), signal),
      (caught) => caught === error
    )
    assert.equal(previews, 1)
    assert.equal((await state.snapshot(8000, signal)).baseRevision, snapshot.baseRevision)
    assert(
      !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
    )
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
  assert.match(baseText(before), /x{2400}/)
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
  assert.match(baseText(first), /Temporary summary/)
  assert.doesNotMatch(baseText(first), /x{2400}/)
  await f.programs.consume(frame.frameId, signal)
  const later = await memory.project(view, undefined, [], signal, 16000)
  assert.equal(JSON.parse(later.body).memoryStatus.maintenance.active, true)
  assert.equal(baseText(later), baseText(first))
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
  assert.match(baseText(fresh), /y{2400}/)
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

for (const indexed of [true, false])
  test(`maintenance catalog fills pages with working materials across noisy internal history: indexed=${indexed}`, async (t) => {
    const f = await fixture(t)
    if (!indexed) f.storage.selectSnapshot = undefined
    const expected = [f.input]
    for (let batch = 0; batch < 3; batch++) {
      for (let index = 0; index < 35; index++)
        await f.session.context.append({
          kind: 'audit',
          title: [
            'act:event',
            'script:lease-state',
            'context:frame:internal',
            'model-continuation',
            'runtime:frame-marker:internal',
          ][index % 5],
          body: '{}',
        })
      expected.push(
        await f.session.context.append({ kind: 'assistant', body: `Observed batch ${batch}` })
      )
      expected.push(
        await f.session.context.append({
          kind: 'audit',
          title: `script:execution-${batch}:result`,
          body: `Result ${batch}`,
        })
      )
    }
    const note = await f.note()
    const snapshot = await f.state.snapshot(8000, signal)
    let after = 0
    const ids = []
    let pages = 0
    for (;;) {
      const page = await f.state.list(snapshot, after, 2, signal)
      pages++
      assert(page.items.length > 0, 'internal records cannot consume a visible page')
      for (const record of page.items) {
        assert(record.sequence > after)
        assert(!/^(act:|runtime:|model-|context:frame:|script:lease-state$)/u.test(record.title))
        ids.push(record.ref.id)
        assert.equal(
          (await f.state.read(snapshot, record.ref, 0, 100, signal)).record.ref.id,
          record.ref.id
        )
      }
      if (page.nextAfter === null) break
      assert.equal(page.items.length, 2)
      assert.equal(page.nextAfter, page.items.at(-1).sequence)
      after = page.nextAfter
    }
    assert.deepEqual(ids, [...expected.map((record) => record.ref.id), note.ref.id])
    assert.equal(pages, 4)
    assert.deepEqual(await f.state.list(snapshot, snapshot.through, 2, signal), {
      items: [],
      nextAfter: null,
    })
    await f.session.context.append({
      kind: 'user',
      body: 'Changed authorization and task requirements',
    })
    await assert.rejects(f.state.list(snapshot, 0, 2, signal), { code: 'CONTEXT_CONFLICT' })
  })

test('maintenance catalog respects task resets and explicit reattachment of an old input', async (t) => {
  const f = await fixture(t)
  const prior = await f.session.context.append({ kind: 'user', body: 'Old unrelated task' })
  await f.session.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  const current = await f.session.context.append({
    kind: 'user',
    body: 'Read the attached original',
    sources: [f.input.ref],
  })
  await f.session.view.appendGoal(current.ref)
  const snapshot = await f.state.snapshot(8000, signal)
  const page = await f.state.list(snapshot, 0, 64, signal)
  assert(page.items.some((record) => record.ref.id === f.input.ref.id))
  assert(page.items.some((record) => record.ref.id === current.ref.id))
  assert(!page.items.some((record) => record.ref.id === prior.ref.id))
  await assert.rejects(f.state.read(snapshot, prior.ref, 0, 100, signal), {
    code: 'SCOPE_MISMATCH',
  })
})

test('volume narrative rejection identifies every invalid evidence reference without publishing', async (t) => {
  const f = await fixture(t)
  const sealed = await f.session.context.append({
    kind: 'checkpoint',
    title: 'context:volume',
    body: JSON.stringify({ from: 0, through: f.input.sequence, skeleton: 'Fixture evidence' }),
  })
  const recent = new RecentContext('root', f.session.context, f.storage)
  const invalid = [
    { sessionId: 'root', id: 'missing-one' },
    { sessionId: 'other', id: f.input.ref.id },
    { sessionId: 'root', id: 'missing-two' },
  ]
  const narrative = {
    summary: 'Observed work',
    unresolved: [],
    negativeAttempts: [],
    evidence: [f.input.ref, ...invalid],
  }
  await assert.rejects(recent.narrate(sealed.ref, narrative, signal), (error) => {
    assert.equal(error.code, 'PERMISSION')
    for (const ref of invalid) assert(error.message.includes(JSON.stringify(ref)))
    return true
  })
  assert(
    !(await f.storage.load('root')).records.some(
      (record) => record.title === 'context:volume-narrative'
    )
  )
  const receipt = await recent.narrate(
    sealed.ref,
    { ...narrative, evidence: [f.input.ref] },
    signal
  )
  assert(receipt.id)
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
  text: `${request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]} execute()\n${source}\n${request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]}`,
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
    text: `${part.text}\n${request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]} done`,
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
    context: { sources: [], maintenance: { model: maintenance, execution: 'script' } },
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

test('a truncated maintenance request remains pageable through the available read operation', async (t) => {
  let calls = 0
  const estimates = []
  const marker = 'COMPLETE_REQUEST_RECALLED'
  const maintenance = {
    ...driver(
      async function* (request) {
        calls++
        const frame = JSON.parse(request.materials[0].text)
        const goal = frame.partitions.task.goals[0]
        let code
        if (calls === 1) {
          assert(goal.text.length < goal.totalChars)
          const local = await f.storage.load(goal.record.ref.sessionId)
          const audit = local.records.find((record) => record.kind === 'audit')
          assert(audit)
          code = `import {read} from 'velaros:context-materials';
const ref=${JSON.stringify(goal.record.ref)};
const first=await read({ref,offset:0,limit:1500});
const next=await read({ref,offset:1500,limit:32000});
const original=JSON.parse(first.text+next.text);
if(!original.snapshot.intent.focus.includes(${JSON.stringify(marker)}) || first.text.length+next.text.length!==first.totalChars) throw Error('incomplete request');
for(const ref of [${JSON.stringify(audit.ref)},{sessionId:'unrelated',id:'secret'}]) {
 let denied=false; try {await read({ref})} catch(error) {if(error.code!=='SCOPE_MISMATCH')throw error;denied=true} if(!denied)throw Error('unexpected access');
}`
        } else {
          assert.equal(calls, 2)
          const local = await f.storage.load(goal.record.ref.sessionId)
          const result = local.records.findLast((record) => /^script:.*:result$/.test(record.title))
          assert(result)
          const archived = JSON.parse(
            await f.storage.get(goal.record.ref.sessionId, result.objectId)
          )
          assert.equal(archived.result.failed, undefined, JSON.stringify(archived.result.failed))
          code = `import {submit} from 'velaros:context-materials';console.log(await submit(${JSON.stringify({ baseRevision: frame.partitions.runtime.modelTool.baseRevision, summary: 'Recovered the complete maintenance request.', unresolved: [] })}));`
        }
        yield {
          type: 'tool-call',
          value: { id: `request-read-${calls}`, name: 'exec', input: { code } },
        }
        yield finish
      },
      async (request) => {
        const goal = JSON.parse(request.materials[0].text).partitions.task.goals[0]
        estimates.push({ shown: goal.text.length, total: goal.totalChars, calls })
        return {
          tokens: calls || goal.text.length < goal.totalChars ? 1000 : 100000,
          precision: 'exact',
          basis: 'force the initial request into recovery projection',
        }
      }
    ),
    nativeTools: true,
  }
  const f = await setupTool(t, driver(done), maintenance)
  await f.session.execute({
    source: `import {memory} from 'velaros:system';await memory.plan({decisions:Array.from({length:8},(_,index)=>index+': '+'context '.repeat(110))});await memory.organize({focus:${JSON.stringify('f'.repeat(900) + marker + 'g'.repeat(900))}});`,
  })
  await runTool(f)
  const state = await f.storage.load('root')
  const record = state.records.findLast((r) => r.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(
    calls,
    2,
    JSON.stringify({ error: outcome.error, status: outcome.status, estimates })
  )
  assert(estimates.some((item) => item.calls === 0 && item.shown === item.total))
  assert(estimates.some((item) => item.calls === 0 && item.shown < item.total))
  assert.equal(outcome.status, 'applied', outcome.error)
  assert.equal(outcome.error, null)
})

test('context maintenance publishes a validated native Node patch in one model request', async (t) => {
  let mainCalls = 0
  let toolCalls = 0
  const main = driver(async function* (request) {
    assert(!request.instructions.includes(VelarContextMaterialsModule.declarations))
    if (++mainCalls === 1) {
      yield execute(
        request,
        "import {memory} from 'velaros:system'; await memory.organize({focus:'Keep verified progress'});"
      )
      yield finish
    } else yield* done(request)
  })
  const maintenance = {
    ...driver(async function* (request) {
      toolCalls++
      assert.equal(request.response.type, 'tools')
      assert.match(request.compiledPrompt, /当前运行状态/)
      assert.doesNotMatch(request.instructions, /snapshotPlans/)
      assert(
        request.instructions.includes(VelarContextMaterialsModule.declarations),
        'the invoked maintenance tool receives its generated contract before its first response'
      )
      assert.deepEqual(
        request.response.tools.map((tool) => tool.name),
        ['blobs', 'exec', 'done']
      )
      assert.equal(toolCalls, 1)
      yield {
        type: 'tool-call',
        value: {
          id: 'patch',
          name: 'exec',
          input: {
            code: `import {submit} from 'velaros:context-materials'; console.log(await submit(${JSON.stringify(patch(snapshotOf(request)))}));`,
          },
        },
      }
      yield finish
    }),
    nativeTools: true,
  }
  const f = await setupTool(t, main, maintenance)
  await runTool(f)
  assert.equal(mainCalls, 2)
  assert.equal(toolCalls, 1)
  const state = await f.storage.load('root')
  assert(state.records.some((record) => record.title === 'context-maintenance:applied'))
})

test('maintenance facts include bounded recent original records with recall ranges and respect task reset', async (t) => {
  const f = await fixture(t)
  const plan = await f.session.context.append({
    kind: 'assistant',
    body: 'Plan to examine the adapter',
  })
  await f.session.execute({ source: "console.log('Verification has not run; adapter was read')" })
  await f.session.context.append({
    kind: 'audit',
    title: 'model-request',
    body: 'private request metadata',
  })
  const snapshot = await f.state.snapshot(8000, signal)
  const material = f.state.material(snapshot, 8000)
  assert(JSON.stringify(material).length <= 8000)
  assert(material.recent.some((page) => page.ref.id === plan.ref.id))
  assert(material.recent.some((page) => page.text.includes('Verification has not run')))
  assert(!JSON.stringify(material).includes('private request metadata'))
  assert.deepEqual(
    material.recent.map((page) => page.sequence),
    material.recent.map((page) => page.sequence).sort((a, b) => a - b)
  )
  for (const page of material.recent) {
    const original = await f.session.context.read(page.ref, {
      offset: page.offset,
      limit: Math.max(1, page.text.length),
    })
    assert.equal(page.text, original.text.slice(0, page.text.length))
    assert.equal(page.totalChars, original.totalChars)
    assert.equal(page.nextOffset, page.text.length < page.totalChars ? page.text.length : null)
  }
  await f.session.view.end('completed')
  const input = await f.session.context.append({ kind: 'user', body: 'A separate authorized task' })
  await f.session.view.begin(input.ref, signal, 'new')
  const fresh = await f.state.snapshot(8000, signal)
  assert.deepEqual(f.state.material(fresh, 8000).recent, [])
})

test('automatic narration preloads the sealed interval and rejects evidence from later work', async (t) => {
  const f = await fixture(t)
  const first = await f.session.context.append({ kind: 'assistant', body: 'Inspect the adapter' })
  const last = await f.session.context.append({ kind: 'assistant', body: 'Inspection is complete' })
  const recent = new RecentContext('root', f.session.context, f.storage)
  const volume = await recent.seal(first.sequence - 1, last.sequence, signal)
  const next = await f.session.context.append({
    kind: 'assistant',
    body: 'Next I will implement the adapter and run the tests',
  })
  const state = new ContextMaintenanceState('root', f.storage, undefined, 'volume')
  const snapshot = await state.snapshot(8000, signal)
  const facts = state.material(snapshot, 8000)
  assert.deepEqual(
    facts.recent.map((page) => page.ref.id),
    [first.ref.id, last.ref.id]
  )
  assert.equal(snapshot.volume.ref.id, volume.id)
  assert.deepEqual(facts.volume, {
    ref: volume,
    from: first.sequence - 1,
    through: last.sequence,
  })
  const directory = await state.list(snapshot, 0, 64, signal)
  assert(directory.items.some((item) => item.ref.id === last.ref.id))
  assert(directory.items.every((item) => item.sequence <= facts.volume.through))
  assert.equal(directory.nextAfter, null)
  const small = state.material(snapshot, 750)
  assert.deepEqual(small.volume, facts.volume)
  assert(JSON.stringify(small).length <= 750)
  const narrative = {
    summary: 'Implementation is planned',
    evidence: [next.ref],
    unresolved: ['Implement the adapter'],
    negativeAttempts: [],
  }
  await assert.rejects(state.apply(snapshot, patch(snapshot, { volume: narrative }), signal), {
    code: 'CONTEXT_NARRATIVE_RANGE',
  })
  assert(
    !(await f.storage.load('root')).records.some((r) => r.title === 'context:projection-policy')
  )
  await recent.narrate(
    volume,
    {
      ...narrative,
      summary: 'Inspected the adapter',
      evidence: [f.input.ref, first.ref, last.ref],
    },
    signal
  )
  const current = new ContextMaintenanceState('root', f.storage)
  const currentSnapshot = await current.snapshot(8000, signal)
  assert(current.material(currentSnapshot, 8000).recent.some((page) => page.ref.id === next.ref.id))
  assert(
    (await current.list(currentSnapshot, 0, 64, signal)).items.some(
      (item) => item.ref.id === next.ref.id
    )
  )
})

test('small maintenance facts deliver readable recent pages and advance only accepted ranges', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 20; i++)
    await f.session.context.append({ kind: 'assistant', body: `Earlier observation ${i}` })
  const original = `Implementation is pending. ${'Quoted "fact"\\path 中文. '.repeat(40)}`
  const latest = await f.session.context.append({ kind: 'assistant', body: original })
  const snapshot = await f.state.snapshot(8000, signal)
  const collected = []
  for (let turn = 0; turn < 30; turn++) {
    const material = f.state.material(snapshot, 1000)
    assert(JSON.stringify(material).length <= 1000)
    assert.deepEqual(f.state.material(snapshot, 1000), material)
    assert(material.recent.length > 0)
    assert(material.recent.every((page) => page.text.length > 0))
    const page = material.recent.find((item) => item.ref.id === latest.ref.id)
    assert(page, 'the most recent unread page must remain available')
    assert.equal(page.offset, collected.join('').length)
    assert.equal(page.text, original.slice(page.offset, page.offset + page.text.length))
    collected.push(page.text)
    f.state.acknowledge(snapshot, {
      ...material,
      recent: material.recent.map((item) => ({ ...item, text: 'forged text' })),
    })
    assert.deepEqual(f.state.material(snapshot, 1000).recent, material.recent)
    f.state.acknowledge(snapshot, material)
    if (page.nextOffset === null) break
  }
  assert.equal(collected.join(''), original)
  const later = f.state.material(snapshot, 1000)
  assert(later.recent.some((page) => page.ref.id !== latest.ref.id))
})

test('explicit non-input recall enters maintenance facts at its exact range and resets with the task', async (t) => {
  const f = await fixture(t)
  const record = await f.session.context.append({
    kind: 'assistant',
    body: `${'x'.repeat(4000)}The operation was read-only; implementation and verification are pending.`,
  })
  for (let i = 0; i < 40; i++)
    await f.session.context.append({ kind: 'assistant', body: `Later observation ${i}` })
  const snapshot = await f.state.snapshot(8000, signal)
  assert(!f.state.material(snapshot, 2000).recent.some((page) => page.ref.id === record.ref.id))
  const recalled = await f.state.read(snapshot, record.ref, 4000, 1000, signal)
  const material = f.state.material(snapshot, 2000)
  const delivered = material.recent.find((page) => page.ref.id === record.ref.id)
  assert(delivered, 'successful recall must have a direct model-visible material route')
  assert.equal(delivered.offset, 4000)
  assert.equal(delivered.text, recalled.text)
  assert.equal(delivered.totalChars, recalled.totalChars)
  assert.equal(delivered.nextOffset, null)
  f.state.acknowledge(snapshot, material)
  await f.state.read(snapshot, record.ref, 4000, 1000, signal)
  assert.equal(
    f.state.material(snapshot, 2000).recent.find((page) => page.ref.id === record.ref.id)?.text,
    recalled.text,
    'an explicit recall must remain visible even when that range was delivered earlier'
  )
  await f.session.view.end('completed')
  const input = await f.session.context.append({ kind: 'user', body: 'Start a separate task' })
  await f.session.view.begin(input.ref, signal, 'new')
  const fresh = await f.state.snapshot(8000, signal)
  assert.deepEqual(f.state.material(fresh, 2000).recent, [])
})

test('native maintenance publishes a validated final-call patch without another model request', async (t) => {
  let calls = 0
  const maintenance = {
    ...driver(async function* (request) {
      calls++
      assert(calls <= 2)
      if (calls === 2) assert.equal(request.contextStatus.phase, 'finalizing')
      yield {
        type: 'tool-call',
        value: {
          id: `step-${calls}`,
          name: 'exec',
          input: {
            code:
              calls === 1
                ? "console.log('Review the supplied snapshot')"
                : `import {submit} from 'velaros:context-materials'; console.log(await submit(${JSON.stringify(patch(snapshotOf(request), { unresolved: ['Verify remaining work'] }))}));`,
          },
        },
      }
      yield finish
    }),
    nativeTools: true,
  }
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance,
    {
      context: {
        sources: [],
        maintenance: { execution: 'script', model: maintenance, profile: { modelCalls: 2 } },
      },
    }
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system'; await memory.organize({focus:'Review progress'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  assert(state.records.some((record) => record.title === 'context-maintenance:applied'))
  const record = state.records.findLast((record) => record.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.error, null)
})

test('native maintenance recovers an oversized initial projection and can read before submitting', async (t) => {
  let calls = 0
  let recovered = false
  const maintenance = {
    ...driver(
      async function* (request) {
        calls++
        assert.equal(request.contextStatus.phase, 'work')
        assert(calls <= 2)
        if (calls === 2) assert.match(JSON.stringify(request.history), /items/)
        yield {
          type: 'tool-call',
          value: {
            id: `recover-${calls}`,
            name: 'exec',
            input: {
              code:
                calls === 1
                  ? "import {list} from 'velaros:context-materials'; console.log(await list({limit:8}));"
                  : `import {submit} from 'velaros:context-materials'; console.log(await submit(${JSON.stringify(patch(snapshotOf(request)))}));`,
            },
          },
        }
        yield finish
      },
      async (request) => {
        const small = request.materials[0].text.length < 12000
        if (small) recovered = true
        return {
          tokens: small || calls > 0 ? 1000 : 100000,
          precision: 'exact',
          basis: 'fixture: initial full projection exceeds the window',
        }
      }
    ),
    nativeTools: true,
  }
  const f = await setupTool(
    t,
    driver(async function* (request) {
      yield* done(request)
    }),
    maintenance
  )
  await f.session.context.append({ kind: 'assistant', body: 'Verified records\n'.repeat(1500) })
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system'; await memory.organize({focus:'Review progress'});",
  })
  await runTool(f)
  assert.equal(recovered, true)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  const record = state.records.findLast((item) => item.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.error, null)
})

test('shared provider usage lets maintenance deliver the full original in its first native request', async (t) => {
  const original = 'Review all source batches and preserve every original constraint. '.repeat(90)
  let activeRequest
  let mainCalls = 0
  let maintenanceCalls = 0
  let firstInputChars = 0
  const standard = createAiSdkModelDriver({
    id: 'offline-shared-input-estimator',
    model: {
      specificationVersion: 'v3',
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      supportedUrls: {},
      async doStream() {
        const frame = JSON.parse(activeRequest.materials[0].text)
        const facts = frame.partitions.runtime.modelTool
        let code
        if (facts) {
          maintenanceCalls++
          const input = facts.inputs.find((item) => item.text.startsWith('Review all source'))
          firstInputChars = input?.text.length ?? 0
          assert.equal(
            input?.text,
            original,
            'shared route calibration preserves the complete first input'
          )
          assert.equal(maintenanceCalls, 1)
          const candidate = {
            baseRevision: facts.baseRevision,
            summary: 'Preserved the complete input and its pending review.',
            unresolved: ['Review source batches'],
            inputs: [
              {
                ref: input.ref,
                baseRevision: 0,
                summary: 'Review all source batches',
                constraints: ['Preserve every original constraint'],
                unresolved: ['Review source batches'],
              },
            ],
          }
          code = `import {submit} from 'velaros:context-materials';console.log(await submit(${JSON.stringify(candidate)}));`
        } else if (++mainCalls === 1) {
          code =
            "import {memory} from 'velaros:system';console.log('Observed source records; verification remains pending. '.repeat(1200));await memory.organize({focus:'Preserve the complete task'});"
        }
        const chunks = [
          { type: 'stream-start', warnings: [] },
          ...(code
            ? [
                {
                  type: 'tool-call',
                  toolCallId: `call-${mainCalls}-${maintenanceCalls}`,
                  toolName: 'exec',
                  input: JSON.stringify({ code }),
                },
              ]
            : [
                {
                  type: 'tool-call',
                  toolCallId: `done-${mainCalls}`,
                  toolName: 'done',
                  input: JSON.stringify({ message: 'Finished the fixture.' }),
                },
              ]),
          {
            type: 'finish',
            finishReason: {
              unified: code ? 'tool-calls' : 'stop',
              raw: code ? 'tool_calls' : 'stop',
            },
            usage: {
              inputTokens: {
                total: facts ? 12000 : 6000,
                noCache: facts ? 12000 : 6000,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 100, text: 100, reasoning: 0 },
            },
          },
        ]
        return {
          stream: new ReadableStream({
            start(controller) {
              chunks.forEach((part) => controller.enqueue(part))
              controller.close()
            },
          }),
        }
      },
    },
    limits: { contextTokens: 65536, inputTokens: 32768, outputTokens: 8192 },
  })
  const shared = {
    id: standard.id,
    nativeTools: true,
    limits: standard.limits,
    estimate: (request) => standard.estimate(request),
    stream(request, signal) {
      activeRequest = request
      return standard.stream(request, signal)
    },
  }
  const f = await setupTool(t, shared, shared)
  await runTool(f, original)
  const state = await f.storage.load('root')
  const record = state.records.findLast((item) => item.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  t.diagnostic(
    JSON.stringify({ mainCalls, maintenanceCalls, firstInputChars, originalChars: original.length })
  )
  assert.equal(outcome.status, 'applied', outcome.error)
  assert.equal(mainCalls, 2)
  assert.equal(maintenanceCalls, 1)
})

test('native maintenance preserves large accepted evidence through the next request and publishes a grounded patch', async (t) => {
  const original = 'Review all source batches and preserve every original constraint. '.repeat(90)
  let previous
  let calls = 0
  const maintenance = {
    ...driver(async function* (request) {
      calls++
      const facts = JSON.parse(request.materials[0].text).partitions.runtime.modelTool
      const input = facts.inputs.find((item) => item.text === original)
      assert(input, 'the audit frame keeps the complete original')
      const sent = modelRequestEncoder.messages(request).map(({ role, content }) => ({
        role,
        content,
      }))
      const visible = sent.map((message) => message.content).join('\n')
      assert.equal(visible.split(original).length, 2, 'the actual model request contains it once')
      if (previous) {
        assert.deepEqual(sent.slice(0, previous.length), previous)
        assert(!request.compiledPrompt.includes(original))
        assert.match(request.compiledPrompt, /bodyInEarlierFrame/)
      }
      previous = sent
      const candidate = {
        baseRevision: facts.baseRevision,
        summary: 'Kept the supplied constraints and the pending review.',
        unresolved: ['Review source batches'],
        inputs: [
          {
            ref: input.ref,
            baseRevision: 0,
            summary: 'Review all source batches',
            constraints: ['Preserve every original constraint'],
            unresolved: ['Review source batches'],
          },
        ],
      }
      yield {
        type: 'tool-call',
        value: {
          id: `retained-material-${calls}`,
          name: 'exec',
          input: {
            code:
              calls === 1
                ? "console.log('Verified the supplied original constraints.');"
                : `import {submit} from 'velaros:context-materials';console.log(await submit(${JSON.stringify(candidate)}));`,
          },
        },
      }
      yield finish
    }),
    nativeTools: true,
  }
  const f = await setupTool(t, driver(done), maintenance)
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'Preserve original constraints'});",
  })
  await runTool(f, original)
  const state = await f.storage.load('root')
  const record = state.records.findLast((item) => item.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(outcome.status, 'applied', outcome.error)
  assert.equal(calls, 2)
})

test('native maintenance locally sizes its initial evidence using the standard provider estimate', async (t) => {
  const original = 'Review every batch and preserve each original constraint. '.repeat(40)
  const estimator = createAiSdkModelDriver({
    id: 'offline-sizing',
    model: {
      specificationVersion: 'v3',
      provider: 'openai.responses',
      modelId: 'offline-sizing',
      supportedUrls: {},
    },
    limits: { contextTokens: 65536, inputTokens: 32768, outputTokens: 8192 },
  })
  let calls = 0
  let estimates = 0
  let firstInputChars = 0
  const maintenance = {
    id: estimator.id,
    nativeTools: true,
    limits: estimator.limits,
    estimate: async (request) => {
      estimates++
      return estimator.estimate(request)
    },
    async *stream(request) {
      calls++
      const facts = JSON.parse(request.materials[0].text).partitions.runtime.modelTool
      const input = facts.inputs.find((item) => item.text.startsWith('Review every batch'))
      firstInputChars = input?.text.length ?? 0
      assert.equal(
        input?.text.length,
        original.length,
        'the complete original fits in the locally resized first request'
      )
      assert.equal(input?.text, original)
      assert.equal(request.contextStatus.phase, 'work')
      assert((await estimator.estimate(request)).tokens <= 32768)
      const candidate = {
        baseRevision: facts.baseRevision,
        summary: 'Preserved the complete input.',
        unresolved: [],
        inputs: [
          {
            ref: input.ref,
            baseRevision: 0,
            summary: 'Review every batch',
            constraints: ['Preserve each original constraint'],
            unresolved: [],
          },
        ],
      }
      yield {
        type: 'tool-call',
        value: {
          id: 'sized-delivery',
          name: 'exec',
          input: {
            code: `import {submit} from 'velaros:context-materials'; console.log(await submit(${JSON.stringify(candidate)}));`,
          },
        },
      }
      yield finish
    },
  }
  const f = await setupTool(t, driver(done), maintenance)
  await f.session.context.append({
    kind: 'assistant',
    body: 'Observed the imported batch; verification remains pending. '.repeat(800),
  })
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system'; await memory.organize({focus:'Preserve verified progress'});",
  })
  await runTool(f, original)
  const state = await f.storage.load('root')
  const record = state.records.findLast((item) => item.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(outcome.status, 'applied', outcome.error)
  assert.equal(calls, 1)
  t.diagnostic(
    JSON.stringify({
      modelCalls: calls,
      localEstimates: estimates,
      firstInputChars,
      originalChars: original.length,
    })
  )
})

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

test('a frame exceeding capacity delegates to maintenance before the first business request and preserves native user images', async (t) => {
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
    // 窗口 90000：95000 确实超窗，本地重组后仍装不下才交给整理支线。
    async (request) => ({
      tokens: JSON.stringify(request).includes('model-interpretation') ? 1000 : 95000,
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

test('fitting large notes permit successful business turns without paid pressure maintenance', async (t) => {
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
  assert.equal(toolCalls, 0)
  const state = await f.storage.load('root')
  assert.equal(state.records.filter((r) => r.title === 'workspace:note:large').length, 1)
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
      assert.match(request.instructions, /index.json/)
      if (calls === 1) {
        yield execute(request, "import {modules} from 'velaros:system';await modules.list({});")
        yield finish
      } else if (calls === 2) {
        assert.match(JSON.stringify(request), /velaros:system|PERMISSION/)
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
  const denied = await f.session.execute({
    source: "import {list} from 'velaros:context-materials';await list({});",
  })
  assert(denied.result.failed)
  assert.match(denied.result.process.stderr, /velaros:context-materials/)
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
    {
      context: {
        sources: [],
        maintenance: { execution: 'script', model: maintenance, profile: { modelCalls: 2 } },
      },
    }
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
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system';await memory.organize({focus:'Review the available evidence'});",
  })
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
  const card = baseText(projected)
    .split('\n')
    .find((line) => line.includes('"key":"progress"'))
  assert.equal(JSON.parse(card).representation, 'summary')
  assert.match(baseText(projected), /Short derived presentation/)
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
          text: `${execute(request, "import {memory} from 'velaros:system';await memory.organize({focus:'Verify next steps'});").text}\n${request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)[1]} done`,
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
  const unknownField = await f.session.execute({
    source: "import {memory} from 'velaros:system';await memory.organize({targetChars:1});",
  })
  assert.match(unknownField.result.failed.message, /多了不认识的字段 targetChars/)
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
      tokens: pressure && !relieved ? 95000 : 1000,
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
    // 形状合法、状态不符：由补丁校验在同一支线里报出来
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
  const outcome = JSON.parse(await f.storage.get('root', outcomes[0].objectId))
  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.error, null, 'a repaired intermediate error is not a terminal failure')
})

test('successful maintenance clears a recovered protocol error from its terminal outcome', async (t) => {
  let calls = 0
  const f = await setupTool(
    t,
    driver(done),
    driver(async function* (request) {
      if (++calls === 1) {
        yield { type: 'text', text: 'I will organize the provided evidence.' }
        yield finish
      } else yield* deliverPatch(request)
    })
  )
  await f.session.execute({
    source:
      "import {memory} from 'velaros:system'; await memory.organize({focus:'Preserve the goal'});",
  })
  await runTool(f)
  assert.equal(calls, 2)
  const state = await f.storage.load('root')
  const record = state.records.findLast((record) => record.title === 'context-maintenance:outcome')
  const outcome = JSON.parse(await f.storage.get('root', record.objectId))
  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.error, null)
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

test('maintenance input preloading uses its own reading budget when the parent target is small', async (t) => {
  const f = await fixture(t)
  const original = `${'Review the implementation. '.repeat(150)}Preserve the final condition.`
  const input = await f.session.context.append({ kind: 'user', body: original })
  await f.session.view.end('completed')
  await f.session.view.begin(input.ref)
  const snapshot = await f.state.snapshot(8000, signal)
  const material = f.state.material(snapshot, 8000)
  assert.equal(material.inputs.find((item) => item.ref.id === input.ref.id)?.text, original)
  f.state.acknowledge(snapshot, material)
  await f.state.validate(
    snapshot,
    patch(snapshot, {
      active: {
        baseRevision: snapshot.active.revision,
        reviewedInput: input.ref,
        changes: [],
      },
    }),
    signal
  )
})

test('small maintenance facts advance acknowledged input ranges and identify the remaining page', async (t) => {
  const f = await fixture(t)
  const original = `${'Data "quoted"\\with\\slashes 中文. '.repeat(60)}Final condition.`
  const input = await f.session.context.append({ kind: 'user', body: original })
  await f.session.view.end('completed')
  await f.session.view.begin(input.ref)
  const snapshot = await f.state.snapshot(8000, signal)
  const collected = []
  for (let turn = 0; turn < 16; turn++) {
    const material = f.state.material(snapshot, 750)
    assert(JSON.stringify(material).length <= 750)
    assert.deepEqual(f.state.material(snapshot, 750), material)
    const page = material.inputs.find((item) => item.ref.id === input.ref.id)
    assert(page)
    assert.equal(page.offset, collected.join('').length)
    assert.equal(page.text, original.slice(page.offset, page.offset + page.text.length))
    assert.equal(
      page.nextOffset,
      page.offset + page.text.length < original.length ? page.offset + page.text.length : null
    )
    collected.push(page.text)
    f.state.acknowledge(snapshot, material)
    if (page.nextOffset === null) break
  }
  assert.equal(collected.join(''), original)
  await f.state.validate(
    snapshot,
    patch(snapshot, {
      inputs: [
        {
          ref: input.ref,
          baseRevision: 0,
          summary: 'Data reviewed',
          constraints: [],
          unresolved: [],
        },
      ],
    }),
    signal
  )
})

test('overlapping recalled pages share one fact range and preserve complete input and recent evidence', async (t) => {
  const f = await fixture(t)
  const original = 'Review "quoted" paths\\and 中文 🧪. '.repeat(90)
  const observed = 'Observed output: 中文 "result" with exact spacing. '.repeat(60)
  const input = await f.session.context.append({ kind: 'user', body: original })
  await f.session.view.end('completed')
  await f.session.view.begin(input.ref)
  const recent = await f.session.context.append({ kind: 'assistant', body: observed })
  const snapshot = await f.state.snapshot(8000, signal)
  for (const ref of [input.ref, recent.ref]) {
    await f.state.read(snapshot, ref, 300, 900, signal)
    await f.state.read(snapshot, ref, 600, 900, signal)
  }
  const candidate = patch(snapshot, {
    inputs: [
      { ref: input.ref, baseRevision: 0, summary: 'Reviewed', constraints: [], unresolved: [] },
    ],
  })
  await assert.rejects(f.state.validate(snapshot, candidate, signal), {
    code: 'CONTEXT_INPUT_UNSEEN',
  })
  const assertRanges = (material) => {
    for (const [items, ref, text] of [
      [material.inputs, input.ref, original],
      [material.recent, recent.ref, observed],
    ]) {
      const pages = items
        .filter((item) => item.ref.id === ref.id)
        .sort((a, b) => a.offset - b.offset)
      for (const [index, page] of pages.entries()) {
        assert.equal(page.text, text.slice(page.offset, page.offset + page.text.length))
        if (index)
          assert(
            pages[index - 1].offset + pages[index - 1].text.length <= page.offset,
            'fact pages must not repeat source ranges'
          )
      }
      assert.equal(pages.map((page) => page.text).join(''), text)
    }
  }
  const material = f.state.material(snapshot, 16000)
  assert(JSON.stringify(material).length <= 16000)
  assert.deepEqual(f.state.material(snapshot, 16000), material)
  assertRanges(material)
  f.state.acknowledge(snapshot, material)
  await f.state.validate(snapshot, candidate, signal)
  // 全部送达后的常驻回显也必须去重；编译不能改变范围确认。
  assertRanges(f.state.material(snapshot, 16000))
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
