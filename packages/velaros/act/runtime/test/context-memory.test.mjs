import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { memoryPrompt } from '../../../dist/act/runtime/utils/context-memory.js'

import { baseNotes, done, historyEntries, marker, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal

test('INV-35 model receipt grouping preserves full raw decisions and every failure or world effect', () => {
  const reads = Array.from({ length: 80 }, (_, index) => ({
    id: `run:${index}`,
    executionId: 'run',
    operation: 'materials.read',
    outcome: 'succeeded',
    effect: 'none',
  }))
  const unsafe = [
    {
      id: 'write',
      executionId: 'run',
      operation: 'files.write',
      outcome: 'succeeded',
      effect: 'committed',
    },
    {
      id: 'unknown',
      executionId: 'run',
      operation: 'shell.run',
      outcome: 'failed',
      effect: 'unknown',
    },
    {
      id: 'denied',
      executionId: 'run',
      operation: 'materials.read',
      outcome: 'failed',
      effect: 'none',
    },
  ]
  const frame = {
    partitions: {
      task: {},
      workspace: { notes: [] },
      observation: {},
      recent: { history: [], results: [] },
      runtime: {
        mandatory: [...reads, ...unsafe],
        decision: {
          frameId: 'frame',
          unverified: reads.map((item) => ({
            invocationId: item.id,
            moduleId: 'materials',
            operation: 'read',
          })),
        },
      },
    },
    memoryStatus: {},
  }
  const before = structuredClone(frame)
  const prompt = memoryPrompt(JSON.stringify(frame))
  assert.deepEqual(frame, before)
  assert.equal(frame.partitions.runtime.mandatory.length, 83)
  assert.match(prompt, /"count": 80/)
  assert.match(prompt, /"firstId": "run:0"/)
  assert.match(prompt, /"lastId": "run:79"/)
  for (const item of unsafe) {
    assert(prompt.includes(`"id": "${item.id}"`))
    assert(prompt.includes(`"effect": "${item.effect}"`))
  }
  assert(prompt.indexOf('"firstId": "run:0"') < prompt.indexOf('"id": "write"'))
  assert(!prompt.includes('run:40'))
  assert(prompt.length < JSON.stringify(frame).length / 3)
})
async function fixture(
  t,
  stream = async function* (request) {
    yield* done(request)
  },
  options = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'context-memory-'))
  const storage = localContextStorage({ path: join(root, 'context.sqlite') })
  const requests = []
  const model = {
    id: 'memory-test',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      requests.push(request)
      yield* stream(request, requests.length)
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    modules: [],
    limits: {
      turns: 12,
      outputTokens: 2048,
      safetyTokens: 1024,
      projectionChars: 24000,
      recoveryChars: 6000,
      timeoutMs: 20000,
    },
    ...options,
  })
  const session = await runtime.openSession('s')
  await session.context.append({ kind: 'user', body: 'Investigate without losing progress' })
  const programs = new ProgramContext('s', session.context, storage)
  const memory = new ContextMemory(
    's',
    session.context,
    storage,
    session.view,
    programs,
    new RecentContext('s', session.context, storage),
    options.context?.memory
  )
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return { runtime, session, storage, memory, requests, root }
}
async function execute(f, source) {
  const result = await f.session.execute({ source })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  return result.result.value?.default
}
async function run(f) {
  const events = []
  for await (const event of f.session.submit('Continue')) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  return events
}

