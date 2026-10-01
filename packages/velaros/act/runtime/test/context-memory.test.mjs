import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner, scriptOutputs } from '@velaros-ai/script'

import { ContextMemory } from '../../../dist/act/runtime/impl/ContextMemory.js'
import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  memoryCommittedGroups,
  memoryOutput,
  memoryPrompt,
} from '../../../dist/act/runtime/utils/context-memory.js'
import { projectMaterial, readMaterialField } from '../../../dist/act/runtime/utils/materials.js'

import { baseNotes, done, historyEntries, marker, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal

test('INV-58 new and legacy output representations share actual prompt bounds and preserve failure gaps', () => {
  const value = 'alpha("beta");\n'.repeat(40)
  const capture = {
    config: {},
    issues: [],
    blocks: [
      {
        key: 'sample',
        value,
        chars: JSON.stringify(value).length,
        options: { key: 'sample', type: 'code', view: { mode: 'full' } },
      },
    ],
  }
  for (const format of ['json', 'text'])
    for (const cap of [0, 900, 2400]) {
      const projection = scriptOutputs.project(
        capture,
        'source-result',
        cap,
        undefined,
        undefined,
        undefined,
        format
      )
      const delivered = projection.prompt ? memoryOutput(projection.prompt, format) : ''
      assert(delivered.length <= cap)
      if (format === 'text') assert.equal(delivered, projection.prompt)
      if (format === 'text' && cap === 900) assert(delivered.includes(value))
      if (format === 'json' && projection.prompt)
        assert.equal(memoryOutput(projection.prompt), delivered)
      const missing = projection.blocks[0]?.representation !== 'full'
      const frame = {
        partitions: {
          task: { goals: [] },
          workspace: { notes: [] },
          observation: {
            text: projection.prompt,
            presentation: { ...(format === 'text' ? { format } : {}), allocatedChars: cap },
            collectionIssues: ['CAPTURE_FAILURE'],
          },
          recent: {
            results: [
              {
                ref: 'source-result',
                structuredOutput: true,
                ...(format === 'text' ? { outputFormat: format } : {}),
                text: projection.prompt,
              },
            ],
          },
          runtime: {
            mandatory: [
              { id: 'failed-call', outcome: 'failed', effect: 'unknown', code: 'DOMAIN_FAILURE' },
            ],
            decision: {
              missing: missing
                ? [{ ref: 'source-result', key: 'sample', reason: 'required-body-unavailable' }]
                : [],
            },
          },
        },
        memoryStatus: {},
      }
      const original = JSON.stringify(frame)
      const prompt = memoryPrompt(original)
      const empty = structuredClone(frame)
      empty.partitions.observation.text = ''
      empty.partitions.recent.results[0].text = ''
      // 计入两份正文和 recent 输出标签，不把输出 chunk 的上限冒充全帧上限。
      assert(
        prompt.length <=
          memoryPrompt(JSON.stringify(empty)).length + 2 * cap + '当次输出：\n'.length + 1
      )
      assert(prompt.includes('CAPTURE_FAILURE'))
      assert(prompt.includes('DOMAIN_FAILURE'))
      assert.equal(prompt.includes('required-body-unavailable'), missing)
      if (delivered) assert.equal(prompt.split(delivered).length - 1, 2)
      assert.equal(JSON.stringify(frame), original)
    }
})

test('committed receipt summaries retain every failed, partial, and unknown outcome', () => {
  const committed = Array.from({ length: 12 }, (_, index) => ({
    id: `write:${index}`,
    executionId: `execution:${index}`,
    operation: 'store.set',
    outcome: 'succeeded',
    effect: 'committed',
  }))
  const detailed = [
    { id: 'failed', operation: 'store.set', outcome: 'failed', effect: 'committed' },
    { id: 'partial', operation: 'store.set', outcome: 'succeeded', effect: 'partial' },
    { id: 'unknown', operation: 'store.set', outcome: 'succeeded', effect: 'unknown' },
    { id: 'read', operation: 'store.get', outcome: 'succeeded', effect: 'none' },
    {
      id: 'diagnostic',
      operation: 'store.set',
      outcome: 'succeeded',
      effect: 'committed',
      code: 'DOMAIN_LOG',
      detail: 'observed data',
    },
  ]
  const receipts = [...committed.slice(0, 4), ...detailed, ...committed.slice(4)]
  const original = structuredClone(receipts)
  const result = memoryCommittedGroups(receipts)
  assert.deepEqual(result, [
    {
      operation: 'store.set',
      outcome: 'succeeded',
      effect: 'committed',
      representation: 'grouped-receipts',
      count: 12,
      firstId: 'write:0',
      lastId: 'write:11',
    },
    ...detailed,
  ])
  assert.deepEqual(receipts, original)
  assert.deepEqual(memoryCommittedGroups(committed.slice(0, 2)), committed.slice(0, 2))
})

test('INV-35 model receipt grouping preserves full raw decisions and every failure or world effect', () => {
  const reads = Array.from({ length: 80 }, (_, index) => ({
    id: `run:${index}`,
    executionId: `execution:${index}`,
    operation: 'materials.read',
    outcome: 'succeeded',
    effect: 'none',
  }))
  const unsafe = [
    {
      id: 'diagnostic',
      operation: 'materials.read',
      outcome: 'succeeded',
      effect: 'none',
      code: 'DOMAIN_LOG',
      detail: 'observed data',
    },
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
      task: { goals: [] },
      workspace: { notes: [] },
      observation: {},
      recent: { history: [], results: [] },
      runtime: {
        mandatory: [...reads, ...unsafe],
        decision: { frameId: 'frame', missing: [] },
      },
    },
    memoryStatus: {},
  }
  const before = structuredClone(frame)
  const prompt = memoryPrompt(JSON.stringify(frame))
  assert.deepEqual(frame, before)
  assert.equal(frame.partitions.runtime.mandatory.length, 84)
  const displayed = JSON.parse(prompt.split('分区 runtime：\n')[1].split('\ngrouped-receipts')[0])
  assert.deepEqual(displayed, {
    ...frame.partitions.runtime,
    mandatory: [
      {
        operation: 'materials.read',
        outcome: 'succeeded',
        effect: 'none',
        representation: 'grouped-receipts',
        count: 80,
        firstId: 'run:0',
        lastId: 'run:79',
      },
      ...unsafe,
    ],
  })
  assert(!prompt.includes('run:40'))
  assert(prompt.includes('observed data'))
  assert(prompt.length < JSON.stringify(frame).length / 3)
})
test('INV-65 receipt summaries use actual encoded size while preserving diagnostics and existing groups', () => {
  const receipts = ['none', 'committed'].flatMap((effect) =>
    Array.from({ length: 2 }, (_, index) => ({
      id: `${effect}-invocation-${index}`,
      executionId: `execution-00000000-0000-0000-0000-00000000000${index}`,
      operation: 'example.operation',
      outcome: 'succeeded',
      effect,
    }))
  )
  const guarded = [
    { ...receipts[0], id: 'failed', outcome: 'failed' },
    { ...receipts[0], id: 'partial', effect: 'partial' },
    { ...receipts[0], id: 'unknown', effect: 'unknown' },
    { ...receipts[0], id: 'diagnostic', code: 'LOG', detail: 'complete diagnostic' },
    { ...receipts[0], id: 'referenced', code: 'LOG', detailInHistory: 'history-1' },
    { ...receipts[0], id: 'extra', futureField: 'preserve unknown metadata' },
    { ...receipts[0], id: 'empty-code', code: '' },
    {
      operation: 'prior.write',
      outcome: 'succeeded',
      effect: 'committed',
      representation: 'grouped-receipts',
      count: 19,
      firstId: 'first',
      lastId: 'last',
    },
  ]
  const frame = {
    partitions: {
      task: { goals: [] },
      workspace: { notes: [] },
      observation: {},
      recent: { results: [] },
      runtime: { mandatory: [...receipts, ...guarded] },
    },
    memoryStatus: {},
  }
  const original = JSON.stringify(frame)
  const displayed = JSON.parse(memoryPrompt(original).split('分区 runtime：\n')[1].split('\n')[0])
  assert.deepEqual(
    displayed.mandatory.slice(0, 2),
    ['none', 'committed'].map((effect) => ({
      operation: 'example.operation',
      outcome: 'succeeded',
      effect,
      representation: 'grouped-receipts',
      count: 2,
      firstId: `${effect}-invocation-0`,
      lastId: `${effect}-invocation-1`,
    }))
  )
  assert.deepEqual(displayed.mandatory.slice(2), guarded)
  assert(
    JSON.stringify(displayed.mandatory).length <
      JSON.stringify(frame.partitions.runtime.mandatory).length
  )
  assert.equal(JSON.stringify(frame), original)
  const duplicate = [{ ...receipts[0] }, { ...receipts[0], executionId: 'different-execution' }]
  frame.partitions.runtime.mandatory = duplicate
  assert.deepEqual(
    JSON.parse(memoryPrompt(JSON.stringify(frame)).split('分区 runtime：\n')[1].split('\n')[0])
      .mandatory,
    duplicate
  )
})

