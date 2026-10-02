import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { ActRuntimeTuning } from '../../../dist/act/runtime/utils/tuning.js'

import { modelText } from './support/model-turn.mjs'
import { runtimeFrame } from './support/model-turn.mjs'
import { done, marker, turn } from './support/model-turn.mjs'

/** 段状态的最小形态：第 1 段，还没有冻结条目。 */
function segment(overrides = {}) {
  return {
    id: 'segment-1',
    index: 1,
    revision: 0,
    from: 0,
    base: { objectId: 'base', chars: 0 },
    carried: [],
    notes: [],
    entries: [],
    objective: '',
    goals: 0,
    policy: null,
    volumes: 0,
    reason: 'start',
    narrate: null,
    ...overrides,
  }
}
const block = (request, source) => `${marker(request)} execute()\n${source}\n${marker(request)}`
async function fixture(t, handler, extra = {}, driver = {}) {
  const root = await mkdtemp(join(tmpdir(), 'context-management-'))
  const storage = localContextStorage({ path: join(root, 'state.sqlite') })
  const f = { storage, frames: [], calls: 0 }
  const model = {
    id: 'context-test',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    ...driver,
    async *stream(request) {
      f.frames.push(request)
      f.calls++
      yield* handler(request, f)
    },
  }
  const runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    model,
    ...extra,
  })
  const session = await runtime.openSession('s')
  Object.assign(f, {
    runtime,
    session,
    programs: new ProgramContext('s', session.context, storage),
  })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}
async function run(f, input) {
  const events = []
  for await (const event of f.session.submit(input)) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  return events
}

test('long user text is archived, summarized after intent extraction, and recoverable exactly', async (t) => {
  const original = `请保留所有图片。${'一些重复的背景说明。'.repeat(50000)}最后要求：只调查，不改文件。`
  const seen = []
  const maintenance = {
    id: 'input-organizer',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      const frame = JSON.parse(request.materials[0].text)
      const snapshot = JSON.parse(frame.partitions.task.goals[0].text).snapshot
      for (const page of frame.partitions.runtime.modelTool.inputs) {
        assert.equal(page.text, original.slice(page.offset, page.offset + page.text.length))
        seen.push({ start: page.offset, end: page.offset + page.text.length })
      }
      let through = 0
      for (const range of seen.toSorted((a, b) => a.start - b.start)) {
        if (range.start > through) break
        through = Math.max(through, range.end)
      }
      if (through < original.length) {
        yield {
          type: 'text',
          text: block(
            request,
            `import {read} from 'velaros:context-materials';await read({ref:${JSON.stringify(snapshot.goals[0])},offset:${through},limit:12000});`
          ),
        }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const patch = {
        baseRevision: snapshot.baseRevision,
        summary: '理解用户意图',
        unresolved: [],
        inputs: [
          {
            ref: snapshot.goals[0],
            summary: '调查环境',
            constraints: ['保留图片', '只调查，不改文件'],
            unresolved: [],
            baseRevision: 0,
          },
        ],
      }
      yield {
        type: 'text',
        text: `${block(request, `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify(patch)}));`)}\n${marker(request)} done`,
      }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const f = await fixture(
    t,
    async function* (request, f) {
      const frame = runtimeFrame(request)
      const goal = frame.goals[0]
      assert(request.contextStatus)
      assert.equal(request.contextStatus.mode, 'partitioned')
      if (f.calls === 1) {
        assert(modelText(request).length < original.length)
        assert.match(goal.text, /omittedChars/)
        yield {
          type: 'text',
          text: block(
            request,
            `import {memory} from 'velaros:system';const {read}=memory;const tail=await read({ref:${JSON.stringify(goal.record.ref)},offset:${original.length - 100},limit:100});if(!tail.text.includes('只调查，不改文件'))throw new Error('tail');await memory.organize({focus:'压缩重复背景，保留图片和只调查约束'});`
          ),
        }
        yield { type: 'finish', reason: 'stop' }
      } else {
        assert.match(goal.text, /只调查，不改文件/)
        assert(!modelText(request).includes('一些重复的背景说明。'.repeat(20)))
        yield* done(request)
      }
    },
    { context: { sources: [], maintenance: { model: maintenance, profile: { modelCalls: 64 } } } }
  )
  await run(f, original)
  const ref = (await f.session.view.inspect()).goals[0]
  let restored = ''
  for (let offset = 0; offset < original.length; offset += 60000)
    restored += (await f.session.context.readInput(ref, { offset, limit: 60000 })).text
  assert.equal(restored, original)
  await assert.rejects(
    f.session.context.summarizeInput({
      ref,
      summary: 'stale',
      constraints: [],
      unresolved: [],
      baseRevision: 0,
    }),
    /版本/
  )
})