test('INV-36 the latest script diagnostic survives body omission and clears after a repaired execution', async (t) => {
  const f = await fixture(
    t,
    async function* (request, call) {
      const frame = JSON.parse(request.materials[0].text)
      if (call === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {modules} from 'velaros:system';import {output} from 'velaros';const page=await modules.list();output(page.modules);",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (call === 2) {
        assert(!frame.partitions.recent.results.at(-1).text.includes("Property 'modules'"))
        const feedback = frame.partitions.runtime.progress.feedback
        assert.equal(feedback.failure.code, 'SCRIPT_CHECK')
        assert(feedback.failure.draftRef)
        assert.equal(feedback.ref, frame.partitions.recent.results.at(-1).ref)
        assert.match(request.compiledPrompt, /Property 'modules' does not exist/)
        assert(JSON.stringify(feedback).length < 3000)
        yield turn(request, {
          execute: {
            source:
              "import {modules} from 'velaros:system';import {output} from 'velaros';const page=await modules.list();output(page.items.length);",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(frame.partitions.runtime.progress.feedback, undefined)
        yield* done(request)
      }
    },
    {
      limits: {
        turns: 4,
        outputTokens: 2048,
        safetyTokens: 1024,
        projectionChars: 6000,
        recoveryChars: 3000,
        timeoutMs: 20000,
      },
      context: { sources: [], memory: { recentRecords: 0 } },
    }
  )
  await run(f)
  assert.equal(f.requests.length, 3)
})

// 直接检查真实帧而非旧测试的语义字段适配器。
test('INV-18 one partitioned frame carries current observation, persistent notes, recent results and runtime status', async (t) => {
  const f = await fixture(t, async function* (request, call) {
    if (call === 1) {
      yield turn(request, {
        execute: {
          source:
            "import {memory as memoryApi} from 'velaros:system';const {update}=memoryApi;const note=await update({key:'auth',baseRevision:0,body:'Cache restoration remains unverified'});if(note.revision!==1)throw new Error('revision');",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  await f.session.observe({ source: "import {output} from 'velaros';output({version:2});" })
  await run(f)
  const frame = JSON.parse(f.requests[1].materials[0].text)
  assert.deepEqual(Object.keys(frame.partitions), [
    'task',
    'workspace',
    'observation',
    'recent',
    'runtime',
  ])
  assert.equal(frame.goals, undefined)
  assert.equal(frame.results, undefined)
  assert.equal(f.requests[1].contextStatus.mode, 'partitioned')
  assert.equal(frame.partitions.workspace.notes[0].text, 'Cache restoration remains unverified')
  assert.equal(frame.partitions.workspace.notes[0].origin, 'model-note')
  assert.match(frame.partitions.observation.text, /version/)
  assert(frame.partitions.recent.results.length)
  assert(frame.memoryStatus.changes.added.includes('workspace:auth'))
  assert(Object.values(frame.memoryStatus.footprint).every(Number.isSafeInteger))
})

test('INV-19 workspace revisions survive reopening, compare-and-swap conflicts never overwrite, and old versions remain readable', async (t) => {
  const f = await fixture(t)
  const first = await f.memory.update({ key: 'progress', baseRevision: 0, body: 'one' }, signal)
  const updates = await Promise.allSettled([
    f.memory.update({ key: 'progress', baseRevision: 1, body: 'two' }, signal),
    f.memory.update({ key: 'progress', baseRevision: 1, body: 'other' }, signal),
  ])
  assert.equal(updates.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(updates.find((item) => item.status === 'rejected').reason.code, 'WORKSPACE_CONFLICT')
  assert.equal(JSON.parse((await f.memory.read(first.ref, 0, 60000, signal)).text).body, 'one')
  await f.runtime.close()
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(f.root, 'context.sqlite') }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
  })
  try {
    const session = await runtime.openSession('s')
    const result = await session.execute({
      source:
        "import {memory as memoryApi} from 'velaros:system';const {list}=memoryApi;import {output} from 'velaros';output(await list({kind:'notes'}));",
    })
    assert(!result.result.failed, JSON.stringify(result))
    assert.equal(result.result.value.default.items[0].revision, 2)
  } finally {
    await runtime.close()
  }
})

test('eviction removes only residency, remount preserves exact archived note and frame changes track it', async (t) => {
  const f = await fixture(t)
  await execute(
    f,
    "import {memory as memoryApi} from 'velaros:system';const {update}=memoryApi;await update({key:'plan',baseRevision:0,body:'next read cache'});"
  )
  await run(f)
  await execute(
    f,
    "import {memory as memoryApi} from 'velaros:system';const {update}=memoryApi;await update({key:'plan',baseRevision:1,resident:false});"
  )
  await run(f)
  const frame = JSON.parse(f.requests[1].materials[0].text)
  assert.equal(frame.partitions.workspace.notes.length, 0)
  assert(frame.memoryStatus.changes.exited.includes('workspace:plan'))
  const item = (await f.memory.list({}, signal)).items[0]
  assert.equal(item.resident, false)
  assert.equal(
    JSON.parse((await f.memory.read(item.ref, 0, 60000, signal)).text).body,
    'next read cache'
  )
  await execute(
    f,
    "import {memory as memoryApi} from 'velaros:system';const {update}=memoryApi;await update({key:'plan',baseRevision:2,resident:true});"
  )
  await run(f)
  assert.equal(
    JSON.parse(f.requests[2].materials[0].text).partitions.workspace.notes[0].text,
    'next read cache'
  )
})

test('observation cannot mutate a workspace through aliases or wrappers', async (t) => {
  const f = await fixture(t)
  await f.session.observe({
    source:
      "import {memory as memoryApi} from 'velaros:system';const {update:edit}=memoryApi;await edit({key:'bad',baseRevision:0,body:'repeat'});",
  })
  await run(f)
  assert.equal((await f.memory.list({}, signal)).items.length, 0)
  assert.match(f.requests[0].materials[0].text, /OPERATION_MODE_DENIED/)
})

test('oversized notes become honest reference cards and can be recalled without auto-residency changes', async (t) => {
  const f = await fixture(t)
  const original = 'long-note-'.repeat(6000)
  const entry = await f.memory.update({ key: 'large', baseRevision: 0, body: original }, signal)
  await run(f)
  // 段起点的驻留笔记在段底座里；放不下正文的只给引用卡
  const note = baseNotes(f.requests[0]).find((item) => item.key === 'large')
  assert.equal(note.representation, 'reference')
  assert.equal(note.bodyIncluded, false)
  assert.equal(note.chars, original.length)
  let raw = ''
  for (let offset = 0; ; offset = raw.length) {
    const content = await f.memory.read(entry.ref, offset, 60000, signal)
    raw += content.text
    if (raw.length === content.totalChars) break
  }
  assert.equal(JSON.parse(raw).body, original)
  assert.equal((await f.memory.list({}, signal)).items[0].revision, 1)
})

test('workspace sources and history reset enforce the same current authorization generation', async (t) => {
  const f = await fixture(t)
  const source = await f.session.context.append({ kind: 'note', body: 'private source' })
  const note = await f.memory.update(
    { key: 'private', baseRevision: 0, body: 'derived private summary', sources: [source.ref] },
    signal
  )
  await assert.rejects(
    f.memory.update(
      {
        key: 'foreign',
        baseRevision: 0,
        body: 'bad',
        sources: [{ sessionId: 'other', id: source.ref.id }],
      },
      signal
    ),
    { code: 'SCOPE_MISMATCH' }
  )
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'authorization changed',
  })
  assert.equal((await f.memory.list({}, signal)).items.length, 0)
  await assert.rejects(f.memory.read(note.ref, 0, 100, signal), { code: 'SCOPE_MISMATCH' })
  await assert.rejects(
    f.memory.update(
      { key: 'private', baseRevision: 0, body: 'try old sources', sources: [source.ref] },
      signal
    ),
    { code: 'SCOPE_MISMATCH' }
  )
})

test('one result body is sent once across partition rendering and chronological history', async (t) => {
  const f = await fixture(t, async function* (request, call) {
    if (call === 1) {
      yield turn(request, {
        execute: {
          source: "import {output} from 'velaros';output(['unique','material','body'].join('-'));",
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  await run(f)
  const request = f.requests[1]
  const messages = modelRequestEncoder.messages(request)
  const text = messages
    .map((item) => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)))
    .join('\n')
  assert.equal(text.split('unique-material-body').length - 1, 1)
  const frame = JSON.parse(request.materials[0].text)
  assert(frame.partitions.recent.results[0].bodyInHistory)
  assert.equal(frame.partitions.recent.results[0].text, undefined)
  const entries = historyEntries(request)
  assert(entries.some((item) => item.origin === 'assistant-script'))
  assert.equal(
    entries.filter((item) => item.origin === 'runtime-execution' && item.bodyIncluded).length,
    1
  )
  assert.equal(frame.partitions.recent.historyState.records, entries.length)
})

test('zero history window still sends leased results and notes through the same five partitions', async (t) => {
  const f = await fixture(t, undefined, { context: { sources: [], memory: { recentRecords: 0 } } })
  await execute(f, "import {output} from 'velaros';output('leased result');")
  await f.memory.update(
    { key: 'note', baseRevision: 0, body: 'persistent reasoning summary' },
    signal
  )
  await run(f)
  const frame = JSON.parse(f.requests[0].materials[0].text)
  assert.equal(frame.partitions.recent.historyState.records, 0)
  assert.match(frame.partitions.recent.results[0].text, /leased result/)
  // 不发送有序历史时，段底座仍是第一条消息，笔记快照在里面
  assert.equal(f.requests[0].history.length, 1)
  assert.match(f.requests[0].history[0].content, /persistent reasoning summary/)
})

test('host memory policy rejects invalid capacities before a model request', async () => {
  for (const memory of [
    { recentRecords: 65 },
    { workspaceShare: NaN },
    { workspaceShare: 0.5, recentShare: 0.5 },
  ]) {
    const runtime = await createRuntime({
      storage: localContextStorage({ path: ':memory:' }),
      runner: nodeSubprocessCodeRunner,
      modules: [],
      context: { sources: [], memory },
    })
    try {
      await assert.rejects(runtime.openSession('invalid'), /分区配置/)
    } finally {
      await runtime.close()
    }
  }
})

test('INV-20 independent capacity maintenance derives parent note presentation without replaying business or observation scripts', async (t) => {
  let toolCalls = 0
  const maintenance = {
    id: 'maintenance',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      toolCalls++
      const snapshot = JSON.parse(
        JSON.parse(request.materials[0].text).partitions.task.goals[0].text
      ).snapshot
      const patch = {
        baseRevision: snapshot.baseRevision,
        summary: 'Preserved progress',
        unresolved: [],
        notes: [{ ref: note.ref, summary: 'Maintenance preserved progress' }],
      }
      const part = turn(request, {
        execute: {
          source: `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(patch)}));`,
        },
      })
      yield { ...part, text: `${part.text}\n${marker(request)} done` }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const f = await fixture(
    t,
    async function* (request, call) {
      if (call === 1) {
        yield { type: 'error', code: 'context-limit', message: 'capacity exceeded' }
        return
      }
      assert.equal(request.mode, 'work')
      yield* done(request)
    },
    { context: { sources: [], maintenance: { model: maintenance } } }
  )
  const note = await f.memory.update(
    { key: 'progress', baseRevision: 0, body: 'Original main-model progress' },
    signal
  )
  await f.session.observe({
    source: "import {output} from 'velaros';output('current observation');",
  })
  await run(f)
  assert.equal(
    JSON.parse((await f.memory.read(note.ref, 0, 60000, signal)).text).body,
    'Original main-model progress'
  )
  assert.equal(f.requests.length, 2)
  assert.equal(toolCalls, 1)
  // 派生展示换了投影策略，下一帧重建底座，笔记快照换成整理后的展示
  assert.match(f.requests[1].history[0].content, /Maintenance preserved progress/)
  assert.doesNotMatch(f.requests[1].history[0].content, /Original main-model progress/)
  const state = await f.storage.load('s')
  const results = await Promise.all(
    state.records
      .filter((item) => /^script:[0-9a-f-]+:result$/u.test(item.title))
      .map(async (item) => JSON.parse(await f.storage.get('s', item.objectId)))
  )
  assert.equal(results.filter((item) => item.mode === 'observe').length, 1)
  assert.equal(results.filter((item) => item.mode === 'execute').length, 0)
})

test('business children always own a scoped workspace even without world capabilities', async (t) => {
  let children = 0
  const child = {
    id: 'child',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      children++
      if (children === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {memory as memoryApi} from 'velaros:system';const {update}=memoryApi;await update({key:'child-plan',baseRevision:0,body:'local progress'});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.equal(
          JSON.parse(request.materials[0].text).partitions.workspace.notes[0].text,
          'local progress'
        )
        yield* done(request)
      }
    },
  }
  const f = await fixture(
    t,
    async function* (request, call) {
      if (call === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {start,wait} from 'velaros:agents';const child=await start({task:'Investigate',profile:'reader'});await wait({id:child.id});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    },
    {
      agents: {
        profiles: { reader: { model: child, modules: [] } },
        concurrency: 1,
        maxChildren: 1,
      },
    }
  )
  await run(f)
  assert.equal(children, 2)
  assert.equal((await f.memory.list({}, signal)).items.length, 0)
  const frame = JSON.parse(f.requests[1].materials[0].text)
  assert.equal(frame.partitions.runtime.children[0].status, 'completed')
})

test('workspace directory and recovery cards stay bounded even when many notes are resident', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 20; index++)
    await f.memory.update(
      { key: `note-${String(index).padStart(2, '0')}`, baseRevision: 0, body: 'x'.repeat(1000) },
      signal
    )
  await run(f)
  const frame = JSON.parse(f.requests[0].materials[0].text)
  assert.equal(baseNotes(f.requests[0]).length, 4)
  assert.match(f.requests[0].history[0].content, /另有 16 份驻留笔记没有列出/)
  assert.deepEqual(
    { ...frame.partitions.workspace.snapshot, sourcesChanged: undefined },
    { notes: 20, shown: 4, omitted: 16, sourcesChanged: undefined }
  )
  assert.deepEqual(frame.partitions.workspace.notes, [])
  const found = []
  let after
  do {
    const page = await f.memory.list({ after, limit: 3 }, signal)
    found.push(...page.items)
    after = page.nextAfter
  } while (after !== null)
  assert.equal(found.length, 20)
  assert(found.every((item) => item.ref.id && !Object.hasOwn(item, 'body')))
})

test('INV-50 folding seals older history into a listed volume and the next segment re-delivers kept records and leased results', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const memory = new ContextMemory(
    's',
    f.session.context,
    f.storage,
    f.session.view,
    programs,
    recent
  )
  const view = {
    id: 'frame',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const leased = await archiveResult(f, programs, 'kept for the task')
  const responses = []
  for (let index = 0; index < 6; index++) {
    // 响应里写着源码，保留下来的结果就不再重复附上
    responses.push(
      await f.session.context.append({
        kind: 'assistant',
        body: `step ${index} done\n@@sX execute()\noutput(1)\n@@sX`,
      })
    )
    await archiveResult(f, programs, `result-${index}`)
  }
  const first = await memory.project(view, undefined, [], signal, 24000)
  assert.equal(first.segment.index, 1)
  assert(await memory.fold('runway', 24000, signal))
  const [volume] = await recent.volumes(signal)
  assert.equal(volume.volume.turns, 2)
  const next = await memory.project(view, undefined, [], signal, 24000)
  assert.equal(next.segment.index, 2)
  assert.match(next.history[0].content, /卷目录/)
  assert.match(next.history[0].content, /step 0 done/)
  const entries = historyEntries(next)
  // 切点之前、租约仍有效的结果排在新段最前面；最近两个响应及其结果原样重新交付
  assert.equal(entries[0].ref.id, leased.id)
  assert.match(entries[0].text, /kept for the task/)
  assert.deepEqual(
    entries.filter((item) => item.origin === 'assistant-script').map((item) => item.ref.id),
    responses.slice(2).map((record) => record.ref.id)
  )
  // 延续结果附当次源码：产生它的那条响应已经封进卷；其余结果的源码就在前一条响应里
  assert.match(next.history[1].content, /当次源码/)
  assert.doesNotMatch(next.history.at(-1).content, /当次源码/)
  assert.equal(next.history.at(-1).cacheBreakpoint, true)
  assert.equal(await memory.fold('runway', 24000, signal), false)
})

async function archiveResult(f, programs, label) {
  const id = crypto.randomUUID()
  const source = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}`,
    body: JSON.stringify({ source: 'output(1)' }),
  })
  const result = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}:result`,
    body: JSON.stringify({ mode: 'execute', value: label }),
    sources: [source.ref],
  })
  await programs.add(result.ref, source.ref, id, 'task')
  return result.ref
}

test('INV-21 capacity-omitted results do not turn done into an endless refresh loop', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  for (let index = 0; index < 40; index++) await archiveResult(f, programs, `result-${index}`)
  await run(f)
  assert.equal(f.requests.length, 1)
  const frame = JSON.parse(f.requests[0].materials[0].text)
  assert(frame.partitions.runtime.materialStatus.omittedLeaseCount > 0)
  assert.equal(frame.partitions.runtime.programFrame.resultsRevision, 40)
})

test('results added while a frame is in flight force a fresh frame before done', async (t) => {
  const f = await fixture(t, async function* (request, call) {
    if (call === 1) await archiveResult(f, programs, 'late result')
    yield* done(request)
  })
  const programs = new ProgramContext('s', f.session.context, f.storage)
  await run(f)
  assert.equal(f.requests.length, 2)
  const first = JSON.parse(f.requests[0].materials[0].text)
  const second = JSON.parse(f.requests[1].materials[0].text)
  assert.equal(first.partitions.runtime.programFrame.resultsRevision, 0)
  assert.equal(second.partitions.runtime.programFrame.resultsRevision, 1)
  assert.match(JSON.stringify(f.requests[1].history), /late result/)
})

test('model history renders selected code literally while retaining the structured audit frame', async (t) => {
  const template =
    'async function inspect(path) {\n  return read({files:[{path}]});\n}\nconst literal = "\\n";'
  const f = await fixture(t, async function* (request, call) {
    if (call === 1) {
      yield turn(request, {
        execute: {
          source: `import {output} from 'velaros';output(${JSON.stringify(template)},{key:'usage',type:'code'});`,
        },
      })
      yield { type: 'finish', reason: 'stop' }
    } else yield* done(request)
  })
  await run(f)
  const request = f.requests[1]
  const visible = request.history.find(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.includes(template)
  )
  assert(visible, 'the actual model message contains literal multiline code')
  const header = JSON.parse(visible.content.slice(0, visible.content.indexOf('\n')))
  assert.equal(header.origin, 'runtime-execution')
  assert(header.ref.id)
  assert(visible.content.includes('"representation":"full"'))
  // 结构化原值留在结果归档里，模型看到的是逐字代码
  const archived = JSON.parse((await f.session.context.read(header.ref)).text)
  assert.equal(archived.output.blocks[0].value, template)
  // 模型看到的输出是逐字代码，没有再包一层字符串转义
  const output = visible.content.slice(visible.content.indexOf('当次输出：'))
  assert(output.includes(template))
  assert(!output.includes(JSON.stringify(template).slice(1, -1)))
})

test('zero-history results and current observation render code without extra string escaping', async (t) => {
  const observed = 'function current() {\n  return "当前";\n}'
  const result = 'function receipt() {\n  return "\\n";\n}'
  const f = await fixture(t, undefined, { context: { sources: [], memory: { recentRecords: 0 } } })
  await f.session.observe({
    source: `import {output} from 'velaros';output(${JSON.stringify(observed)},{key:'observe-code',type:'code'});`,
  })
  await execute(
    f,
    `import {output} from 'velaros';output(${JSON.stringify(result)},{key:'result-code',type:'code'});`
  )
  await run(f)
  const request = f.requests[0]
  assert(request.compiledPrompt.includes(observed))
  assert(request.compiledPrompt.includes(result))
  assert.equal(request.history.length, 1)
  assert.match(request.history[0].content, /runtime-segment-base/)
  const frame = JSON.parse(request.materials[0].text)
  assert.equal(JSON.parse(frame.partitions.observation.text).blocks[0].text, observed)
  assert(frame.partitions.runtime.decision.sources.includes(frame.partitions.observation.resultRef))
})