test('INV-65 completed job maps preserve every identity and only use explicit live history bodies', () => {
  const completed = Array.from({ length: 8 }, (_, index) => ({
    executionId: `execution-${index}`,
    status: 'succeeded',
    resultRef: `result-${index}`,
  }))
  const guarded = [
    { executionId: 'active', status: 'running', resultRef: 'result-0' },
    { executionId: 'failed', status: 'failed', resultRef: 'result-1', error: 'keep failure' },
    { executionId: 'unknown', status: 'unknown', resultRef: 'result-2' },
    { executionId: 'absent', status: 'succeeded', resultRef: 'absent' },
    { executionId: 'reference', status: 'succeeded', resultRef: 'reference' },
    { executionId: 'extra', status: 'succeeded', resultRef: 'result-3', futureField: 'keep' },
  ]
  const jobs = [...completed.slice(0, 4), ...guarded, ...completed.slice(4)]
  const frame = {
    partitions: {
      task: { goals: [] },
      workspace: { notes: [] },
      observation: {},
      recent: {
        results: [
          ...completed.map((job) => ({
            ref: job.resultRef,
            bodyInHistory: true,
            bodyIncluded: true,
          })),
          { ref: 'reference', bodyInHistory: true, bodyIncluded: false },
        ],
      },
      runtime: { mandatory: [], jobs },
    },
    memoryStatus: {},
  }
  const original = JSON.stringify(frame)
  const prompt = memoryPrompt(original)
  const displayed = JSON.parse(prompt.split('分区 runtime：\n')[1].split('\n')[0])
  assert.equal(displayed.jobs.filter((job) => job.representation === 'completed-jobs').length, 2)
  const restored = displayed.jobs.flatMap((job) =>
    job.representation === 'completed-jobs'
      ? Object.entries(job.results).map(([executionId, resultRef]) => ({
          executionId,
          status: job.status,
          resultRef,
        }))
      : [job]
  )
  assert.deepEqual(restored, jobs)
  assert.equal(JSON.stringify(frame), original)
  assert(JSON.stringify(displayed.jobs).length < JSON.stringify(jobs).length)
  frame.partitions.recent.results = []
  assert.deepEqual(
    JSON.parse(memoryPrompt(JSON.stringify(frame)).split('分区 runtime：\n')[1].split('\n')[0])
      .jobs,
    jobs
  )
  frame.partitions.recent.results = [{ ref: 'result-0', bodyIncluded: true, bodyInHistory: true }]
  frame.partitions.runtime.jobs = Array.from({ length: 4 }, () => completed[0])
  assert.deepEqual(
    JSON.parse(memoryPrompt(JSON.stringify(frame)).split('分区 runtime：\n')[1].split('\n')[0])
      .jobs,
    frame.partitions.runtime.jobs
  )
  frame.partitions.runtime.jobs = ['2', '1', '0', '3'].map((executionId) => ({
    ...completed[0],
    executionId,
  }))
  assert.deepEqual(
    JSON.parse(memoryPrompt(JSON.stringify(frame)).split('分区 runtime：\n')[1].split('\n')[0])
      .jobs,
    frame.partitions.runtime.jobs
  )
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
  return { runtime, session, storage, memory, requests, root, model }
}
async function execute(f, source) {
  const result = await f.session.execute({ source })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  return result.result.value?.default
}

test('selection units recover missing array items and both sides of text through memory.read', async (t) => {
  const f = await fixture(t)
  const rows = Array.from({ length: 100 }, (_, id) => ({ id, text: `row ${id} 😀` }))
  const text = Array.from({ length: 100 }, (_, id) => `\tline ${id} 😀\r`).join('\n')
  for (const [value, options] of [
    [rows, { type: 'list', view: { maxItems: 3 } }],
    [rows, { type: 'list', view: { maxItems: 3, edge: 'tail' } }],
    [rows, { type: 'list', view: { edge: 'tail' } }],
    [text, { type: 'code', view: { edge: 'head' } }],
    [text, { type: 'code', view: { edge: 'tail' } }],
    [text, { type: 'text', view: { lines: [20, 40] } }],
  ]) {
    const result = await f.session.execute({
      source: `import {output} from 'velaros';output(${JSON.stringify(value)},${JSON.stringify(options)});`,
    })
    assert.equal(result.checked, true)
    const raw = await f.memory.readMaterial(result.resultRef, 0, 60000, signal)
    const archive = JSON.parse(raw.text)
    const shown = scriptOutputs.project(archive.output, result.resultRef, 1100).blocks[0]
    const read = async (pointer, offset, limit) =>
      execute(
        f,
        `import {output} from 'velaros';import {memory} from 'velaros:system';output(await memory.read(${JSON.stringify({ ref: result.resultRef, pointer, offset, limit })}));`
      )
    if (Array.isArray(value)) {
      const { from, shown: count, total, unit } = shown.selection
      assert.equal(unit, 'items')
      const index = from > 0 ? from - 1 : from + count
      assert(index < total)
      const page = await read(`${shown.pointer}/${index}`, 0, 1000)
      assert.deepEqual(JSON.parse(page.text), value[index])
      const materialSource = JSON.stringify({ rows })
      const material = projectMaterial(
        materialSource,
        { sessionId: 's', id: result.resultRef },
        1000
      )
      const excerpt = JSON.parse(material.text).rows
      assert.equal(excerpt.selection.unit, 'items')
      const next = readMaterialField(
        materialSource,
        `${excerpt.read.pointer}/${excerpt.selection.shown}`,
        0,
        1000
      )
      assert.deepEqual(JSON.parse(next.text), value[excerpt.selection.shown])
    } else {
      const { from, shown: count, total, unit } = shown.selection.chars
      assert.equal(unit, 'utf16')
      const before = from > 0 ? (await read(shown.pointer, 0, from)).text : ''
      const after =
        from + count < total
          ? (await read(shown.pointer, from + count, total - from - count)).text
          : ''
      assert.equal(before + shown.text + after, value)
    }
    assert.deepEqual(await f.memory.readMaterial(result.resultRef, 0, 60000, signal), raw)
  }
})

test('archived result fields page original text directly through the actual memory operation', async (t) => {
  const f = await fixture(t)
  const original = `prefix😀\n${'source line\n'.repeat(7000)}tail evidence`
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output({unrelated:'x'.repeat(70000),'a/b~c':'prefix😀\\n'+'source line\\n'.repeat(7000)+'tail evidence'},{key:'source'});`,
  })
  assert.equal(result.checked, true)
  const pointer = '/output/blocks/0/value/a~1b~0c'
  const legacy = await f.memory.readMaterial(result.resultRef, 0, 60000, signal)
  assert(legacy.totalChars > 60000)
  assert(legacy.text.startsWith('{'))
  const page = await f.memory.readMaterial(result.resultRef, 70005, 400, signal, pointer)
  assert.equal(page.text, original.slice(70005, 70405))
  assert.equal(page.pointer, pointer)
  assert.equal(page.totalChars, original.length)
  assert.equal(page.offset, 70005)
  assert.equal(page.record.ref.id, result.resultRef)
  const actual = await execute(
    f,
    `
    import {output} from 'velaros';import {memory} from 'velaros:system';
    output(await memory.read({ref:${JSON.stringify(result.resultRef)},pointer:${JSON.stringify(pointer)},offset:70005,limit:400}));
  `
  )
  assert.deepEqual(actual, page)
  const empty = await f.memory.readMaterial(result.resultRef, original.length, 400, signal, pointer)
  assert.equal(empty.text, '')
  assert.equal(empty.totalChars, original.length)
  assert.deepEqual(await f.memory.readMaterial(result.resultRef, 0, 60000, signal), legacy)
})

test('archived field selectors validate paths and ranges and only traverse own JSON properties', async (t) => {
  const f = await fixture(t)
  const value = { rows: [{ text: 'a😀b' }], empty: '', nil: null, ['__proto__']: 'own data' }
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output(JSON.parse(${JSON.stringify(JSON.stringify(value))}),{key:'source'});`,
  })
  assert.equal(result.checked, true)
  const prefix = '/output/blocks/0/value'
  const read = (pointer, offset = 0, limit = 60000) =>
    f.memory.readMaterial(result.resultRef, offset, limit, signal, pointer)
  assert.equal((await read(`${prefix}/rows/0/text`, 1, 2)).text, '😀')
  assert.equal((await read(`${prefix}/empty`)).text, '')
  assert.equal((await read(`${prefix}/nil`)).text, 'null')
  assert.equal((await read(`${prefix}/__proto__`)).text, 'own data')
  assert.equal((await read(`${prefix}/rows`)).text, JSON.stringify(value.rows))
  for (const pointer of ['', 'output', `${prefix}/~2`, '/'.repeat(4097)])
    await assert.rejects(read(pointer), { code: 'VALIDATION' })
  for (const pointer of [
    `${prefix}/missing`,
    `${prefix}/constructor`,
    `${prefix}/rows/01`,
    `${prefix}/rows/-`,
    `${prefix}/rows/length`,
  ])
    await assert.rejects(read(pointer), { code: 'NOT_FOUND' })
  for (const [offset, limit] of [
    [-1, 1],
    [0.5, 1],
    [0, 60001],
    [0, -1],
    [5, 1],
  ])
    await assert.rejects(read(`${prefix}/rows/0/text`, offset, limit), { code: 'INVALID_RANGE' })
})