test('file input is a scoped reference and oversized text chunks preserve the full original', async (t) => {
  const f = await fixture(t, async function* (request) {
    assert.match(modelText(request), /spec.txt/)
    yield* done(request)
  })
  const file = await f.session.context.append({
    kind: 'audit',
    title: 'uploaded-file',
    body: 'file contents',
  })
  await run(f, { files: [{ ref: file.ref, name: 'spec.txt', mediaType: 'text/plain', bytes: 13 }] })
  assert.equal((await f.session.context.readInput(file.ref)).text, 'file contents')
  await assert.rejects(
    f.session.context.ingest({
      files: [
        { ref: { sessionId: 'other', id: file.ref.id }, name: 'file', mediaType: 'text/plain' },
      ],
    }),
    /作用域/
  )
  const raw = `${'a'.repeat(8000000)}尾部`
  const input = await f.session.context.ingest({ text: raw })
  const tail = await f.session.context.readInput(input.ref, { offset: 7999999, limit: 10 })
  assert.equal(tail.text, 'a尾部')
  assert.equal(tail.totalChars, raw.length)
  const archive = await f.session.context.append({ kind: 'audit', body: 'private audit' })
  await assert.rejects(f.session.context.readInput(archive.ref), /不是用户/)
})

test('large output fields become honest references without changing the live JS value', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          "import {output} from 'velaros';const value={count:3,matches:'x'.repeat(20000)};if(value.matches.length!==20000)throw new Error('changed');output(value);"
        ),
      }
      yield { type: 'finish', reason: 'stop' }
    } else {
      const frame = runtimeFrame(request)
      assert(frame.results[0].truncated)
      assert.equal(frame.results[0].representation, 'excerpt')
      assert(frame.results[0].omitted.length)
      assert.match(frame.results[0].text, /count/)
      assert(frame.materialStatus.largest.length)
      yield* done(request)
    }
  })
  await run(f, 'Inspect large result')
  const result = (await f.storage.load('s')).records.find((item) => item.title.endsWith(':result'))
  const saved = JSON.parse(await f.storage.get('s', result.objectId))
  assert.equal(saved.result.value.default.matches.length, 20000)
})

test('task leases survive paused calls, release only visibility, and pure reference frames do not consume finite leases', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  await f.session.context.append({ kind: 'user', body: 'task' })
  const receipt = await f.session.execute(
    { source: "import {output} from 'velaros';output('saved');" },
    'task'
  )
  assert.equal((await f.programs.state()).leases[0].task, true)
  await f.programs.retain(receipt.resultRef, 1)
  const view = (await f.session.view.inspect()).view
  const frame = await f.programs.project(view, undefined, [], new AbortController().signal, 1)
  const data = JSON.parse(frame.body)
  assert.equal(data.results[0].bodyIncluded, false)
  await f.programs.consume(data.programFrame.id, new AbortController().signal)
  assert.equal((await f.programs.state()).leases.length, 1)
  await f.programs.release(receipt.resultRef)
  assert.equal((await f.programs.state()).leases.length, 0)
  assert((await f.programs.read(receipt.resultRef)).text.includes('saved'))
})

