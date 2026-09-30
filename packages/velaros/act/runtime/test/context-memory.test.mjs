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
import {
  memoryCommittedGroups,
  memoryPrompt,
} from '../../../dist/act/runtime/utils/context-memory.js'

import { baseNotes, done, historyEntries, marker, turn } from './support/model-turn.mjs'

const signal = new AbortController().signal

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

test('archived result fields page original text directly through the actual memory operation', async (t) => {
  const f = await fixture(t)
  const original = 'prefix😀\n' + 'source line\n'.repeat(7000) + 'tail evidence'
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
  assert.equal((await read(prefix + '/rows/0/text', 1, 2)).text, '😀')
  assert.equal((await read(prefix + '/empty')).text, '')
  assert.equal((await read(prefix + '/nil')).text, 'null')
  assert.equal((await read(prefix + '/__proto__')).text, 'own data')
  assert.equal((await read(prefix + '/rows')).text, JSON.stringify(value.rows))
  for (const pointer of ['', 'output', prefix + '/~2', '/'.repeat(4097)])
    await assert.rejects(read(pointer), { code: 'VALIDATION' })
  for (const pointer of [
    prefix + '/missing',
    prefix + '/constructor',
    prefix + '/rows/01',
    prefix + '/rows/-',
    prefix + '/rows/length',
  ])
    await assert.rejects(read(pointer), { code: 'NOT_FOUND' })
  for (const [offset, limit] of [
    [-1, 1],
    [0.5, 1],
    [0, 60001],
    [0, -1],
    [5, 1],
  ])
    await assert.rejects(read(prefix + '/rows/0/text', offset, limit), { code: 'INVALID_RANGE' })
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
    const shown = JSON.parse(request.compiledPrompt.split('分区 runtime：\n')[1].split('\n')[0])
    assert(shown.jobs.some((job) => job.representation === 'completed-jobs'))
    const expanded = shown.jobs.flatMap((job) =>
      job.representation === 'completed-jobs'
        ? Object.entries(job.results).map(([executionId, resultRef]) => ({
            executionId,
            status: job.status,
            resultRef,
          }))
        : [job]
    )
    assert.deepEqual(expanded, raw.partitions.runtime.jobs)
    const results = historyEntries(request).filter(
      (item) => item.origin === 'runtime-execution' && item.bodyIncluded
    )
    assert.equal(expanded.length, 6)
    for (const job of expanded) {
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

test('INV-52 the segment base keeps ledgers across volumes and earlier goals while chronological messages carry selected task bodies', async (t) => {
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
  assert.match(base, /未解问题[^\n]*：\["U1","U2"\]/)
  assert.match(base, /用户约束[^\n]*：\["只用标准库","keep the API stable"\]/)
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
  // 未解问题只取最新的叙事；否定尝试跨卷累积、去重，超出条数的只计数并保留出处
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
  const next = (await memory.project(await view(), undefined, [], signal, 24000)).history[0].content
  const narrative = (await recent.narratives(signal)).at(-1)
  assert(
    next.includes(
      `：${JSON.stringify(['N2', 'N1', ...attempts.slice(0, 14)])}；另有 4 条没有列出，出处 ${JSON.stringify([narrative.ref])}`
    )
  )
  assert.match(next, /未解问题[^\n]*：\["U2","U3"\]\n/)
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
})