test('archived field recall preserves authorization, cancellation and released original results', async (t) => {
  const f = await fixture(t)
  const result = await f.session.execute({
    source: `import {output} from 'velaros';output('saved evidence',{key:'source'});`,
  })
  const pointer = '/output/blocks/0/value'
  await f.memory.retainMaterial(result.resultRef, null, signal)
  assert.equal(
    (await f.memory.readMaterial(result.resultRef, 0, 100, signal, pointer)).text,
    'saved evidence'
  )
  await assert.rejects(
    f.memory.readMaterial({ sessionId: 'other', id: result.resultRef }, 0, 100, signal, pointer),
    { code: 'SCOPE_MISMATCH' }
  )
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(f.memory.readMaterial(result.resultRef, 0, 100, abort.signal, pointer), {
    name: 'AbortError',
  })
  const note = await f.memory.update({ key: 'note', baseRevision: 0, body: 'note body' }, signal)
  await assert.rejects(f.memory.readMaterial(note.ref, 0, 100, signal, '/body'), {
    code: 'VALIDATION',
  })
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'authorization changed',
  })
  await assert.rejects(f.memory.readMaterial(result.resultRef, 0, 100, signal, pointer), {
    code: 'SCOPE_MISMATCH',
  })
})
async function run(f, input = 'Continue') {
  const events = []
  for await (const event of f.session.submit(input)) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  return events
}

test('INV-65 real model requests retain completed job identities, historical output, and archive recall', async (t) => {
  const f = await fixture(t, async function* (request, call) {
    if (call <= 6) {
      yield turn(request, {
        execute: { source: `import {output} from 'velaros';output('job-${call}');` },
      })
      yield { type: 'finish', reason: 'stop' }
      return
    }
    const raw = JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)
    // 此前的帧留在对话里，增量帧的列表只列变化条目：按出现顺序合并各帧 runtime 段里展示的作业
    const sections = modelRequestEncoder
      .messages(request)
      .map((item) =>
        typeof item.content === 'string'
          ? item.content
          : item.content.map((part) => part.text ?? '').join('\n')
      )
      .flatMap((text) =>
        text
          .split('分区 runtime：\n')
          .slice(1)
          .map((part) => JSON.parse(part.split('\n')[0]))
      )
    const shownJobs = sections.flatMap((section) =>
      Array.isArray(section.jobs) ? section.jobs : (section.jobs?.changed ?? [])
    )
    assert(shownJobs.some((job) => job.representation === 'completed-jobs'))
    const expanded = new Map(
      shownJobs.flatMap((job) =>
        job.representation === 'completed-jobs'
          ? Object.entries(job.results).map(([executionId, resultRef]) => [
              executionId,
              { executionId, status: job.status, resultRef },
            ])
          : [[job.executionId, job]]
      )
    )
    const jobs = raw.partitions.runtime.jobs
    for (const job of jobs) assert.deepEqual(expanded.get(job.executionId), job)
    const results = historyEntries(request).filter(
      (item) => item.origin === 'runtime-execution' && item.bodyIncluded
    )
    assert.equal(jobs.length, 6)
    for (const job of jobs) {
      const result = results.find((item) => item.ref.id === job.resultRef)
      assert(result?.text.includes('job-'), 'the mapped result body must be in actual history')
      const original = await f.session.context.read(
        { sessionId: 's', id: job.resultRef },
        { limit: 6000 }
      )
      assert(original.text.includes('job-'), 'the original result remains independently recallable')
    }
    assert(JSON.stringify(modelRequestEncoder.messages(request)).includes('completed-jobs'))
    yield* done(request)
  })
  await run(f)
  assert.equal(f.requests.length, 7)
})

test('INV-64 only complete matching diagnostic snapshots replace dynamic detail, including after state changes', async (t) => {
  const f = await fixture(t)
  const execution = await f.session.execute(
    { source: "import {output} from 'velaros';output('selected output')" },
    'task'
  )
  const feedback = {
    id: 'call-1',
    executionId: execution.executionId,
    operation: 'test.check',
    outcome: 'succeeded',
    effect: 'committed',
    code: 'COMMAND_LOG',
    detail: 'UNIQUE_DIAGNOSTIC_BODY: stderr preserved independently of output.',
  }
  const view = {
    id: 'frame',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [feedback],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const project = (mandatory = [feedback], maxChars = 100000) =>
    f.memory.project({ ...view, mandatory }, undefined, [], signal, maxChars)
  const first = await project()
  const originalBody = first.history.find((item) => item.content.includes(feedback.detail))?.content
  assert(originalBody, 'full diagnostic must reach the model history')
  assert(!first.prompt.includes(feedback.detail))
  assert(first.prompt.includes('COMMAND_LOG') && first.prompt.includes('committed'))
  assert.equal(
    JSON.parse(first.body).partitions.runtime.mandatory[0].detail,
    feedback.detail,
    'audit retains original detail'
  )
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  for (const change of [
    { detail: 'UPDATED_DIAGNOSTIC_BODY' },
    { code: 'RECOVERED' },
    { effect: 'partial' },
    { effect: 'unknown' },
    { outcome: 'failed' },
    { id: 'different-call' },
  ]) {
    const updated = { ...feedback, ...change }
    const result = await project([updated])
    assert(
      result.prompt.includes(updated.detail),
      'changed feedback remains fully visible in current frame'
    )
    assert(
      result.history.some((item) => item.content === originalBody),
      'historical diagnostic is never rewritten'
    )
    assert.equal(JSON.parse(result.body).partitions.runtime.mandatory[0].detailInHistory, undefined)
  }
  const stable = await project()
  assert(stable.history.some((item) => item.content === originalBody))
  assert(!stable.prompt.includes(feedback.detail))
  const programs = new ProgramContext('s', f.session.context, f.storage)
  for (let index = 0; index < 6; index++) {
    await f.session.context.append({ kind: 'assistant', body: `step ${index} complete` })
    await archiveResult(f, programs, `result-${index}`)
  }
  assert(await f.memory.fold('runway', 100000, signal))
  const folded = await project()
  assert(
    folded.history.some((item) => item.content.includes(feedback.detail)),
    'carried results re-deliver complete diagnostics after folding'
  )
  assert(!folded.prompt.includes(feedback.detail))
  await programs.release(execution.resultRef, signal)
  const released = await project([{ ...feedback, effect: 'unknown' }])
  assert(
    !released.history.some((item) => item.content.includes(feedback.detail)),
    'released history no longer carries diagnostics'
  )
  assert(
    released.prompt.includes(feedback.detail),
    'unknown effects stay fully visible after release'
  )
  await f.session.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
  const reset = await project([])
  assert(
    !reset.history.some((item) => item.content.includes(feedback.detail)),
    'authorization reset retires prior diagnostic history'
  )
})

test('INV-64 legacy history and output text cannot claim independent diagnostic delivery', async (t) => {
  const f = await fixture(t)
  const detail = 'VERBATIM_DIAGNOSTIC_LIKE_OUTPUT'
  const execution = await f.session.execute(
    { source: `import {output} from 'velaros';output(${JSON.stringify(detail)})` },
    'task'
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
  const first = await f.memory.project(view, undefined, [], signal, 100000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const feedback = {
    id: 'late-call',
    executionId: execution.executionId,
    operation: 'test.check',
    outcome: 'failed',
    effect: 'committed',
    code: 'FAILED',
    detail,
  }
  const next = await f.memory.project(
    { ...view, mandatory: [feedback] },
    undefined,
    [],
    signal,
    100000
  )
  assert(next.history.some((item) => item.content.includes(detail)))
  assert(next.prompt.includes(detail), 'matching output text is not a diagnostic receipt')
  assert.equal(JSON.parse(next.body).partitions.runtime.mandatory[0].detailInHistory, undefined)
})

test('INV-64 zero history, absent result bodies, and oversized diagnostics keep complete dynamic feedback', async (t) => {
  for (const { recentRecords, omitted, large, unknown } of [
    { recentRecords: 0, omitted: false, large: false },
    { recentRecords: 8, omitted: false, large: true },
    { recentRecords: 8, omitted: true, large: false },
    { recentRecords: 8, omitted: false, large: false, unknown: true },
  ]) {
    const f = await fixture(t, undefined, { context: { sources: [], memory: { recentRecords } } })
    const execution = await f.session.execute(
      {
        source: `import {output} from 'velaros';${omitted ? 'output.configure({maxChars:0});' : ''}output('small')`,
      },
      'task'
    )
    const feedback = {
      id: 'oversized',
      executionId: execution.executionId,
      operation: 'test.check',
      outcome: 'succeeded',
      effect: unknown ? 'unknown' : 'committed',
      code: 'LOG',
      detail: `DIAGNOSTIC_UNDER_PRESSURE_${'x'.repeat(large ? 4000 : 10)}`,
    }
    const view = {
      id: 'frame',
      scope: { sessionId: 's', revision: 0 },
      goals: [],
      capsule: {},
      mandatory: [feedback],
      evidence: [],
      gaps: [],
      readSet: [],
      progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
    }
    const result = await f.memory.project(view, undefined, [], signal, 12000)
    assert(result.prompt.includes(feedback.detail))
    assert.equal(JSON.parse(result.body).partitions.runtime.mandatory[0].detailInHistory, undefined)
  }
})

test('INV-62 task text stays once in a stable chronological prefix while the frame carries current scope', async (t) => {
  const task =
    'TASK_BODY_UNIQUE: inspect the parser, preserve public API, and verify changes.\nKeep exact newlines and "quotes".'
  let prior = []
  const f = await fixture(t, async function* (request, call) {
    const taskMessage = request.history.find(
      (item) => typeof item.content === 'string' && item.content.includes(task)
    )
    assert(taskMessage, 'task text must enter actual model history')
    const messages = modelRequestEncoder.messages(request)
    const wire = messages
      .map((item) =>
        typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
      )
      .join('\n')
    assert.equal(wire.split(task).length - 1, 1, 'one literal task body reaches the model')
    assert(
      !request.compiledPrompt.includes('TASK_BODY_UNIQUE'),
      'task text must not be rewritten in the changing frame'
    )
    assert.equal(taskMessage.role, 'user')
    assert.equal(taskMessage.cacheBreakpoint, true)
    const history = request.history.map(({ role, content }) => ({ role, content }))
    assert.deepEqual(history.slice(0, prior.length), prior)
    prior = history
    const goal = JSON.parse(request.materials[0].text).partitions.task.goals.at(-1)
    assert.equal(goal.text, task, 'full task remains in the audit frame')
    assert.equal(goal.bodyInHistory, true)
    assert(!goal.earlier)
    if (call === 3) yield* done(request)
    else {
      yield turn(request, {
        execute: { source: `import {output} from 'velaros';output({step:${call}});` },
      })
      yield { type: 'finish', reason: 'stop' }
    }
  })
  await run(f, task)
  assert.equal(f.requests.length, 3)
})

test('INV-62 later user corrections follow earlier responses and task/reset boundaries exclude old bodies', async (t) => {
  const first = 'TASK_FIRST_UNIQUE: implement a parser'
  const correction = 'TASK_CORRECTION_UNIQUE: only inspect; preserve all files'
  const f = await fixture(t)
  await run(f, first)
  await run(f, correction)
  const request = f.requests.at(-1)
  const oldResponse = request.history.findIndex((item) => item.role === 'assistant')
  const oldTask = request.history.findIndex(
    (item) => typeof item.content === 'string' && item.content.includes(first)
  )
  const newTask = request.history.findIndex(
    (item) => typeof item.content === 'string' && item.content.includes(correction)
  )
  assert(
    oldTask >= 0 && oldTask < oldResponse && oldResponse < newTask,
    'user correction follows prior assistant response'
  )
  const goals = JSON.parse(request.materials[0].text).partitions.task.goals
  assert.equal(goals.find((goal) => goal.text === first).earlier, true)
  assert(!goals.find((goal) => goal.text === correction).earlier)
  await run(f, { task: 'new', text: 'TASK_NEW_UNIQUE: independent task' })
  const fresh = JSON.stringify(modelRequestEncoder.messages(f.requests.at(-1)))
  assert(!fresh.includes('TASK_FIRST_UNIQUE'))
  assert(!fresh.includes('TASK_CORRECTION_UNIQUE'))
  assert(fresh.includes('TASK_NEW_UNIQUE'))
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'authorization changed',
  })
  await run(f, 'TASK_AUTHORIZED_UNIQUE: current authorization')
  const reset = JSON.stringify(modelRequestEncoder.messages(f.requests.at(-1)))
  assert(!reset.includes('TASK_NEW_UNIQUE'))
  assert(reset.includes('TASK_AUTHORIZED_UNIQUE'))
})

test('INV-62 task excerpts retain their range and full original remains recallable', async (t) => {
  const task = `TASK_LONG_HEAD\n${'Preserve the documented parser behavior.\n'.repeat(700)}TASK_LONG_END`
  const f = await fixture(t, undefined, {
    limits: {
      turns: 4,
      outputTokens: 2048,
      safetyTokens: 1024,
      projectionChars: 6000,
      recoveryChars: 3000,
      timeoutMs: 20000,
    },
  })
  await run(f, task)
  const request = f.requests[0]
  const goal = JSON.parse(request.materials[0].text).partitions.task.goals.at(-1)
  assert.equal(goal.totalChars, task.length)
  assert(goal.text.length < goal.totalChars)
  const message = request.history.find(
    (item) => typeof item.content === 'string' && item.content.startsWith('Runtime 用户输入快照')
  )
  assert(message)
  const lines = message.content.split('\n')
  const meta = JSON.parse(lines[1])
  assert.deepEqual(meta.record.ref, goal.record.ref)
  assert.equal(meta.totalChars, task.length)
  assert.equal(meta.offset, goal.offset)
  assert.equal(meta.shownChars, goal.text.length)
  assert.equal(lines.slice(2).join('\n'), goal.text)
  assert(!request.compiledPrompt.includes('TASK_LONG_HEAD'))
  assert.equal(
    (await f.session.context.readInput(goal.record.ref, { limit: task.length })).text,
    task
  )
})

test('INV-62 reopening preserves task bytes while current-run status changes independently', async (t) => {
  const task = 'TASK_REOPEN_UNIQUE: preserve this exact input across restart'
  const f = await fixture(t)
  await run(f, task)
  const original = f.requests[0].history.find(
    (item) => typeof item.content === 'string' && item.content.includes(task)
  ).content
  await f.runtime.close()
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(f.root, 'context.sqlite') }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
    model: f.model,
  })
  try {
    f.session = await runtime.openSession('s')
    await run(f, 'TASK_REOPEN_NEW: inspect the previous result')
    const request = f.requests.at(-1)
    assert.equal(
      request.history.find(
        (item) => typeof item.content === 'string' && item.content.includes(task)
      ).content,
      original
    )
    assert.equal(
      JSON.parse(request.materials[0].text).partitions.task.goals.find((goal) => goal.text === task)
        .earlier,
      true
    )
  } finally {
    await runtime.close()
  }
})