test('segment retirement preserves explicit finite and task leases and immutable originals', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  await f.session.context.append({ kind: 'user', body: 'task' })
  const source = { source: "import {output} from 'velaros';output('archived');" }
  const segment = await f.session.execute(source, 'segment')
  const finite = await f.session.execute(source, 4)
  const task = await f.session.execute(source, 'task')
  const recent = await f.session.execute(source, 'segment')
  const reopened = new ProgramContext('s', f.session.context, f.storage)
  assert.equal(
    (await reopened.state()).leases.find((item) => item.ref === segment.resultRef).segment,
    true
  )
  await reopened.endSegment(
    [segment.resultRef, finite.resultRef, task.resultRef],
    new AbortController().signal
  )
  assert.deepEqual(
    (await reopened.state()).leases.map((item) => item.ref),
    [finite.resultRef, task.resultRef, recent.resultRef]
  )
  assert.match((await reopened.read(segment.resultRef)).text, /archived/)
  await reopened.endTask()
  assert.deepEqual(
    (await reopened.state()).leases.map((item) => item.ref),
    [finite.resultRef]
  )
})

test('provider capacity rejection repairs only the request, does not replay an observation, and bounds retries', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield { type: 'error', code: 'context-limit', message: 'context too long' }
        return
      }
      if (f.calls === 2) {
        assert.equal(request.mode, 'work')
        assert.equal(request.contextStatus.phase, 'work')
      }
      yield* done(request)
    },
    { context: { sources: [], maintenance: false } }
  )
  await f.session.observe({ source: "import {output} from 'velaros';output('stable');" })
  await run(f, 'Check')
  assert.equal(f.calls, 2)
  const records = (await f.storage.load('s')).records.filter((item) =>
    /^script:[0-9a-f-]+:result$/.test(item.title)
  )
  assert.equal(records.length, 1)
})

test('INV-59 opaque continuation follows complete accepted history across reopen, folding and authorization reset', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  const id = 'continuation:test'
  const context = createContextRuntime({ sessionId: id, storage: f.storage })
  let history = new RecentContext(id, context, f.storage)
  const signal = new AbortController().signal
  const originals = []
  const results = []
  for (let n = 0; n < 4; n++) {
    const state = { model: 'fixture', format: 'fixture-v1', data: `opaque-${n}`, tokens: 40 }
    const metadata = await context.append({
      kind: 'audit',
      title: 'model-continuation',
      body: JSON.stringify(state),
    })
    originals.push(
      await context.append({ kind: 'assistant', body: `script ${n}`, sources: [metadata.ref] })
    )
    results.push(
      await context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: JSON.stringify({ n }),
      })
    )
  }
  // 模型笔记不能伪装为受信的供应商状态；没有已接受响应引用的状态也不会投影。
  const forged = await context.append({
    kind: 'note',
    title: 'model-continuation',
    body: JSON.stringify({ model: 'fixture', format: 'fixture-v1', data: 'forged', tokens: 1 }),
  })
  await context.append({ kind: 'assistant', body: 'ordinary response', sources: [forged.ref] })
  await context.append({
    kind: 'audit',
    title: 'model-continuation',
    body: JSON.stringify({ model: 'fixture', format: 'fixture-v1', data: 'orphan', tokens: 1 }),
  })
  const first = await history.project(segment(), [], 60000, signal)
  const carried = first.messages.filter((message) => message.continuation)
  assert.deepEqual(
    carried.map((message) => message.content),
    ['script 0', 'script 1', 'script 2', 'script 3']
  )
  assert.deepEqual(
    carried.map((message) => message.continuation.data),
    ['opaque-0', 'opaque-1', 'opaque-2', 'opaque-3']
  )
  assert(!JSON.stringify(first.messages).includes('forged'))
  assert(!JSON.stringify(first.messages).includes('orphan'))
  await history.commit(segment({ entries: first.fresh }))
  history = new RecentContext(
    id,
    createContextRuntime({ sessionId: id, storage: f.storage }),
    f.storage
  )
  const restored = await history.project(await history.segment(signal), [], 60000, signal)
  assert.deepEqual(restored.messages, first.messages)
  await history.seal(0, results[1].sequence, signal)
  const next = await history.project(
    segment({ index: 2, from: results[1].sequence }),
    [],
    60000,
    signal
  )
  assert.deepEqual(
    next.messages
      .filter((message) => message.continuation)
      .map((message) => message.continuation.data),
    ['opaque-2', 'opaque-3']
  )
  const longState = await context.append({
    kind: 'audit',
    title: 'model-continuation',
    body: JSON.stringify({
      model: 'fixture',
      format: 'fixture-v1',
      data: 'long-state',
      tokens: 40,
    }),
  })
  await context.append({ kind: 'assistant', body: 'x'.repeat(3000), sources: [longState.ref] })
  const excerpt = await history.project(segment({ from: longState.sequence }), [], 1024, signal)
  assert.equal(excerpt.messages[0].continuation, undefined)
  assert.match(excerpt.messages[0].content, /"representation":"excerpt"/)
  await context.append({ kind: 'event', title: 'search:history-reset', body: '{}' })
  const reset = await history.project(segment(), [], 60000, signal)
  assert.deepEqual(reset.messages, [])
  assert.equal((await context.read(originals[0].ref)).text, 'script 0')
})

test('INV-59 runtime persists accepted continuation and supplies it only beside the complete original response', async (t) => {
  let first
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        first = block(request, "import {output} from 'velaros';output('continuation-result');")
        yield { type: 'text', text: first }
        yield {
          type: 'continuation',
          value: {
            model: 'context-test',
            format: 'fixture-v1',
            data: 'opaque-runtime-fixture',
            tokens: 40,
          },
        }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      const response = request.history.find((message) => message.continuation)
      assert.equal(response.content, first)
      assert.equal(response.continuation.data, 'opaque-runtime-fixture')
      assert(!request.compiledPrompt.includes('opaque-runtime-fixture'))
      assert(
        !request.materials.some((material) => material.text.includes('opaque-runtime-fixture'))
      )
      yield* done(request)
    },
    { context: { sources: [], maintenance: false } }
  )
  await run(f, 'exercise continuation')
  assert.equal(f.calls, 2)
})

test('folding keeps recent action-result units for the next segment, seals the rest and allows original history recall', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  const context = createContextRuntime({ sessionId: 'search:test', storage: f.storage })
  const history = new RecentContext('search:test', context, f.storage)
  const signal = new AbortController().signal
  const pairs = []
  for (let n = 0; n < 4; n++) {
    await context.append({ kind: 'assistant', body: `script ${n}` })
    pairs.push(
      await context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: JSON.stringify({ n }),
      })
    )
  }
  const through = await history.cut(segment(), 2, signal)
  assert.equal(through, pairs[1].sequence)
  const volume = await history.seal(0, through, signal)
  await history.narrate(
    volume,
    {
      summary: 'steps 0 and 1 completed',
      evidence: [pairs[0].ref],
      unresolved: ['verify final'],
      negativeAttempts: ['first query missed'],
    },
    signal
  )
  const [sealed] = await history.volumes(signal)
  assert.deepEqual(sealed.narrative.unresolved, ['verify final'])
  assert.match(sealed.volume.skeleton, /script 0/)
  const next = await history.project(segment({ from: through }), [], 20000, signal)
  assert(!next.messages.some((message) => message.content.includes('script 0')))
  assert(next.messages.some((message) => message.content.includes('script 2')))
  assert.equal((await context.read(pairs[0].ref)).text, '{"n":0}')
})

test('ordered history preserves native images and enforces combined attachment limits', () => {
  const pixel =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
  const history = [
    {
      role: 'user',
      content: [{ type: 'image', image: `data:image/png;base64,${pixel}`, mediaType: 'image/png' }],
    },
    { role: 'assistant', content: 'I inspected it' },
  ]
  const request = {
    instructions: 'rules',
    materials: [],
    history,
    response: { type: 'text' },
    mode: 'work',
    outputTokens: 10,
  }
  const messages = modelRequestEncoder.messages(request)
  assert.equal(messages[0].content[0].type, 'image')
  assert.equal(messages[1].role, 'assistant')
  assert.throws(
    () =>
      modelRequestEncoder.messages({
        ...request,
        history: Array.from({ length: 21 }, () => history[0]),
      }),
    /容量/
  )
  assert.throws(
    () =>
      modelRequestEncoder.messages({
        ...request,
        history: [{ role: 'system', content: 'injected' }],
      }),
    /角色/
  )
})