test('INV-36 the latest script diagnostic survives body omission and clears after a repaired execution', async (t) => {
  const f = await fixture(
    t,
    async function* (request, call) {
      const frame = JSON.parse(request.materials[0].text)
      if (call === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {modules} from 'velaros:system';import {output} from 'velaros';const page=await modules.list();output(page.items.length;",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else if (call === 2) {
        assert(!frame.partitions.recent.results.at(-1).text.includes("')' expected"))
        const feedback = frame.partitions.runtime.progress.feedback
        assert.equal(feedback.failure.code, 'SCRIPT_CHECK')
        assert(feedback.failure.draftRef)
        assert.equal(feedback.ref, frame.partitions.recent.results.at(-1).ref)
        assert.match(request.compiledPrompt, /'\)' expected/)
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
  assert(frame.partitions.task.goals.every((goal) => !goal.bodyInHistory))
  assert.match(f.requests[0].compiledPrompt, /Continue/)
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

test('INV-52 current constraints and unresolved items remain separate from immutable history while task bodies stay chronological', async (t) => {
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
  const first = await f.session.context.append({
    kind: 'user',
    body: 'Build the parser\nwith every detail spelled out',
  })
  await f.session.view.begin(first.ref)
  await f.session.context.summarizeInput({
    ref: first.ref,
    summary: 'Build the parser',
    constraints: ['只用标准库', 'keep the API stable'],
    unresolved: [],
    baseRevision: 0,
  })
  const second = await f.session.context.append({ kind: 'user', body: 'Add tests for the parser' })
  await f.session.view.appendGoal(second.ref)
  const goals = [first, second]
  const view = async () => ({
    id: 'frame',
    scope: { sessionId: 's', revision: 0 },
    goals: await Promise.all(goals.map((goal) => f.session.context.projectInput(goal.ref, 2000))),
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  })
  const steps = async (count) => {
    for (let index = 0; index < count; index++) {
      await f.session.context.append({
        kind: 'assistant',
        body: `step ${index} done\n@@sX execute()\noutput(1)\n@@sX`,
      })
      await archiveResult(f, programs, `result-${index}`)
    }
  }
  await steps(6)
  const start = await memory.project(await view(), undefined, [], signal, 24000)
  assert.equal(JSON.parse(start.body).partitions.task.goals.length, 2)
  assert.equal(JSON.parse(start.body).partitions.task.folded.count, 0)
  assert(await memory.fold('runway', 24000, signal))
  const [older] = await recent.volumes(signal)
  await recent.narrate(
    older.ref,
    { summary: 'First volume', evidence: [], unresolved: ['U1', 'U2'], negativeAttempts: ['N1'] },
    signal
  )
  await steps(6)
  assert(await memory.fold('runway', 24000, signal))
  const third = await f.session.context.append({ kind: 'user', body: 'Now also support comments' })
  await f.session.view.appendGoal(third.ref)
  goals.push(third)
  const frame = await memory.project(await view(), undefined, [], signal, 24000)
  const base = frame.history[0].content
  assert.match(base, /否定尝试[^\n]*："?\["N1"\]/)
  const active = JSON.parse(frame.body).partitions.task.active
  assert.deepEqual(
    active.items.filter((item) => item.kind === 'question').map((item) => item.text),
    ['U1', 'U2']
  )
  assert.deepEqual(
    active.items.filter((item) => item.kind === 'constraint').map((item) => item.text),
    ['只用标准库', 'keep the API stable']
  )
  // 底座保留早期目标首行；选中的新目标正文按序进入历史，帧尾保留当前范围。
  assert.match(base, /Add tests for the parser[\s\S]*Build the parser/)
  assert.doesNotMatch(base, /every detail spelled out|support comments/)
  const task = JSON.parse(frame.body).partitions.task
  assert.deepEqual(
    task.goals.map((goal) => goal.record.ref.id),
    [third.ref.id]
  )
  assert.equal(task.folded.count, 2)
  assert(
    frame.history.some(
      (item) =>
        typeof item.content === 'string' && item.content.endsWith('Now also support comments')
    )
  )
  assert(!frame.prompt.includes('Now also support comments'))
  // 未解事项默认承接，逐项提供关闭证据才退出；否定尝试按有界索引累积。
  const [, newer] = await recent.volumes(signal)
  const attempts = Array.from({ length: 18 }, (_, index) => `X${index}`)
  await recent.narrate(
    newer.ref,
    {
      summary: 'Second volume',
      evidence: [],
      unresolved: ['U2', 'U3'],
      negativeAttempts: ['N2', 'N1', ...attempts],
    },
    signal
  )
  await steps(6)
  assert(await memory.fold('runway', 24000, signal))
  const nextFrame = await memory.project(await view(), undefined, [], signal, 24000)
  const next = nextFrame.history[0].content
  const narrative = (await recent.narratives(signal)).at(-1)
  assert(
    next.includes(
      `：${JSON.stringify(['N2', 'N1', ...attempts.slice(0, 14)])}；另有 4 条没有列出，出处`
    )
  )
  assert(next.includes(narrative.ref.id))
  assert.deepEqual(
    JSON.parse(nextFrame.body)
      .partitions.task.active.items.filter((item) => item.kind === 'question')
      .map((item) => item.text),
    ['U1', 'U2', 'U3']
  )
})

test('INV-54 rereading material squeezed to a reference in the last frame is a fault, and folding adjusts the note share by faults', async (t) => {
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
  // 三份笔记都比笔记份额大，底座里只给引用
  const notes = []
  for (const key of ['alpha', 'beta', 'gamma'])
    notes.push(await memory.update({ key, baseRevision: 0, body: `${key} `.repeat(1500) }, signal))
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
  const deliver = async () => {
    const frame = await memory.project(view, undefined, [], signal, 24000)
    await memory.acknowledge(JSON.parse(frame.body).frameId, signal)
    return frame
  }
  const steps = async (count) => {
    for (let index = 0; index < count; index++) {
      await f.session.context.append({
        kind: 'assistant',
        body: `step ${index} done\n@@sX execute()\noutput(1)\n@@sX`,
      })
      await archiveResult(f, programs, `result-${index}`)
    }
  }
  const faults = async () =>
    (await f.storage.load('s')).records.filter((record) =>
      record.title.startsWith('context:fault:')
    )
  await deliver()
  await memory.readMaterial(notes[0].ref, 0, 100, signal)
  await memory.readMaterial(notes[0].ref, 0, 100, signal)
  assert.equal((await faults()).length, 1)
  assert.match((await faults())[0].title, /:workspace$/)
  // 正文本来就在请求里的材料读回来不算缺页
  const [input] = (await f.storage.load('s')).records.filter((record) => record.kind === 'user')
  await memory.readMaterial(input.ref, 0, 100, signal)
  assert.equal((await faults()).length, 1)
  await memory.readMaterial(notes[1].ref, 0, 100, signal)
  const reported = await deliver()
  assert.equal(reported.segment.faults, 2)
  assert.equal(JSON.parse(reported.body).memoryStatus.faults.count, 2)
  // 笔记缺页多：下一段的笔记份额提高一步；之后安静的一段回落到宿主配置
  await steps(6)
  assert(await memory.fold('runway', 24000, signal))
  assert.equal((await recent.segment(signal)).workspaceShare, 0.25)
  await deliver()
  await steps(6)
  assert(await memory.fold('runway', 24000, signal))
  assert.equal((await recent.segment(signal)).workspaceShare, 0.2)
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

test('INV-68 full required blocks in the actual frozen history satisfy a smaller current projection', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const values = ['first required fact\n'.repeat(140), 'second required fact\n'.repeat(130)]
  const executed = await f.session.execute(
    {
      source: `import {output} from 'velaros';output.configure({maxChars:20000});${values.map((value, index) => `output(${JSON.stringify(value)},{key:'required_${index}',type:'text',required:true,view:{mode:'full'}});`).join('')}`,
    },
    'task'
  )
  assert(executed.checked)
  const view = (await f.session.view.inspect()).view
  const first = await f.memory.project(view, undefined, [], signal, 600000)
  const initial = JSON.parse(first.body)
  assert.deepEqual(initial.partitions.runtime.decision.missing, [])
  const original = historyEntries(first).find((entry) => entry.ref?.id === executed.resultRef)
  assert(original)
  for (const value of values) assert(original.text.includes(value))
  await f.memory.acknowledge(initial.frameId, signal)
  const next = await f.memory.project(view, undefined, [], signal, 20000)
  assert.deepEqual(JSON.parse(next.body).partitions.runtime.decision.missing, [])
  const retained = historyEntries(next).find((entry) => entry.ref?.id === executed.resultRef)
  assert.equal(retained.text, original.text)
  assert.equal(f.requests.length, 0)
  assert((await programs.state()).leases.some((lease) => lease.ref === executed.resultRef))
})

async function archiveRequired(f, programs, values, maxChars = 20000) {
  const id = crypto.randomUUID()
  const source = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}`,
    body: JSON.stringify({ source: 'output(1)' }),
  })
  const result = await f.session.context.append({
    kind: 'audit',
    title: `script:${id}:result`,
    body: JSON.stringify({
      mode: 'execute',
      output: {
        config: { maxChars },
        issues: [],
        blocks: values.map((value, index) => ({
          key: `required_${index}`,
          value,
          chars: JSON.stringify(value).length,
          options: {
            key: `required_${index}`,
            type: 'text',
            required: true,
            view: { mode: 'full' },
          },
        })),
      },
    }),
    sources: [source.ref],
  })
  await programs.add(result.ref, source.ref, id, 'task')
  return result.ref
}

function requiredView() {
  return {
    id: 'synthetic-required',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
}

test('INV-69 required recall transfers whole-block proof only with a fully delivered unchanged page object', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const value = 'source-bound recall evidence\n'.repeat(80)
  const source = await archiveRequired(f, programs, [value], 512)
  const before = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  assert(
    JSON.parse(before.body).partitions.runtime.decision.missing.some((gap) => gap.ref === source.id)
  )
  await f.memory.acknowledge(JSON.parse(before.body).frameId, signal)
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const carrier = await archiveRequired(f, programs, [page])
  const after = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  assert(
    historyEntries(after)
      .find((entry) => entry.ref?.id === carrier.id)
      .text.includes(value.split('\n')[0])
  )
  assert.deepEqual(JSON.parse(after.body).partitions.runtime.decision.missing, [])
  assert(page.delivery?.receipt)
})

test('INV-69 required recall through a real script reaches the next model request and completion gate', async (t) => {
  for (const scenario of ['complete', 'partial', 'truncated']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(
        f,
        programs,
        ['verified synthetic source\n'.repeat(20)],
        512
      )
      const executed = await f.session.execute(
        {
          source: `import {output} from 'velaros';import {memory} from 'velaros:system';output.configure({maxChars:${scenario === 'truncated' ? 512 : 12000}});const page=await memory.read({ref:${JSON.stringify(source.id)},pointer:'/output/blocks/0/value',limit:${scenario === 'partial' ? 100 : 12000}});output(page,{key:'recalled',view:{mode:'full'}});`,
        },
        'task'
      )
      assert(executed.checked)
      assert(!executed.result?.failed)
      const events = []
      for await (const event of f.session.submit('Finish the synthetic task.')) events.push(event)
      const request = f.requests[0]
      const frame = JSON.parse(
        request.materials.find((material) => material.origin === 'runtime-view').text
      )
      if (scenario === 'complete') {
        const shown = historyEntries(request).find((entry) => entry.ref?.id === executed.resultRef)
        assert(shown)
        const lines = shown.text.split('\n')
        assert.equal(JSON.parse(lines[1]).representation, 'full')
        const header = JSON.parse(lines[2])
        assert.equal(header.encoding, 'memory-page')
        const shownPage = { ...header.page, text: lines.slice(3).join('\n') }
        assert.equal(shownPage.text, 'verified synthetic source\n'.repeat(20))
        assert.equal(header.textChars, shownPage.text.length)
        assert.equal(shownPage.offset, 0)
        assert.equal(shownPage.totalChars, shownPage.text.length)
        assert(shownPage.delivery.receipt)
      }
      assert.equal(
        frame.partitions.runtime.decision.missing.some((gap) => gap.ref === source.id),
        scenario !== 'complete'
      )
      if (scenario === 'complete') {
        assert(
          historyEntries(request).some(
            (entry) =>
              entry.ref?.id === executed.resultRef &&
              entry.text.includes('verified synthetic source')
          )
        )
        assert(events.some((event) => event.type === 'verification' && event.completed))
      } else {
        assert(
          events.some(
            (event) => event.type === 'verification' && event.reason === 'CONTEXT_REQUIRED'
          )
        )
        const missing = frame.partitions.runtime.decision.missing.find(
          (gap) => gap.ref === source.id
        )
        assert.deepEqual(missing.read, { ref: source.id, pointer: '/output/blocks/0/value' })
        assert(frame.partitions.runtime.decision.recall.includes('output(page'))
      }
    })
  }
})

test('INV-69 required recall receipts are bounded metadata and ordinary reads create none', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const note = await f.memory.update(
    { key: 'memo', baseRevision: 0, body: 'ordinary note' },
    signal
  )
  assert.equal((await f.memory.readMaterial(note.ref, 0, 1000, signal)).delivery, undefined)
  const ordinary = await archiveResult(f, programs, 'ordinary result')
  assert.equal((await f.memory.readMaterial(ordinary, 0, 1000, signal)).delivery, undefined)
  const source = await archiveRequired(f, programs, ['evidence\n'.repeat(1000)], 512)
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const records = (await f.storage.load('s')).records.filter(
    (record) => record.title === 'memory:read-delivery'
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].ref.id, page.delivery.receipt.id)
  assert.deepEqual(records[0].sources, [source])
  const raw = await f.storage.get('s', records[0].objectId)
  assert(raw.length < 1000)
  assert(!raw.includes('evidence'))
})

test('INV-69 required recall cannot mint current authority from a read interrupted by reset', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const source = await archiveRequired(f, programs, ['authorized evidence\n'.repeat(50)], 512)
  const original = (await f.storage.load('s')).records.find((record) => record.ref.id === source.id)
  const get = f.storage.get.bind(f.storage)
  let reset
  f.storage.get = async (session, objectId) => {
    if (!reset && objectId === original.objectId) {
      reset = true
      await f.session.context.append({
        kind: 'audit',
        title: 'search:history-reset',
        body: 'concurrent new scope',
      })
    }
    return get(session, objectId)
  }
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  f.storage.get = get
  assert(reset)
  await f.session.context.append({
    kind: 'user',
    body: 'Explicitly reattach the same source in the new scope.',
    sources: [source],
  })
  const carrier = await archiveRequired(f, programs, [page])
  const projected = JSON.parse(
    (await programs.project(requiredView(), undefined, [], signal, 600000)).body
  )
  assert(
    !projected.results
      .find((result) => result.ref === carrier.id)
      .outputProofs.some((proof) => proof.ref === source.id)
  )
  // A fresh authorized read in the new scope can provide a new valid proof.
  const current = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const freshCarrier = await archiveRequired(f, programs, [current])
  const refreshed = JSON.parse(
    (await programs.project(requiredView(), undefined, [], signal, 600000)).body
  )
  assert(
    refreshed.results
      .find((result) => result.ref === freshCarrier.id)
      .outputProofs.some((proof) => proof.ref === source.id)
  )
})

test('INV-69 required recall rejects forged, cross-session, changed, nested, bare and truncated carriers', async (t) => {
  for (const scenario of [
    'forged',
    'cross-session',
    'text',
    'record',
    'range',
    'nested',
    'bare',
    'truncated',
    'partial-pointer',
    'read-only',
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(
        f,
        programs,
        [{ value: 'bound original\n'.repeat(80), status: 'ok' }],
        512
      )
      const pointer =
        scenario === 'partial-pointer' ? '/output/blocks/0/value/value' : '/output/blocks/0/value'
      const page = await f.memory.readMaterial(source, 0, 12000, signal, pointer)
      if (scenario === 'forged') page.delivery.receipt = source
      if (scenario === 'cross-session') page.delivery.receipt.sessionId = 'other-session'
      if (scenario === 'text') page.text += 'tampered'
      if (scenario === 'record') page.record.ref.id = 'other-result'
      if (scenario === 'range') page.offset = 1
      if (scenario !== 'read-only')
        await archiveRequired(
          f,
          programs,
          [scenario === 'bare' ? page.text : scenario === 'nested' ? { page } : page],
          scenario === 'truncated' ? 512 : 20000
        )
      const frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      assert(
        JSON.parse(frame.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
    })
  }
})

test('INV-69 required recall unions only delivered pages of one complete block or archive representation', async (t) => {
  for (const pointer of [undefined, '/output/blocks/0/value']) {
    await t.test(pointer ?? 'whole archive', async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(
        f,
        programs,
        [{ value: 'Unicode 文本😀\n'.repeat(90), status: 'ok' }],
        512
      )
      const first = await f.memory.readMaterial(source, 0, 700, signal, pointer)
      const firstCarrier = await archiveRequired(f, programs, [first])
      let frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      await f.memory.acknowledge(JSON.parse(frame.body).frameId, signal)
      assert(
        JSON.parse(frame.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      // An overlapping range is allowed, but the one-character hole still blocks completion.
      const hole = await f.memory.readMaterial(source, 701, 12000, signal, pointer)
      await archiveRequired(f, programs, [hole])
      frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      assert(
        JSON.parse(frame.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      const fill = await f.memory.readMaterial(source, 699, 2, signal, pointer)
      const fillCarrier = await archiveRequired(f, programs, [fill])
      frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      assert.deepEqual(JSON.parse(frame.body).partitions.runtime.decision.missing, [])
      await f.memory.acknowledge(JSON.parse(frame.body).frameId, signal)
      assert(!JSON.stringify(JSON.parse(frame.body).partitions).includes('outputProofs'))
      await programs.release(fillCarrier.id, signal)
      frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      assert(
        JSON.parse(frame.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      await programs.release(firstCarrier.id, signal)
      assert.equal(f.requests.length, 0)
    })
  }
})

test('INV-69 required recall proof follows the actual retained carrier and never changes another source', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const source = await archiveRequired(f, programs, ['original\n'.repeat(90)], 512)
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const carrier = await archiveRequired(f, programs, [page])
  const other = await archiveRequired(f, programs, ['original\n'.repeat(90)], 512)
  const changed = await archiveRequired(f, programs, ['changed\n'.repeat(90)], 512)
  const frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  const gaps = JSON.parse(frame.body).partitions.runtime.decision.missing
  assert(!gaps.some((gap) => gap.ref === source.id))
  assert(gaps.some((gap) => gap.ref === other.id))
  assert(gaps.some((gap) => gap.ref === changed.id))
  await f.memory.acknowledge(JSON.parse(frame.body).frameId, signal)
  const retained = await f.memory.project(requiredView(), undefined, [], signal, 20000)
  assert(
    !JSON.parse(retained.body).partitions.runtime.decision.missing.some(
      (gap) => gap.ref === source.id
    )
  )
  assert.equal(
    historyEntries(frame).find((entry) => entry.ref?.id === carrier.id).text,
    historyEntries(retained).find((entry) => entry.ref?.id === carrier.id).text
  )
  const segment = await recent.segment(signal)
  // 租约结束但冻结正文仍在历史里时，证明跟着实际载体保留；退成引用卡后证明随之消失
  const kept = await recent.project(segment, [], 0, signal)
  assert(kept.items.some((item) => item.outputProofs?.length))
  const omitted = await recent.project({ ...segment, entries: [] }, [], 0, signal)
  assert(!omitted.items.some((item) => item.outputProofs?.length))
  for (let index = 0; index < 12; index++)
    await f.session.context.append({ kind: 'assistant', body: `synthetic step ${index}` })
  assert(await f.memory.fold('runway', 20000, signal))
  const folded = await f.memory.project(requiredView(), undefined, [], signal, 20000)
  assert(
    JSON.parse(folded.body).partitions.runtime.decision.missing.some((gap) => gap.ref === source.id)
  )
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'new authorization epoch',
  })
  // Reintroducing the archived page after a reset cannot revive its prior-epoch receipt.
  await archiveRequired(f, programs, [page])
  const reset = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  const resetHistory = await recent.project(
    await recent.segment(signal),
    JSON.parse((await programs.project(requiredView(), undefined, [], signal, 600000)).body)
      .results,
    600000,
    signal
  )
  assert(
    resetHistory.items.every((item) => !item.outputProofs?.some((proof) => proof.ref === source.id))
  )
  assert(!JSON.stringify(JSON.parse(reset.body).partitions).includes('outputProofs'))
})

test('INV-68 only matching block proof clears a gap and mixed full/reference output remains honest', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const ref = await archiveRequired(
    f,
    programs,
    ['small fact', 'large evidence\n'.repeat(1000)],
    2000
  )
  const view = requiredView()
  const first = await f.memory.project(view, undefined, [], signal, 600000)
  const initial = JSON.parse(first.body)
  assert.deepEqual(
    initial.partitions.runtime.decision.missing.map((gap) => gap.key),
    ['required_1']
  )
  await f.memory.acknowledge(initial.frameId, signal)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const segment = await recent.segment(signal)
  const entry = segment.entries.find((item) => item.ref === ref.id)
  assert.deepEqual(
    entry.outputProofs.map((proof) => proof.key),
    ['required_0']
  )
  const next = await f.memory.project(view, undefined, [], signal, 1000)
  assert.deepEqual(
    JSON.parse(next.body).partitions.runtime.decision.missing.map((gap) => gap.key),
    ['required_1']
  )
  assert(!JSON.stringify(JSON.parse(next.body).partitions).includes('outputProofs'))
  for (const changed of [
    { ...entry, outputProofs: undefined },
    {
      ...entry,
      outputProofs: entry.outputProofs.map((proof) => ({ ...proof, ref: 'another-ref' })),
    },
    {
      ...entry,
      outputProofs: entry.outputProofs.map((proof) => ({ ...proof, contentHash: 'another-hash' })),
    },
    {
      ...entry,
      outputProofs: entry.outputProofs.map((proof) => ({ ...proof, key: 'another-key' })),
    },
  ]) {
    await recent.commit(
      {
        ...segment,
        entries: segment.entries.map((item) => (item.ref === ref.id ? changed : item)),
      },
      signal
    )
    const mismatch = await f.memory.project(view, undefined, [], signal, 1000)
    assert.deepEqual(
      JSON.parse(mismatch.body).partitions.runtime.decision.missing.map((gap) => gap.key),
      ['required_0', 'required_1']
    )
    assert.equal(
      historyEntries(mismatch).find((item) => item.ref?.id === ref.id).text,
      historyEntries(first).find((item) => item.ref?.id === ref.id).text
    )
  }
})

test('INV-68 equal text under another result identity does not satisfy an unseen required block', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const value = 'identical original\n'.repeat(100)
  const firstRef = await archiveRequired(f, programs, [value])
  let view = requiredView()
  const first = await f.memory.project(view, undefined, [], signal, 600000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const secondRef = await archiveRequired(f, programs, [value], 0)
  view = requiredView()
  const next = await f.memory.project(view, undefined, [], signal, 600000)
  const gaps = JSON.parse(next.body).partitions.runtime.decision.missing
  assert(gaps.some((gap) => gap.ref === secondRef.id))
  assert(!gaps.some((gap) => gap.ref === firstRef.id))
  assert(
    historyEntries(next)
      .find((item) => item.ref?.id === firstRef.id)
      .text.includes(value)
  )
})

test('INV-68 a matching history block cannot clear a non-display completion requirement', async (t) => {
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
  const value = 'complete required block\n'.repeat(100)
  const ref = await archiveRequired(f, programs, [value])
  const view = requiredView()
  const first = await memory.project(view, undefined, [], signal, 600000)
  await memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const project = programs.project.bind(programs)
  programs.project = async (...args) => {
    const result = await project(...args)
    const body = JSON.parse(result.body)
    body.decision.missing.push({
      ref: ref.id,
      key: 'required_0',
      contentHash: scriptOutputs.hash(value),
      reason: 'not-produced',
    })
    return { ...result, body: JSON.stringify(body) }
  }
  const next = await memory.project(view, undefined, [], signal, 600000)
  assert.deepEqual(JSON.parse(next.body).partitions.runtime.decision.missing, [
    { ref: ref.id, key: 'required_0', reason: 'not-produced' },
  ])
})

test('INV-68 zero history, released references, folded bodies and authorization reset carry no stale proof', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const value = 'required original\n'.repeat(200)
  const ref = await archiveRequired(f, programs, [value])
  const view = requiredView()
  const first = await f.memory.project(view, undefined, [], signal, 600000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const segment = await recent.segment(signal)
  assert(segment.entries.find((item) => item.ref === ref.id).outputProofs.length)
  const noHistory = new ContextMemory(
    's',
    f.session.context,
    f.storage,
    f.session.view,
    programs,
    recent,
    { recentRecords: 0 }
  )
  const omitted = await noHistory.project(view, undefined, [], signal, 20000)
  assert(
    JSON.parse(omitted.body).partitions.runtime.decision.missing.some((gap) => gap.ref === ref.id)
  )
  assert(!omitted.history.some((message) => message.content.includes(value)))
  // 租约结束后冻结正文仍逐字在历史里，证明随实际正文保留
  const kept = await recent.project(segment, [], 2000, signal)
  assert.equal(kept.items.find((item) => item.ref === ref.id).bodyIncluded, true)
  // 容量不足退成引用卡后不再带证明
  const reference = await recent.project(
    { ...segment, entries: segment.entries.filter((item) => item.ref !== ref.id) },
    [],
    2000,
    signal
  )
  const card = reference.items.find((item) => item.ref === ref.id)
  assert.equal(card.bodyIncluded, false)
  assert.equal(card.outputProofs, undefined)
  for (let index = 0; index < 12; index++)
    await f.session.context.append({ kind: 'assistant', body: `synthetic step ${index}` })
  assert(await f.memory.fold('runway', 20000, signal))
  const folded = await f.memory.project(view, undefined, [], signal, 20000)
  assert(
    JSON.parse(folded.body).partitions.runtime.decision.missing.some((gap) => gap.ref === ref.id)
  )
  assert(!historyEntries(folded).some((entry) => entry.text.includes(value)))
  await programs.release(ref.id, signal)
  const released = await recent.project(await recent.segment(signal), [], 2000, signal)
  assert(released.items.every((item) => !item.outputProofs?.length))
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: 'synthetic authorization boundary',
  })
  const reset = await recent.project(segment, [{ ref: ref.id }], 2000, signal)
  assert(reset.items.every((item) => !item.outputProofs?.length))
})

test('INV-58 text output leaves frozen legacy history byte-identical and renders new entries directly', async (t) => {
  const f = await fixture(t)
  const recent = new RecentContext('s', f.session.context, f.storage)
  const value = 'alpha("beta");\n'.repeat(40)
  const capture = {
    config: {},
    issues: [],
    blocks: [
      {
        key: 'sample',
        value,
        chars: JSON.stringify(value).length,
        options: { key: 'sample', type: 'code', view: { mode: 'full' } },
      },
    ],
  }
  const append = async () => {
    const id = crypto.randomUUID()
    return f.session.context.append({
      kind: 'audit',
      title: `script:${id}:result`,
      body: JSON.stringify({ mode: 'execute', output: capture }),
    })
  }
  const archived = await append()
  const base = await f.session.context.append({
    kind: 'audit',
    title: 'context:segment-body',
    body: 'base',
  })
  const segment = {
    id: 'compatibility',
    index: 1,
    revision: 1,
    from: 0,
    base: { objectId: base.objectId, chars: 4 },
    carried: [],
    notes: [],
    entries: [],
    objective: '',
    goals: 1,
    policy: null,
    volumes: 0,
    reason: 'initial',
    narrate: null,
  }
  const legacy = scriptOutputs.project(capture, archived.ref.id, 900)
  const text = scriptOutputs.project(
    capture,
    archived.ref.id,
    900,
    undefined,
    undefined,
    undefined,
    'text'
  )
  assert.equal(legacy.blocks[0].representation, 'reference')
  assert.equal(text.blocks[0].representation, 'full')
  const first = await recent.project(
    segment,
    [{ ref: archived.ref.id, structuredOutput: true, text: legacy.prompt }],
    2400,
    signal
  )
  const frozen = first.messages[0].content
  assert(frozen.includes(memoryOutput(legacy.prompt)))
  assert(!frozen.includes(value))
  const second = await recent.project(
    { ...segment, entries: first.fresh },
    [{ ref: archived.ref.id, structuredOutput: true, outputFormat: 'text', text: text.prompt }],
    2400,
    signal
  )
  assert.equal(second.messages[0].content, frozen)
  assert.equal(second.fresh.length, 0)
  const next = await append()
  const nextProjection = scriptOutputs.project(
    capture,
    next.ref.id,
    900,
    undefined,
    undefined,
    undefined,
    'text'
  )
  const third = await recent.project(
    { ...segment, entries: first.fresh },
    [
      { ref: archived.ref.id, structuredOutput: true, outputFormat: 'text', text: text.prompt },
      {
        ref: next.ref.id,
        structuredOutput: true,
        outputFormat: 'text',
        text: nextProjection.prompt,
      },
    ],
    2400,
    signal
  )
  assert.equal(third.messages[0].content, frozen)
  assert(third.messages[1].content.endsWith(nextProjection.prompt))
  assert(third.messages[1].content.includes(value))
  assert(third.messages.every((message) => message.content.length <= 2400))
  assert.equal(
    JSON.parse(await f.storage.get('s', archived.objectId)).output.blocks[0].value,
    value
  )
  assert.equal(f.requests.length, 0, 'projection does not start any model request')
})

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
  assert.equal(frame.partitions.observation.presentation.format, 'text')
  assert.equal(frame.partitions.observation.blocks[0].representation, 'full')
  assert(frame.partitions.observation.text.endsWith(observed))
})

test('INV-69 current original bodies are omitted only after same-request cross-carrier full coverage', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const value = 'N_SOURCE_EVIDENCE "unicode界😀"\n'.repeat(90)
  const source = await archiveRequired(f, programs, [value], 20000)
  const before = await f.memory.project(requiredView(), undefined, [], signal, 10000)
  assert(
    JSON.parse(before.body).partitions.runtime.decision.missing.some((gap) => gap.ref === source.id)
  )
  await f.memory.acknowledge(JSON.parse(before.body).frameId, signal)
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const carrier = await archiveRequired(f, programs, [page], 20000)
  const after = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  assert(
    historyEntries(after)
      .find((entry) => entry.ref?.id === carrier.id)
      .text.includes('N_SOURCE_EVIDENCE')
  )
  const body = JSON.parse(after.body)
  assert.deepEqual(body.partitions.runtime.decision.missing, [])
  const original = body.partitions.recent.results.find((item) => item.ref === source.id)
  assert(
    !original.text?.includes('N_SOURCE_EVIDENCE'),
    'already delivered original body must not repeat in current frame'
  )
})

test('INV-69 validated complete page uses bounded verbatim text without JSON escaping again', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const value = '"\\\n'.repeat(1500)
  const source = await archiveRequired(f, programs, [value], 512)
  const first = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  await f.memory.acknowledge(JSON.parse(first.body).frameId, signal)
  const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
  const carrier = await archiveRequired(f, programs, [page], 8000)
  const after = await f.memory.project(requiredView(), undefined, [], signal, 600000)
  const entry = historyEntries(after).find((item) => item.ref?.id === carrier.id)
  assert(
    entry.text.includes(value),
    'actual delivered page must carry verbatim original characters'
  )
  assert.deepEqual(JSON.parse(after.body).partitions.runtime.decision.missing, [])
  assert.equal(
    (await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')).text,
    value
  )
})

test('INV-69 cross-carrier omission preserves other blocks, other refs and selected views', async (t) => {
  for (const scenario of ['mixed-blocks', 'same-value-other-ref', 'selected-view']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const first = 'COVERED_FIRST "界😀"\n'.repeat(85)
      const second = 'KEEP_SECOND_NEW_CONTENT\n'.repeat(85)
      const source = await archiveRequired(f, programs, [first, second], 40000)
      const other =
        scenario === 'same-value-other-ref'
          ? await archiveRequired(f, programs, [first], 40000)
          : undefined
      const initial = await f.memory.project(requiredView(), undefined, [], signal, 10000)
      await f.memory.acknowledge(JSON.parse(initial.body).frameId, signal)
      const page = await f.memory.readMaterial(source, 0, 12000, signal, '/output/blocks/0/value')
      await archiveRequired(f, programs, [page], 20000)
      if (scenario === 'selected-view') {
        // Host injection isolates an explicitly selected view without mutating the immutable archive.
        const originalProject = programs.project.bind(programs)
        programs.project = async (...args) => {
          const frame = await originalProject(...args)
          return {
            ...frame,
            outputCoverage: frame.outputCoverage.map((item) =>
              item.ref === source.id ? { ...item, keys: [] } : item
            ),
          }
        }
      }
      const recent = new RecentContext('s', f.session.context, f.storage)
      const memory = new ContextMemory(
        's',
        f.session.context,
        f.storage,
        f.session.view,
        programs,
        recent
      )
      const frame = await memory.project(requiredView(), undefined, [], signal, 600000)
      const body = JSON.parse(frame.body)
      const shown = body.partitions.recent.results.find((item) => item.ref === source.id)
      assert.equal(shown.text.includes('COVERED_FIRST'), scenario === 'selected-view')
      assert(shown.text.includes('KEEP_SECOND_NEW_CONTENT'))
      assert.equal(
        shown.bodyInHistory,
        undefined,
        'partial coverage cannot claim the entire result is in history'
      )
      if (other)
        assert(
          body.partitions.recent.results
            .find((item) => item.ref === other.id)
            .text.includes('COVERED_FIRST')
        )
      for (const hostField of [
        'outputCoverage',
        'outputProofs',
        'materialCoverage',
        'outputFingerprint',
      ]) {
        assert(!frame.prompt.includes(hostField))
        assert(!JSON.stringify(frame.history).includes(hostField))
      }
    })
  }
})

test('INV-69 a partial or retired carrier cannot remove newly available current source content', async (t) => {
  for (const scenario of ['range-hole', 'small-carrier-budget', 'released']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const value = 'KEEP_ORIGINAL_WITHOUT_FULL_COVERAGE\n'.repeat(90)
      const source = await archiveRequired(f, programs, [value], 20000)
      const initial = await f.memory.project(requiredView(), undefined, [], signal, 10000)
      await f.memory.acknowledge(JSON.parse(initial.body).frameId, signal)
      const page = await f.memory.readMaterial(
        source,
        0,
        scenario === 'range-hole' ? 500 : 12000,
        signal,
        '/output/blocks/0/value'
      )
      const carrier = await archiveRequired(
        f,
        programs,
        [page],
        scenario === 'small-carrier-budget' ? 512 : 20000
      )
      if (scenario === 'released') await programs.release(carrier.id, signal)
      const frame = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      const current = JSON.parse(frame.body).partitions.recent.results.find(
        (item) => item.ref === source.id
      )
      assert(current.text.includes(value))
      assert.equal(current.bodyInHistory, undefined)
    })
  }
})

/** 增量帧测试用的最小分区材料；只放渲染用到的字段。 */
function frameBody(overrides = {}) {
  const base = {
    schemaVersion: 2,
    id: 'frame',
    frameId: 'frame-id',
    partitions: {
      task: { active: { revision: 0, items: [] }, goals: [], folded: { count: 0, through: 0 } },
      workspace: { capsule: {}, notes: [], snapshot: { notes: 0 }, omitted: 0 },
      observation: { sourceRef: null, source: '', text: '' },
      recent: { historyState: { segment: 1, records: 2 }, results: [] },
      runtime: {
        environment: { os: 'linux x64', shell: 'posix', time: 'T1' },
        mandatory: [
          {
            id: 'call-1',
            executionId: 'e1',
            operation: 'shell.run',
            outcome: 'succeeded',
            effect: 'none',
          },
        ],
        jobs: [],
        programFrame: { id: 'p1', completedTurns: 1 },
      },
    },
    memoryStatus: { footprint: { task: 10 }, policy: { recentRecords: 8 }, advice: 'fixed' },
  }
  const merged = structuredClone(base)
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.')
    let target = merged
    for (const key of keys.slice(0, -1)) target = target[key]
    target[keys.at(-1)] = value
  }
  return JSON.stringify(merged)
}

test('INV-74 delta frames list only changed partitions, fields and entries against the retained previous frame', () => {
  const result = (text, extra = {}) => ({
    ref: 'r1',
    remainingTurns: 'task',
    bodyIncluded: true,
    structuredOutput: true,
    outputFormat: 'text',
    source: 'output(read())',
    text,
    ...extra,
  })
  const previous = frameBody({
    'partitions.recent.results': [
      result('{"omittedBlocks":0,"displayChars":900}\n{"key":"a"}\nBODY-A'),
      { ref: 'r2', remainingTurns: 1, bodyIncluded: true, text: 'OLD-RESULT' },
    ],
  })
  const current = frameBody({
    'partitions.recent.results': [
      // 只是整帧余量带来的 displayChars 不同，模型读到的正文相同
      result('{"omittedBlocks":0,"displayChars":700}\n{"key":"a"}\nBODY-A', { remainingTurns: 3 }),
      { ref: 'r3', remainingTurns: 2, bodyIncluded: true, text: 'NEW-RESULT' },
    ],
    'partitions.recent.historyState': { segment: 1, records: 4 },
    'partitions.runtime.environment': { os: 'linux x64', shell: 'posix', time: 'T2' },
    'partitions.runtime.mandatory': [
      {
        id: 'call-1',
        executionId: 'e1',
        operation: 'shell.run',
        outcome: 'succeeded',
        effect: 'none',
      },
      {
        id: 'call-2',
        executionId: 'e2',
        operation: 'project.edit',
        outcome: 'failed',
        effect: 'none',
        code: 'TARGET_NOT_FOUND',
      },
    ],
    'partitions.runtime.programFrame': { id: 'p2', completedTurns: 2 },
    'memoryStatus.footprint': { task: 12 },
  })
  const full = memoryPrompt(current)
  assert.match(full, /^Runtime 本帧工作内存（origin=runtime-view）；/)
  assert.match(full, /BODY-A/)
  const delta = memoryPrompt(current, previous)
  assert.match(delta, /^Runtime 本帧工作内存（origin=runtime-view，增量）/)
  // 未变的分区和静态说明不再重发
  assert(!delta.includes('分区 task'))
  assert(!delta.includes('分区 workspace'))
  assert(!delta.includes('分区 observation'))
  assert(!delta.includes('grouped-receipts'))
  // 同一结果正文相同：只列变化的元数据，不重发源码与正文；新结果完整给出；退出的列出引用
  assert(!delta.includes('BODY-A'))
  assert(!delta.includes('output(read())'))
  assert.match(delta, /"remainingTurns":3/)
  assert.match(delta, /（当次源码与展示正文同此前帧）/)
  assert.match(delta, /NEW-RESULT/)
  assert.match(delta, /退出帧尾展示的结果：\["r2"\]/)
  // runtime 只列变化字段：环境只剩变化的时间，回执列表只列新增条目并给出总数
  const runtime = JSON.parse(delta.split('分区 runtime：\n')[1].split('\n')[0])
  assert.deepEqual(runtime.environment, { time: 'T2' })
  assert.deepEqual(
    runtime.mandatory.changed.map((item) => item.id),
    ['call-2']
  )
  assert.equal(runtime.mandatory.total, 2)
  assert.deepEqual(runtime.programFrame, { id: 'p2', completedTurns: 2 })
  assert(!Object.hasOwn(runtime, 'jobs'))
  const status = JSON.parse(delta.split('内存状态：\n')[1].split('\n')[0])
  assert.deepEqual(status, { footprint: { task: 12 } })
  // 正文真的变了才重发
  const changed = frameBody({
    'partitions.recent.results': [
      result('{"omittedBlocks":1,"displayChars":700}\n{"key":"a"}\nBODY-B'),
    ],
  })
  assert.match(memoryPrompt(changed, previous), /BODY-B/)
  // 完全相同的帧只剩说明行
  assert.equal(memoryPrompt(previous, previous).split('\n').length, 1)
})

test('INV-74 capacity retire turns expired frozen bodies into reference cards once, never touching leased ones', async (t) => {
  const f = await fixture(t)
  const leased = await f.session.execute(
    { source: "import {output} from 'velaros';output('LEASED-BODY')" },
    'task'
  )
  const expiring = await f.session.execute(
    { source: "import {output} from 'velaros';output('EXPIRED-BODY')" },
    1
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
  const first = JSON.parse((await f.memory.project(view, undefined, [], signal, 100000)).body)
  await f.memory.acknowledge(first.frameId, signal)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  await programs.consume(first.partitions.runtime.programFrame.id, signal)
  // 一次曝光后租约结束，冻结正文仍逐字留在历史里
  const state = await programs.state()
  assert(!state.leases.some((item) => item.ref === expiring.resultRef))
  assert(state.leases.some((item) => item.ref === leased.resultRef))
  const content = async () =>
    (await f.memory.project(view, undefined, [], signal, 100000)).history
      .map((message) => message.content)
      .join('\n')
  const before = await content()
  assert.match(before, /LEASED-BODY/)
  assert.match(before, /EXPIRED-BODY/)
  // 容量不足时一次性退成引用卡；仍有租约的正文不动，没有可退的就返回 false
  assert.equal(await f.memory.retire(signal), true)
  const after = await content()
  assert.match(after, /LEASED-BODY/)
  assert(!after.includes('EXPIRED-BODY'))
  assert.match(after, /lease-expired-or-released/)
  assert.equal(await f.memory.retire(signal), false)
})