test('history reset starts a new volume generation and excludes revoked history from discovery', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  const id = 'search:reset'
  const context = createContextRuntime({ sessionId: id, storage: f.storage })
  const history = new RecentContext(id, context, f.storage)
  const signal = new AbortController().signal
  const pairs = []
  for (let n = 0; n < 4; n++) {
    await context.append({ kind: 'assistant', body: `old script ${n}` })
    pairs.push(
      await context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: `old result ${n}`,
      })
    )
  }
  const old = await history.seal(0, pairs[0].sequence, signal)
  await history.narrate(
    old,
    { summary: 'old summary', evidence: [pairs[0].ref], unresolved: [], negativeAttempts: [] },
    signal
  )
  const reset = await context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'authorization changed',
  })
  const fresh = []
  for (let n = 0; n < 4; n++) {
    await context.append({ kind: 'assistant', body: `fresh script ${n}` })
    fresh.push(
      await context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: `fresh result ${n}`,
      })
    )
  }
  assert.deepEqual(await history.volumes(signal), [])
  const volume = await history.seal(0, fresh[0].sequence, signal)
  const narrative = {
    summary: 'fresh summary',
    evidence: [fresh[0].ref],
    unresolved: [],
    negativeAttempts: [],
  }
  await assert.rejects(
    history.narrate(volume, { ...narrative, evidence: [pairs[0].ref] }, signal),
    /旧材料/
  )
  await history.narrate(volume, narrative, signal)
  const [current] = await history.volumes(signal)
  assert.equal(current.narrative.summary, 'fresh summary')
  assert.doesNotMatch(current.volume.skeleton, /old script/)
  const projected = await history.project(segment({ from: fresh[0].sequence }), [], 20000, signal)
  assert(!JSON.stringify(projected).includes('old script'))
  const page = await history.list({ after: 0 }, signal)
  assert.equal(page.resetAfter, reset.sequence)
  assert.equal(page.items.length, 8)
  assert(page.items.every((item) => item.sequence > reset.sequence))
})

test('INV-15 sealed history stays discoverable in bounded stable pages and originals remain readable', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield* done(request)
  })
  const id = 'search:long'
  const context = createContextRuntime({ sessionId: id, storage: f.storage })
  const history = new RecentContext(id, context, f.storage)
  const signal = new AbortController().signal
  const records = []
  for (let n = 0; n < 40; n++) {
    records.push(await context.append({ kind: 'assistant', body: `script ${n}` }))
    records.push(
      await context.append({
        kind: 'audit',
        title: `script:${crypto.randomUUID()}:result`,
        body: `result ${n}`,
      })
    )
  }
  const through = await history.cut(segment(), 8, signal)
  assert.equal(through, records[71].sequence)
  await history.seal(0, through, signal)
  const [sealed] = await history.volumes(signal)
  assert.equal(sealed.volume.turns, 36)
  assert(sealed.volume.skeleton.length <= 6000)
  const first = await history.list({ after: 0, limit: 5 }, signal)
  await context.append({ kind: 'assistant', body: 'concurrent new response' })
  const found = [...first.items]
  let cursor = first.nextAfter
  while (cursor !== null) {
    const page = await history.list({ after: cursor, through: first.through, limit: 7 }, signal)
    found.push(...page.items)
    cursor = page.nextAfter
  }
  assert.deepEqual(
    found.map((item) => item.ref),
    records.map((item) => item.ref)
  )
  assert(!JSON.stringify(found).includes('concurrent new response'))
  assert.equal((await context.read(found[1].ref)).text, 'result 0')
  assert.equal((await history.list({ limit: 64 }, signal)).items.length, 64)
  await assert.rejects(history.list({ limit: 65 }, signal), /范围/)
  await assert.rejects(history.list({ after: -1 }, signal), /范围/)
  const aborted = AbortSignal.abort()
  await assert.rejects(history.list({}, aborted), { name: 'AbortError' })
})

test('INV-16 forty business rounds keep runtime context bounded while leases expire and original results survive', async (t) => {
  const samples = []
  const started = Date.now()
  let durableRef
  const f = await fixture(
    t,
    async function* (request, f) {
      const frame = runtimeFrame(request)
      samples.push({
        round: f.calls,
        chars: request.materials[0].text.length,
        visible: frame.results.length,
        completedTurns: frame.programFrame.completedTurns,
      })
      assert.equal(request.contextStatus.mode, 'partitioned')
      // 段内历史只往后加；租约已结束的冻结正文在容量不足时一次性退成引用卡，请求始终在窗口内
      assert(
        requestSize(request) / 4 <= request.contextStatus.inputLimit,
        JSON.stringify(samples.at(-1))
      )
      assert(frame.results.length <= 3, JSON.stringify(samples.at(-1)))
      assert.match(frame.observation.text, /persistent-observation/)
      if (f.calls > 4) {
        assert(
          !frame.results.some(
            (item) => item.remainingTurns !== 'task' && item.text.includes('"iteration":1,')
          )
        )
      }
      const durable = frame.results.find((item) => item.remainingTurns === 'task')
      if (durable) durableRef = durable.ref
      if (f.calls === 41) {
        yield* done(request)
        return
      }
      const release =
        f.calls === 16
          ? `import {memory as memoryApi} from 'velaros:system';const {release}=memoryApi;await release({ref:${JSON.stringify(durableRef)}});`
          : ''
      yield {
        type: 'text',
        text: `${marker(request)} execute({retain:${f.calls === 1 ? '"task"' : 2}})\n${release}import {output} from 'velaros';output({iteration:${f.calls},detail:'x'.repeat(12000)});\n${marker(request)}`,
      }
      yield { type: 'finish', reason: 'stop' }
    },
    {
      limits: {
        turns: 42,
        outputTokens: 2048,
        safetyTokens: 1024,
        projectionChars: 24000,
        recoveryChars: 6000,
        timeoutMs: 90000,
      },
    },
    // 估算与请求大小成正比：过期结果的冻结正文靠容量规划退成引用卡，而不是随轮数累积
    {
      limits: { contextTokens: 24000, inputTokens: 20000, outputTokens: 2048 },
      estimate: async (request) => ({
        tokens: Math.ceil(requestSize(request) / 4),
        precision: 'estimate',
        basis: 'chars/4',
      }),
    }
  )
  await f.session.observe({
    source: "import {output} from 'velaros';output('persistent-observation');",
  })
  await run(f, 'Run a long task with expiring results')
  assert.equal(f.calls, 41)
  const state = await f.storage.load('s')
  const leases = await f.programs.state()
  assert(leases.leases.length <= 2)
  assert(!leases.leases.some((item) => item.task))
  assert.equal(state.records.filter((item) => item.kind === 'assistant').length, 41)
  assert.equal(
    state.records.filter((item) => /^script:[0-9a-f-]{36}:result$/.test(item.title)).length,
    81
  )
  assert((await f.programs.read(durableRef, 0, 60000)).text.includes('"iteration":1'))
  const steady = samples.slice(5)
  const maxChars = Math.max(...steady.map((item) => item.chars))
  assert(maxChars < 40000, JSON.stringify(samples))
  assert(samples.at(-1).chars <= samples[5].chars + 2000)
  t.diagnostic(
    JSON.stringify({
      modelCalls: f.calls,
      scriptRuns: 81,
      records: state.records.length,
      elapsedMs: Date.now() - started,
      maxFrameChars: maxChars,
      finalFrameChars: samples.at(-1).chars,
      retainedLeases: leases.leases.length,
    })
  )
})

/** 请求里实际发送的文字字符数。 */
function requestSize(request) {
  return (
    request.instructions.length +
    (request.compiledPrompt ?? '').length +
    (request.history ?? []).reduce(
      (sum, message) =>
        sum +
        (typeof message.content === 'string'
          ? message.content.length
          : JSON.stringify(message.content).length),
      0
    )
  )
}
/** 每轮净增长约 240 token，这个窗口大约在第 19 轮封一次段。 */
const WINDOW = 9000
test('INV-50 a long run folds by remaining turns: every request fits the window and old history is sealed into volumes', async (t) => {
  const statuses = []
  const f = await fixture(
    t,
    async function* (request, f) {
      statuses.push(request.contextStatus)
      const from = runtimeFrame(request).memoryStatus.segment.from
      const saved = await f.storage.load('s')
      const sequence = new Map(saved.records.map((record) => [record.ref.id, record.sequence]))
      for (const lease of (await f.programs.state()).leases.filter((item) => item.segment))
        assert(sequence.get(lease.ref) > from, '封段后的旧 segment 租约必须释放')
      if (f.calls === 36) {
        yield* done(request)
        return
      }
      yield {
        type: 'text',
        text: `step ${f.calls}\n${marker(request)} execute()\nimport {output} from 'velaros';output({step:${f.calls},detail:'y'.repeat(3000)});\n${marker(request)}`,
      }
      yield { type: 'finish', reason: 'stop' }
    },
    {
      limits: {
        turns: 40,
        outputTokens: 2048,
        safetyTokens: 1024,
        projectionChars: 1000000,
        recoveryChars: 6000,
        timeoutMs: 120000,
      },
      // 只测按剩余轮数封段；自动封段后的补写叙事另有用例
      context: { sources: [], maintenance: false },
    },
    // 估算与请求大小成正比、窗口较小，让封段在几十轮内发生
    {
      limits: { contextTokens: WINDOW + 4000, inputTokens: WINDOW, outputTokens: 2048 },
      estimate: async (request) => ({
        tokens: Math.ceil(requestSize(request) / 4),
        precision: 'estimate',
        basis: 'chars/4',
      }),
    }
  )
  await run(f, 'Keep working in small steps')
  assert.equal(f.calls, 36)
  const window = statuses[0].inputLimit
  assert(statuses.every((status) => status.inputTokens <= window))
  const segments = new Set(statuses.map((status) => status.segment.index))
  assert(segments.size > 1, JSON.stringify(statuses.map((status) => status.segment)))
  assert(statuses.at(-1).segment.volumes >= 1)
  const results = (await f.storage.load('s')).records.filter((item) =>
    /^script:[0-9a-f-]+:result$/.test(item.title)
  )
  assert.equal(results.length, 35, '封段不能重跑生产操作')
  assert.match((await f.programs.read(results[0].ref.id)).text, /"step":1/)
  // 封段之间段号只增不减，段内轮数在新段重新计数
  for (let index = 1; index < statuses.length; index++)
    assert(statuses[index].segment.index >= statuses[index - 1].segment.index)
})

test('INV-53 automatic folds persist each busy volume narrative once, whether pressure or boundary maintenance supplies it', async (t) => {
  const narrated = []
  const maintenanceCalls = []
  const maintenance = {
    id: 'narrator',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      const call = { volume: null }
      maintenanceCalls.push(call)
      const snapshot = JSON.parse(
        JSON.parse(request.materials[0].text).partitions.task.goals[0].text
      ).snapshot
      // 压力整理可能发生在还没有封卷的段里，那时只提交摘要
      if (snapshot.volume) {
        call.volume = snapshot.volume.ref.id
        narrated.push(call.volume)
      }
      const patch = {
        baseRevision: snapshot.baseRevision,
        summary: 'Narrated the sealed volume',
        unresolved: [],
        ...(snapshot.volume
          ? {
              volume: {
                summary: `Volume ${snapshot.volume.from + 1}-${snapshot.volume.through} printed step outputs`,
                evidence: [],
                unresolved: ['decide the final format'],
                negativeAttempts: [`printing again after ${snapshot.volume.through}`],
              },
            }
          : {}),
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
  const bases = []
  const activeStates = []
  const statuses = []
  const f = await fixture(
    t,
    async function* (request, f) {
      bases.push(request.history[0].content)
      activeStates.push(
        JSON.parse(request.materials.findLast((item) => item.origin === 'runtime-view').text)
          .partitions.task.active
      )
      statuses.push(request.contextStatus)
      if (f.calls === 44) {
        yield* done(request)
        return
      }
      yield {
        type: 'text',
        text: `step ${f.calls}\n${marker(request)} execute()\nimport {output} from 'velaros';output({step:${f.calls},detail:'y'.repeat(3000)});\n${marker(request)}`,
      }
      yield { type: 'finish', reason: 'stop' }
    },
    {
      limits: {
        turns: 60,
        outputTokens: 2048,
        safetyTokens: 1024,
        projectionChars: 1000000,
        recoveryChars: 6000,
        timeoutMs: 120000,
      },
      context: { sources: [], maintenance: { model: maintenance } },
      // 此支线会为当前卷交叙事；压力整理也可能先完成该卷，自动补写不得再次请求。
      // 默认期限的工作窗口约束由上面的 INV-50 长程用例验证。
      protocol: { defaultRetain: 2 },
    },
    {
      limits: { contextTokens: WINDOW + 4000, inputTokens: WINDOW, outputTokens: 2048 },
      estimate: async (request) => ({
        tokens: Math.ceil(requestSize(request) / 4),
        precision: 'estimate',
        basis: 'chars/4',
      }),
    }
  )
  const events = await run(f, 'Keep working in small steps')
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(f.calls, 44)
  assert(statuses.every((status) => status.inputTokens <= statuses[0].inputLimit))
  // 调度可先由压力整理交付叙事；后续边界消费自动意图时不得再分配一次模型调用。
  assert(narrated.length >= 1)
  assert.equal(new Set(narrated).size, narrated.length)
  const state = await f.storage.load('s')
  const outcomes = await Promise.all(
    state.records
      .filter((record) => record.title === 'context-maintenance:outcome')
      .map(async (record) => JSON.parse(await f.storage.get('s', record.objectId)))
  )
  assert.equal(
    outcomes.filter((item) => item.changes?.volume).length,
    narrated.length,
    JSON.stringify(outcomes)
  )
  assert.equal(outcomes.length, maintenanceCalls.length, JSON.stringify(outcomes))
  assert.equal(
    outcomes.reduce((calls, item) => calls + item.usage.calls, 0),
    maintenanceCalls.length,
    'every real maintenance model call is accounted for, including any failed attempt'
  )
  assert(
    outcomes.every(
      (item) =>
        ['narrate', 'pressure'].includes(item.reason) &&
        item.status === 'applied' &&
        item.error === null &&
        item.delivery.status === 'completed'
    ),
    JSON.stringify(outcomes)
  )
  const volumes = await new RecentContext('s', f.session.context, f.storage).volumes(
    new AbortController().signal
  )
  const busy = volumes.filter(
    (item) => item.volume.turns >= ActRuntimeTuning.narrateTurns && !item.volume.notes.length
  )
  assert(busy.length >= 1)
  for (const item of busy) {
    assert(item.narrative, `busy sealed volume ${item.ref.id} has no persisted narrative`)
    assert.equal(
      maintenanceCalls.filter((call) => call.volume === item.ref.id).length,
      1,
      `busy sealed volume ${item.ref.id} must be supplied by exactly one model call`
    )
    assert.match(item.narrative.summary, /printed step outputs/)
  }
  for (const call of maintenanceCalls.filter((item) => item.volume)) {
    assert(volumes.some((item) => item.ref.id === call.volume && item.narrative))
  }
  // 叙事和长期单随下一次底座重建进入主线请求
  const narrated_base = bases.find((base) => base.includes('这一卷的叙事'))
  assert(narrated_base)
  assert.match(narrated_base, /printed step outputs/)
  assert(
    activeStates.some((active) =>
      active.items.some(
        (item) => item.kind === 'question' && item.text === 'decide the final format'
      )
    )
  )
  assert.match(narrated_base, /否定尝试[^\n]*：\["printing again after \d+"/)
})
