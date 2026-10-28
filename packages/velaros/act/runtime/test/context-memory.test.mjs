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
import { SessionGoal } from '../../../dist/act/runtime/impl/SessionGoal.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  memoryCommittedGroups,
  memoryOutput,
  memoryPrompt,
  memoryTaskHistory,
  memoryVerificationProjection,
} from '../../../dist/act/runtime/utils/context-memory.js'
import { decisionStateProjection } from '../../../dist/act/runtime/utils/decision-state.js'
import {
  materialHistoryDelta,
  projectMaterial,
  readMaterialField,
} from '../../../dist/act/runtime/utils/materials.js'
import { VelarSystemMemoryModule } from '../../../dist/act/system/contract/surface.js'
import { SystemMemoryOperations } from '../../../dist/act/system/impl/SystemMemoryOperations.js'

import { baseNotes, baseText, done, historyEntries, marker, turn } from './support/model-turn.mjs'

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

test('generated material read hints satisfy the live memory contract and recall original bytes', async (t) => {
  const f = await fixture(t)
  const input = await f.session.context.append({ kind: 'user', body: 'Recall the archived result' })
  await f.session.view.begin(input.ref)
  await f.session.view.build({ maxChars: 12000 })
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const text = 'line 😀 quoted " text\n'.repeat(1000)
  const original = JSON.stringify({ result: { value: { stdout: text } } })
  const source = await f.session.context.append({
    kind: 'audit',
    title: 'script:12345678',
    body: JSON.stringify({ source: 'export default null' }),
  })
  const result = await f.session.context.append({
    kind: 'audit',
    title: 'script:12345678:result',
    body: original,
  })
  await programs.add(result.ref, source.ref, 'recall', 'task')
  const ref = result.ref
  const before = projectMaterial(original, ref, 1800)
  const after = projectMaterial(original, ref, 4000)
  const delta = JSON.parse(materialHistoryDelta(original, after.text, before.text, ref))
  const projection = JSON.parse(
    (await programs.project((await f.session.view.inspect()).view, undefined, [], signal, 12000))
      .body
  )
  const hints = [
    JSON.parse(before.text).result.value.stdout.read,
    delta.result.value.stdout.read,
    projection.results[0].read,
  ]
  for (const hint of hints) {
    const { module, export: member, operation, ...input } = hint
    assert.equal(module, 'velaros:system')
    assert.equal(member, 'memory')
    assert.equal(operation, 'read')
    const validated = modelRequestEncoder.output(
      {
        type: 'json',
        name: 'memory_read',
        description: '',
        schema: VelarSystemMemoryModule.operations.read.input,
      },
      input
    )
    const recalled = await new SystemMemoryOperations().read(validated, {
      memory: f.memory,
      abortSignal: signal,
    })
    const full = input.pointer ? text : original
    assert.equal(
      recalled.text,
      full.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 60000))
    )
    assert.equal(recalled.totalChars, full.length)
  }
})

test('INV-79 omitted verification details retain trusted current, historical and unknown counts', async (t) => {
  const f = await fixture(t, undefined, { context: { sources: [], maintenance: false } })
  const input = await f.session.context.append({ kind: 'user', body: 'Check current artifacts' })
  await f.session.view.begin(input.ref)
  await f.session.view.build({ maxChars: 12000 })
  let token = '1'
  let unknown = false
  const spec = {
    id: 'structure',
    scope: 'whole-artifact/schema-1',
    verifierId: 'schema',
    verifierVersion: '1',
    probe: async () =>
      unknown
        ? { status: 'unknown', cost: { coverage: 'complete', charges: [] } }
        : {
            status: 'versioned',
            providerId: 'atomic-host',
            token,
            authorization: 'auth',
            artifacts: [{ identity: 'artifact.json', contentHash: `content-${token}` }],
            cost: { coverage: 'complete', charges: [] },
          },
  }
  await f.session.view.complete({
    verify: async (_view, _signal, checks) => ({
      verified: false,
      reason: 'Other delivery checks remain',
      report: {
        scope: 'Whole artifact',
        checkedAt: new Date().toISOString(),
        checks: [
          await checks.check(spec, async () => ({
            label: 'A long exact check label 😀 '.repeat(25),
            status: 'passed',
            complete: true,
            cost: { coverage: 'complete', charges: [] },
          })),
        ],
      },
    }),
  })
  const original = await f.session.view.readCompletion()
  for (const status of ['current', 'historical', 'unknown']) {
    if (status === 'historical') token = '2'
    if (status === 'unknown') unknown = true
    const view = await f.session.view.build({ maxChars: 12000 })
    const frame = await f.memory.project(view, undefined, [], signal, 12000)
    const verification = JSON.parse(frame.body).partitions.runtime.verification
    assert.deepEqual(verification.checks, [])
    assert.equal(verification.omittedChecks, 1)
    assert.deepEqual(verification.counts, { passed: 1, failed: 0, unknown: 0 })
    assert.deepEqual(
      verification.applicabilityCounts,
      Object.fromEntries(
        ['current', 'historical', 'unknown'].map((item) => [item, +(item === status)])
      )
    )
    assert(verification.applicabilityCheckedAt)
    assert(frame.prompt.includes('applicabilityCounts'))
    assert.deepEqual(await f.session.view.readCompletion(), original)
  }
  assert.equal(f.requests.length, 0)
})

test('INV-83 verification diagnostics retain original indexes and applicability under a fixed budget', () => {
  const report = {
    scope: 'Whole synthetic artifact',
    checkedAt: '2026-10-02T01:00:00.000Z',
    checks: [
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `passed-${index}`,
        label: `Earlier successful check ${index} ${'p'.repeat(80)}`,
        status: 'passed',
      })),
      {
        id: 'failed-last',
        label: 'Repair the missing relation',
        status: 'failed',
        artifact: { identity: 'synthetic.json', revision: 'old' },
      },
      { id: 'unknown-last', label: 'Dependency check has no result', status: 'unknown' },
    ],
  }
  const applicability = {
    checkedAt: report.checkedAt,
    checks: report.checks.map((_, index) => ({
      status: index === 24 ? 'historical' : index === 25 ? 'unknown' : 'current',
    })),
  }
  const identity = {
    ref: { sessionId: 's', id: 'report-ref' },
    taskId: 'task',
    taskRevision: 2,
    counts: { passed: 24, failed: 1, unknown: 1 },
  }
  const original = JSON.stringify(report)
  const projected = memoryVerificationProjection(identity, report, applicability, 2048)
  assert(JSON.stringify(projected).length <= 2048)
  assert.deepEqual(
    projected.checks.slice(0, 2).map((check) => check.index),
    [24, 25]
  )
  assert.deepEqual(
    projected.checks.slice(0, 2).map((check) => check.applicability),
    ['historical', 'unknown']
  )
  assert.equal(projected.checks[0].id, 'failed-last')
  assert.equal(projected.checks[0].artifact.revision, 'old')
  assert.equal(projected.omittedChecks, report.checks.length - projected.checks.length)
  assert.equal(projected.omittedByStatus.failed, 0)
  assert.equal(projected.omittedByStatus.unknown, 0)
  assert.deepEqual(projected.read, { ref: identity.ref, offset: 0, limit: 60000 })
  assert.equal(JSON.stringify(report), original)
})

test('INV-83 long diagnostics and tiny budgets retain omission facts without hiding later failures', () => {
  const report = {
    scope: 'Synthetic bounded diagnostics',
    checkedAt: '2026-10-02T01:00:00.000Z',
    checks: [
      {
        id: 'x'.repeat(1000),
        label: 'A long failed check 😀 '.repeat(30),
        status: 'failed',
        artifact: { identity: 'a'.repeat(1000), revision: 'v1' },
      },
      { id: 'second', label: 'Second failure needs repair', status: 'failed' },
      { id: 'unknown', label: 'Still unknown', status: 'unknown' },
      { id: 'pass', label: 'A successful check', status: 'passed' },
    ],
  }
  const identity = {
    ref: { sessionId: 's', id: 'report-ref' },
    counts: { passed: 1, failed: 2, unknown: 1 },
  }
  const original = JSON.stringify(report)
  const normal = memoryVerificationProjection(identity, report, undefined, 2048)
  assert(JSON.stringify(normal).length <= 2048)
  assert.deepEqual(
    normal.checks.slice(0, 3).map((check) => check.index),
    [0, 1, 2]
  )
  assert.equal(normal.checks[0].detailsInReport, true)
  assert.equal(normal.checks[0].labelTruncated, true)
  assert.equal(normal.checks[0].labelChars, report.checks[0].label.length)
  assert.equal(normal.checks[0].id, undefined)
  assert(normal.checks.every((check) => JSON.stringify(check).length <= 512))
  for (const budget of [0, 80, 300, 700]) {
    const projected = memoryVerificationProjection(identity, report, undefined, budget)
    assert.deepEqual(projected.ref, identity.ref)
    assert.deepEqual(projected.counts, identity.counts)
    assert.equal(projected.omittedChecks, report.checks.length - projected.checks.length)
    if (JSON.stringify({ ...identity, checks: [], omittedChecks: 4 }).length <= budget)
      assert(JSON.stringify(projected).length <= budget)
    else assert.deepEqual(projected.checks, [])
  }
  assert.equal(JSON.stringify(report), original)
})

test('INV-83 real completion reports remain immutable, readable and task-scoped after prioritized projection', async (t) => {
  const f = await fixture(t, undefined, { context: { sources: [], maintenance: false } })
  const input = await f.session.context.append({ kind: 'user', body: 'Check synthetic relations' })
  await f.session.view.begin(input.ref)
  await f.session.view.build({ maxChars: 12000 })
  const report = {
    scope: 'Synthetic relation checks',
    checkedAt: new Date().toISOString(),
    checks: [
      ...Array.from({ length: 24 }, (_, index) => ({
        label: `Succeeded earlier ${index} ${'p'.repeat(100)}`,
        status: 'passed',
      })),
      { label: 'Repair the final relation', status: 'failed' },
      { label: 'An independent check is unknown', status: 'unknown' },
    ],
  }
  await f.session.view.complete({
    verify: async () => ({ verified: false, reason: 'Repair remains', report }),
  })
  const original = await f.session.view.readCompletion()
  const view = await f.session.view.build({ maxChars: 48000 })
  const frame = await f.memory.project(view, undefined, [], signal, 48000)
  const verification = JSON.parse(frame.body).partitions.runtime.verification
  assert.deepEqual(
    verification.checks.slice(0, 2).map((check) => check.index),
    [24, 25]
  )
  assert(verification.read)
  const recalled = await f.memory.readMaterial(
    verification.read.ref,
    verification.read.offset,
    verification.read.limit,
    signal
  )
  assert.equal(recalled.text.length, recalled.totalChars)
  assert.deepEqual(JSON.parse(recalled.text), original)
  assert.deepEqual(await f.session.view.readCompletion(), original)
  const beforeCancel = (await f.storage.loadMetadata('s')).version
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.memory.project(view, undefined, [], cancelled.signal, 48000))
  assert.equal((await f.storage.loadMetadata('s')).version, beforeCancel)
  const next = await f.session.context.append({ kind: 'user', body: 'Start a different task' })
  await f.session.view.end()
  await f.session.view.begin(next.ref, signal, 'new')
  await assert.rejects(
    f.memory.readMaterial(verification.ref, 0, 60000, signal),
    (error) => error.code === 'SCOPE_MISMATCH'
  )
  assert.equal(f.requests.length, 0)
})

test('INV-83 real applicability follows the original report index when failed checks move first', async (t) => {
  const f = await fixture(t, undefined, { context: { sources: [], maintenance: false } })
  const input = await f.session.context.append({ kind: 'user', body: 'Verify synthetic versions' })
  await f.session.view.begin(input.ref)
  await f.session.view.build({ maxChars: 24000 })
  let failedToken = 'old'
  const spec = (id) => ({
    id,
    scope: `synthetic/${id}`,
    verifierId: 'synthetic-versioned',
    verifierVersion: '1',
    probe: async () => ({
      status: 'versioned',
      providerId: 'synthetic-provider',
      token: id === 'failed-version' ? failedToken : 'unchanged',
      authorization: 'synthetic-authority',
      artifacts: [{ identity: id, contentHash: id === 'failed-version' ? failedToken : 'same' }],
      cost: { coverage: 'complete', charges: [] },
    }),
  })
  await f.session.view.complete({
    verify: async (_view, _signal, checks) => ({
      verified: false,
      reason: 'Synthetic failures need repair',
      report: {
        scope: 'Synthetic versions',
        checkedAt: new Date().toISOString(),
        checks: [
          await checks.check(spec('passed-version'), async () => ({
            label: 'Unchanged successful check',
            status: 'passed',
            complete: true,
            cost: { coverage: 'complete', charges: [] },
          })),
          ...Array.from({ length: 24 }, (_, index) => ({
            label: `Earlier success ${index} ${'p'.repeat(80)}`,
            status: 'passed',
          })),
          await checks.check(spec('failed-version'), async () => ({
            label: 'Failed artifact was revised after checking',
            status: 'failed',
            complete: true,
            cost: { coverage: 'complete', charges: [] },
          })),
          { label: 'Unavailable independent check', status: 'unknown' },
        ],
      },
    }),
  })
  const original = await f.session.view.readCompletion()
  failedToken = 'new'
  const view = await f.session.view.build({ maxChars: 100000 })
  const frame = await f.memory.project(view, undefined, [], signal, 100000)
  const verification = JSON.parse(frame.body).partitions.runtime.verification
  assert.deepEqual(
    verification.checks.slice(0, 2).map((check) => check.index),
    [25, 26]
  )
  assert.equal(verification.checks[0].applicability, 'historical')
  assert.equal(verification.checks[1].applicability, 'unknown')
  assert.equal(verification.checks.find((check) => check.index === 0).applicability, 'current')
  assert.deepEqual(verification.applicabilityCounts, { current: 1, historical: 1, unknown: 25 })
  assert.deepEqual(await f.session.view.readCompletion(), original)
  assert.equal(f.requests.length, 0)
})

test('INV-83 late failed and unknown diagnostics reach the next accepted model request', async (t) => {
  const report = {
    scope: 'Synthetic completion checks',
    checkedAt: new Date().toISOString(),
    checks: [
      ...Array.from({ length: 24 }, (_, index) => ({
        label: `Earlier successful check ${index} ${'p'.repeat(100)}`,
        status: 'passed',
      })),
      { label: 'Repair the final synthetic relation', status: 'failed' },
      { label: 'Independent synthetic dependency is unknown', status: 'unknown' },
    ],
  }
  let verifications = 0
  const f = await fixture(t, undefined, {
    limits: { projectionChars: 80000 },
    context: {
      maintenance: false,
      completion: {
        verify: async () =>
          ++verifications === 1
            ? { verified: false, reason: 'Synthetic relations need repair', report }
            : { verified: true, reason: 'Synthetic relations pass' },
      },
    },
  })
  const events = []
  for await (const event of f.session.submit('Finish the synthetic task')) events.push(event)
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(f.requests.length, 2)
  const request = f.requests[1]
  const frame = JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)
  const verification = frame.partitions.runtime.verification
  assert.deepEqual(
    verification.checks.slice(0, 2).map((check) => [check.index, check.status]),
    [
      [24, 'failed'],
      [25, 'unknown'],
    ]
  )
  const wire = modelRequestEncoder
    .messages(request)
    .flatMap((item) => (typeof item.content === 'string' ? [item.content] : []))
    .join('\n')
  assert(wire.includes(report.checks[24].label))
  assert(wire.includes(report.checks[25].label))
  const recalled = await f.memory.readMaterial(
    verification.read.ref,
    verification.read.offset,
    verification.read.limit,
    signal
  )
  assert.equal(recalled.text.length, recalled.totalChars)
  assert.deepEqual(JSON.parse(recalled.text).result.report, report)
})

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

test('INV-48 bounded goal frames recall full Unicode fields by immutable reference without output delivery credit', async (t) => {
  const f = await fixture(t)
  const ledger = new SessionGoal('s', f.storage)
  const objective = `全文开始\n${'原文 \\"🔍\\n\n'.repeat(9000)}尾部验收：所有输入都保留 ✅`
  const reason = '已完成第一项；后续仍需核验。'.repeat(180)
  await ledger.seed(objective, 0, signal)
  const current = await ledger.update({ baseRevision: 1, reason }, signal)
  assert.equal(current.objective, objective)
  assert.deepEqual(await ledger.frame(JSON.stringify(current).length, signal), current)
  for (const budget of [8000, 1000, 0]) {
    const frame = await ledger.frame(budget, signal)
    assert.equal(frame.id, current.id)
    assert.equal(frame.revision, current.revision)
    assert.equal(frame.status, current.status)
    assert.equal(frame.objective, undefined)
    if (budget) assert(JSON.stringify(frame).length <= budget)
    for (const field of ['objective', 'reason']) {
      const reference = frame[`${field}InRecord`]
      if (!reference) {
        assert.equal(frame[field], current[field])
        continue
      }
      assert.equal(reference.chars, current[field].length)
      const offset = Math.max(0, current[field].length - 137)
      const page = await f.memory.readMaterial(
        reference.ref,
        offset,
        137,
        signal,
        reference.pointer
      )
      assert.equal(page.text, current[field].slice(offset))
      assert.equal(page.offset, offset)
      assert.equal(page.totalChars, current[field].length)
      assert.equal(page.pointer, `/${field}`)
      assert.equal(page.delivery, undefined)
    }
  }
  const first = await ledger.frame(1000, signal)
  const input = {
    ref: first.objectiveInRecord.ref,
    pointer: first.objectiveInRecord.pointer,
    offset: objective.length - 137,
    limit: 137,
  }
  const result = await f.session.execute({
    source: `import {memory} from 'velaros:system';export default await memory.read(${JSON.stringify(input)});`,
  })
  assert(result.checked && !result.result.failed, JSON.stringify(result))
  const page = result.rawValue
  assert.equal(page.text, objective.slice(-137))
  assert.equal(page.totalChars, objective.length)
  await ledger.update({ baseRevision: current.revision, reason: '新的进度' }, signal)
  const originalReason = await f.memory.readMaterial(
    first.reasonInRecord.ref,
    0,
    4000,
    signal,
    first.reasonInRecord.pointer
  )
  assert.equal(originalReason.text, reason)
})

test('INV-48 current goal recall survives task boundaries while prior versions and other sessions retain scope checks', async (t) => {
  const f = await fixture(t)
  const ledger = new SessionGoal('s', f.storage)
  await ledger.seed('持续目标原文。'.repeat(300), 0, signal)
  const previous = await ledger.frame(1000, signal)
  await ledger.update({ baseRevision: 1, reason: '更新后的依据' }, signal)
  const current = await ledger.frame(1000, signal)
  await f.session.context.append({
    kind: 'audit',
    title: 'search:history-reset',
    body: '新的授权代次',
  })
  const input = await f.session.context.ingest({ text: '在新的任务中继续当前目标' })
  await f.session.view.begin(input.ref, signal, 'new')
  const read = (ref, abort = signal) => f.memory.readMaterial(ref, 0, 60, abort, '/objective')
  assert.equal(
    (await read(current.objectiveInRecord.ref)).text,
    (await ledger.get(signal)).objective.slice(0, 60)
  )
  await assert.rejects(read(previous.objectiveInRecord.ref), { code: 'SCOPE_MISMATCH' })
  await assert.rejects(read({ ...current.objectiveInRecord.ref, sessionId: 'other' }), {
    code: 'SCOPE_MISMATCH',
  })
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(read(current.objectiveInRecord.ref, abort.signal), { name: 'AbortError' })
  const record = (await f.storage.load('s')).records.find(
    (item) => item.ref.id === current.objectiveInRecord.ref.id
  )
  const originalGet = f.storage.get.bind(f.storage)
  let changedDuringRead = false
  f.storage.get = async (id, objectId) => {
    const body = await originalGet(id, objectId)
    if (!changedDuringRead && objectId === record.objectId) {
      changedDuringRead = true
      await ledger.update(
        { baseRevision: current.revision, reason: '读取期间推进了目标版本' },
        signal
      )
    }
    return body
  }
  try {
    await assert.rejects(read(current.objectiveInRecord.ref), { code: 'SCOPE_MISMATCH' })
  } finally {
    f.storage.get = originalGet
  }
  assert(changedDuringRead, 'the current goal changed while its older-task body was being read')
  const refreshed = await ledger.frame(1000, signal)
  assert.notEqual(refreshed.objectiveInRecord.ref.id, current.objectiveInRecord.ref.id)
  assert.equal(
    (await read(refreshed.objectiveInRecord.ref)).text,
    (await ledger.get(signal)).objective.slice(0, 60)
  )
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
    // 当前作业列表每帧完整给出；按身份合并各帧中的作业
    const sections = modelRequestEncoder
      .messages(request)
      .map((item) =>
        typeof item.content === 'string'
          ? item.content
          : item.content.map((part) => part.text ?? '').join('\n')
      )
      .flatMap((text) =>
        text
          .split(/(?:分区 )?runtime：\n/u)
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

test('INV-74 maintenance narratives reuse an identified retained frame while current unresolved work stays explicit', () => {
  for (const presentation of [undefined, 'node']) {
    const summary = 'NARRATIVE_UNIQUE: verified implementation facts. '.repeat(20)
    const unresolved = ['PENDING_UNIQUE: inspect the remaining boundary. '.repeat(8)]
    const report = { sessionId: 's', id: 'report-one' }
    const frame = {
      presentation,
      partitions: {
        task: { goals: [] },
        workspace: { notes: [] },
        observation: {},
        recent: { results: [] },
        runtime: { mandatory: [] },
      },
      memoryStatus: {
        maintenance: {
          origin: 'model-interpretation',
          summary,
          unresolved: [...unresolved, ...unresolved],
          report,
          active: true,
          lastAttempt: {
            status: 'applied',
            error: null,
            report,
            unresolved: [...unresolved, ...unresolved],
            ref: { sessionId: 's', id: 'outcome-one' },
            futureField: { zero: 0, empty: [], flag: false },
          },
        },
      },
    }
    const original = JSON.stringify(frame)
    const displayed = (previous) =>
      JSON.parse(memoryPrompt(original, previous).split('内存状态：\n')[1]).maintenance
    const first = displayed()
    assert.equal(first.summary, summary)
    assert.deepEqual(first.unresolved, frame.memoryStatus.maintenance.unresolved)
    assert.equal(first.lastAttempt.unresolved, undefined)
    assert.equal(first.lastAttempt.unresolvedInCurrentState, true)
    assert.deepEqual(first.lastAttempt.futureField, { zero: 0, empty: [], flag: false })
    const retained = displayed(original)
    assert.equal(retained.summary, undefined)
    assert.equal(retained.summaryInEarlierFrame, true)
    assert.deepEqual(retained.unresolved, frame.memoryStatus.maintenance.unresolved)
    assert.deepEqual(retained.lastAttempt, first.lastAttempt)
    assert.equal(displayed().summary, summary, 'a rebuilt history delivers the full narrative')
    assert.equal(JSON.stringify(frame), original, 'audit data remains complete')
  }
})

test('INV-74 maintenance narrative identity and current failures survive presentation deduplication', () => {
  const frame = {
    partitions: {
      task: { goals: [] },
      workspace: { notes: [] },
      observation: {},
      recent: { results: [] },
      runtime: { mandatory: [] },
    },
    memoryStatus: {
      maintenance: {
        origin: 'model-interpretation',
        summary: 'Keep the complete narrative and its identity. '.repeat(20),
        unresolved: ['Current pending work. '.repeat(20)],
        report: { sessionId: 's', id: 'report-one' },
        active: true,
      },
    },
  }
  const original = JSON.stringify(frame)
  for (const change of [
    (value) => {
      value.report.id = 'other-report'
    },
    (value) => {
      value.report.sessionId = 'other-session'
    },
    (value) => {
      delete value.report
    },
    (value) => {
      value.origin = 'other-origin'
    },
    (value) => {
      value.summary += ' New verified fact.'
    },
  ]) {
    const prior = structuredClone(frame)
    change(prior.memoryStatus.maintenance)
    const shown = JSON.parse(memoryPrompt(original, JSON.stringify(prior)).split('内存状态：\n')[1])
    assert.equal(shown.maintenance.summary, frame.memoryStatus.maintenance.summary)
    assert.equal(shown.maintenance.summaryInEarlierFrame, undefined)
  }
  const changed = structuredClone(frame)
  changed.memoryStatus.maintenance.lastAttempt = {
    status: 'failed',
    error: 'Snapshot changed while applying the patch.',
    report: null,
    unresolved: ['Read the new source before retrying.'],
  }
  changed.memoryStatus.maintenance.pending = { focus: 'Keep the pending request', preserve: [] }
  const prompt = memoryPrompt(JSON.stringify(changed), original)
  const shown = JSON.parse(prompt.split('内存状态：\n')[1]).maintenance
  assert.equal(shown.summaryInEarlierFrame, true)
  assert.deepEqual(shown.unresolved, changed.memoryStatus.maintenance.unresolved)
  assert.deepEqual(shown.lastAttempt, changed.memoryStatus.maintenance.lastAttempt)
  assert.deepEqual(shown.pending, changed.memoryStatus.maintenance.pending)
  const anonymous = structuredClone(frame)
  delete anonymous.memoryStatus.maintenance.report
  const body = JSON.stringify(anonymous)
  assert(memoryPrompt(body, body).includes(anonymous.memoryStatus.maintenance.summary))
})

test('INV-74 Node unresolved work shares exact current task bodies with order and duplicates intact', () => {
  const alpha = 'ALPHA_CURRENT_WORK: verify the remaining public entry points. '.repeat(8)
  const beta = 'BETA_CURRENT_WORK: preserve cancellation and concurrent task isolation. '.repeat(8)
  const missing = 'MISSING_CURRENT_WORK: inspect a boundary without an active item. '.repeat(8)
  const report = { sessionId: 's', id: 'report-current' }
  const frame = {
    presentation: 'node',
    partitions: {
      task: {
        goals: [],
        active: {
          revision: 7,
          items: [
            { id: 'b', kind: 'question', text: beta, sources: [report] },
            { id: 'a', kind: 'question', text: alpha, sources: [report] },
            { id: 'short', text: 'short' },
          ],
          pendingInputs: [{ sessionId: 's', id: 'new-input' }],
        },
      },
      workspace: { notes: [] },
      observation: {},
      recent: { results: [] },
      runtime: { mandatory: [] },
    },
    memoryStatus: {
      maintenance: {
        origin: 'model-interpretation',
        report,
        active: true,
        summary: 'Verified facts remain separate from pending work.',
        unresolved: [alpha, 'short', beta, alpha, missing],
        pending: { focus: 'Inspect the new user input', preserve: [report] },
        lastAttempt: {
          status: 'applied',
          report,
          error: null,
          unresolved: [alpha, 'short', beta, alpha, missing],
        },
        futureField: { empty: [], flag: false, count: 0 },
      },
    },
  }
  const body = JSON.stringify(frame)
  for (const previous of [undefined, body]) {
    const prompt = memoryPrompt(body, previous)
    const task = nodeTaskSnapshot(prompt, previous ? [memoryPrompt(previous)] : [])
    const shown = JSON.parse(prompt.split('内存状态：\n')[1]).maintenance
    assert.deepEqual(task.active, frame.partitions.task.active)
    assert.deepEqual(shown.unresolved, [
      { textAt: '/task/active/items/1/text' },
      'short',
      { textAt: '/task/active/items/0/text' },
      { textAt: '/task/active/items/1/text' },
      missing,
    ])
    assert.deepEqual(
      shown.unresolved.map((item) =>
        typeof item === 'string'
          ? item
          : item.textAt
              .slice(1)
              .split('/')
              .reduce((value, key) => value[key], { task })
      ),
      frame.memoryStatus.maintenance.unresolved
    )
    assert.equal(prompt.split(alpha).length - 1, previous ? 0 : 1)
    assert.equal(prompt.split(beta).length - 1, previous ? 0 : 1)
    assert.equal(shown.lastAttempt.unresolvedInCurrentState, true)
    assert.deepEqual(shown.pending, frame.memoryStatus.maintenance.pending)
    assert.deepEqual(shown.futureField, frame.memoryStatus.maintenance.futureField)
    assert.deepEqual(shown.report, report)
  }
  assert.equal(JSON.stringify(frame), body)
})

test('INV-74 Node unresolved references depend on current positions and current literal bodies', () => {
  const text = 'CURRENT_LITERAL_BODY: complete the remaining checks before delivery. '.repeat(10)
  const frame = {
    presentation: 'node',
    partitions: {
      task: { goals: [], active: { items: [{ id: 'item-old', text }] } },
      workspace: { notes: [] },
      observation: {},
      recent: { results: [] },
      runtime: { mandatory: [] },
    },
    memoryStatus: { maintenance: { unresolved: [text] } },
  }
  const old = JSON.stringify(frame)
  const shown = (value, previous) =>
    JSON.parse(memoryPrompt(JSON.stringify(value), previous).split('内存状态：\n')[1]).maintenance
  const replacement = structuredClone(frame)
  replacement.partitions.task.active.items[0].id = 'item-new'
  assert.deepEqual(shown(replacement, old).unresolved, [{ textAt: '/task/active/items/0/text' }])
  for (const items of [[], [{ id: 'item-old', text: 'Different current work' }]]) {
    const current = structuredClone(frame)
    current.partitions.task.active.items = items
    assert.deepEqual(
      shown(current, old).unresolved,
      [text],
      'retained history cannot supply the body'
    )
    assert.deepEqual(shown(current).unresolved, [text], 'rebuilding history keeps unmatched work')
  }
  const reordered = structuredClone(frame)
  reordered.partitions.task.active.items = [
    { id: 'extra', text: 'Extra work' },
    { id: 'item-old', text },
  ]
  assert.deepEqual(shown(reordered, old).unresolved, [{ textAt: '/task/active/items/1/text' }])
})

test('INV-74 Node unresolved work remains literal for ambiguous or malformed current items', () => {
  const text =
    'UNAMBIGUOUS_CURRENT_WORK: inspect the actual output and keep the required source. '.repeat(8)
  for (const items of [
    undefined,
    {},
    [null],
    [{ id: '', text }],
    [{ id: 7, text }],
    [{ id: 'a', text: { value: text } }],
    [
      { id: 'a', text },
      { id: 'a', text },
    ],
    [
      { id: 'a', text },
      { id: 'a', text: 'Other current work' },
    ],
  ]) {
    const maintenance = {
      unresolved: [text, text, '', null, { future: 'value' }],
      lastAttempt: { status: 'failed', error: 'Current failure', unresolved: ['Failure detail'] },
      pending: { focus: 'New work' },
    }
    const frame = {
      presentation: 'node',
      partitions: {
        task: { goals: [], active: { items } },
        workspace: { notes: [] },
        observation: {},
        recent: { results: [] },
        runtime: { mandatory: [] },
      },
      memoryStatus: { maintenance },
    }
    const body = JSON.stringify(frame)
    const shown = JSON.parse(memoryPrompt(body, body).split('内存状态：\n')[1]).maintenance
    assert.deepEqual(shown, maintenance)
    assert.equal(JSON.stringify(frame), body)
  }
})

test('INV-74 Node unresolved sharing preserves legacy presentation, short bodies and future fields', () => {
  const text = 'LONG_CURRENT_WORK: preserve every current requirement and its evidence. '.repeat(8)
  for (const presentation of [undefined, 'node']) {
    const maintenance = {
      unresolved: ['tiny', text, { future: 'original' }],
      lastAttempt: { status: 'failed', error: 'Different report failed', unresolved: [text] },
    }
    const frame = {
      presentation,
      partitions: {
        task: {
          goals: [],
          active: {
            items: [
              { id: 'long', text },
              { id: 'short', text: 'tiny' },
            ],
          },
        },
        workspace: { notes: [] },
        observation: {},
        recent: { results: [] },
        runtime: { mandatory: [] },
      },
      memoryStatus: { maintenance },
    }
    const shown = JSON.parse(
      memoryPrompt(JSON.stringify(frame)).split('内存状态：\n')[1]
    ).maintenance
    assert.deepEqual(shown.lastAttempt, maintenance.lastAttempt)
    assert.deepEqual(
      shown.unresolved,
      presentation === 'node'
        ? ['tiny', { textAt: '/task/active/items/0/text' }, { future: 'original' }]
        : maintenance.unresolved
    )
    frame.memoryStatus.maintenance = { future: 'value' }
    assert.deepEqual(
      JSON.parse(memoryPrompt(JSON.stringify(frame)).split('内存状态：\n')[1]).maintenance,
      { future: 'value' }
    )
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
    // 容量不足时重建当前帧；任务、响应和工具结果的逻辑历史仍保持前缀。
    const history = request.history
      .filter(
        (item) =>
          typeof item.content !== 'string' ||
          !/^(?:当前运行状态|Runtime 本帧工作内存)/u.test(item.content)
      )
      .map(({ role, content }) => ({ role, content }))
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

test('INV-62 segment changes preserve the complete leading user prefix', async (t) => {
  const f = await fixture(t)
  const task = 'USER_PREFIX: update all renderers and verify the original behavior.'
  const goal = await f.session.context.append({ kind: 'user', body: task })
  await f.session.view.begin(goal.ref)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const view = {
    id: 'frame',
    scope: { sessionId: 's', revision: 0 },
    goals: [await f.session.context.projectInput(goal.ref, 2000)],
    capsule: {},
    mandatory: [],
    evidence: [],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const first = await f.memory.project(view, undefined, [], signal, 24000)
  assert(first.history[0].content.endsWith(task))
  const prefix = first.history[0]
  for (let index = 0; index < 6; index++) {
    await f.session.context.append({ kind: 'assistant', body: `Verified source ${index}` })
    await archiveResult(f, programs, `result-${index}`)
  }
  const before = await f.memory.project(view, undefined, [], signal, 24000)
  assert.deepEqual(before.history[0], prefix)
  assert(await f.memory.fold('runway', 24000, signal))
  const after = await f.memory.project(view, undefined, [], signal, 24000)
  assert.deepEqual(after.history[0], prefix)
  assert.equal(after.history[0].cacheBreakpoint, true)
  assert.notEqual(after.history[1].content, before.history[1].content)
  assert.match(after.history[1].content, /卷目录/)
  assert.equal(after.history.filter((message) => message.content.endsWith(task)).length, 1)
  assert.equal(after.segment.index, before.segment.index + 1)
})

test('INV-62 latest original input keeps its prefix across allocation changes and yields to real projection pressure', async (t) => {
  const tasks = [
    'Keep public behavior; update the implementation and verify it.\n'.repeat(50),
    '保留原始需求与接口行为，检查并发与重入，再验证全部更改。🧭\n'.repeat(75),
    JSON.stringify({
      ref: { id: 'user-data' },
      position: 'user-input',
      text: 'a"b\\c\n'.repeat(300),
    }),
  ]
  for (const task of tasks) {
    const f = await fixture(t)
    const input = await f.session.context.append({ kind: 'user', body: task })
    await f.session.view.begin(input.ref)
    const view = {
      id: 'frame',
      scope: { sessionId: 's', revision: 0 },
      goals: [await f.session.context.projectInput(input.ref, Math.floor(task.length / 3))],
      capsule: {},
      mandatory: [],
      evidence: [],
      gaps: [],
      readSet: [],
      progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
    }
    let prefix
    for (const budget of [task.length * 6, Math.ceil(task.length * 3.2), task.length * 2]) {
      const projected = await f.memory.project(view, undefined, [], signal, budget)
      const goal = JSON.parse(projected.body).partitions.task.goals.at(-1)
      assert.equal(goal.text, task)
      assert.equal(goal.offset, 0)
      assert.equal(goal.totalChars, task.length)
      if (prefix) assert.deepEqual(projected.history[0], prefix)
      else prefix = projected.history[0]
    }
    await f.session.context.summarizeInput({
      ref: input.ref,
      baseRevision: 0,
      summary: 'A historical interpretation of the original input.',
      constraints: ['Preserve the original input as the authority.'],
      unresolved: [],
    })
    const pressure = await f.memory.project(
      view,
      undefined,
      [],
      signal,
      Math.floor(task.length / 2)
    )
    const partial = JSON.parse(JSON.parse(pressure.body).partitions.task.goals.at(-1).text)
    assert.equal(partial.representation, 'excerpt-with-summary')
    assert.equal(partial.partial, true)
    assert(partial.omittedChars > 0)
    assert.equal(partial.totalChars, task.length)
    assert.equal(partial.historicalInterpretation.origin, 'model-interpretation')
    assert.equal(partial.excerpts[0].text, task.slice(0, partial.excerpts[0].text.length))
    const restored = await f.memory.project(view, undefined, [], signal, task.length * 2)
    assert.deepEqual(restored.history[0], prefix)
    assert.equal((await f.session.context.readInput(input.ref, { limit: task.length })).text, task)
  }
})

test('INV-62 a segment base follows early inputs without separating native calls or moving later corrections', () => {
  const goal = (sequence, text) => ({
    record: { ref: { sessionId: 's', id: `input-${sequence}` }, sequence },
    text,
    totalChars: text.length,
    offset: 0,
  })
  const call = {
    role: 'assistant',
    content: 'Read current source',
    toolExchange: {
      text: 'Read current source',
      calls: [{ id: 'c1', name: 'exec', input: { code: 'console.log(1)' } }],
      results: [{ id: 'c1', name: 'exec', output: { resultRef: 'result-4' } }],
    },
  }
  const result = {
    role: 'user',
    content: '1',
    toolResult: { callId: 'c1', toolName: 'exec' },
  }
  const history = {
    messages: [call, result],
    items: [{ sequence: 3 }, { sequence: 4 }],
    fresh: [],
  }
  const goals = [
    goal(5, 'Only inspect from now on'),
    goal(1, 'Implement the parser'),
    goal(2, 'Keep the API'),
  ]
  const original = structuredClone({ goals, history })
  const messages = memoryTaskHistory(goals, history, 'SEGMENT_SNAPSHOT')
  assert(messages[0].content.endsWith('Implement the parser'))
  assert(messages[1].content.endsWith('Keep the API'))
  assert.equal(messages[2].content, 'SEGMENT_SNAPSHOT')
  assert.deepEqual(messages.slice(3, 5), [call, result])
  assert(messages[5].content.endsWith('Only inspect from now on'))
  assert.deepEqual({ goals, history }, original)
  assert.doesNotThrow(() =>
    modelRequestEncoder.messages({
      history: messages,
      compiledPrompt: 'Current state',
      materials: [],
    })
  )
  const noInputs = memoryTaskHistory([], history, 'SEGMENT_SNAPSHOT')
  assert.deepEqual(noInputs.slice(1), [call, result])
  assert.equal(noInputs[0].content, 'SEGMENT_SNAPSHOT')
  const noHistory = memoryTaskHistory(
    goals,
    { messages: [], items: [], fresh: [] },
    'SEGMENT_SNAPSHOT'
  )
  assert.equal(noHistory.at(-1).content, 'SEGMENT_SNAPSHOT')
  assert(noHistory[0].content.endsWith('Implement the parser'))
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
        assert(frame.partitions.recent.results.at(-1).ref)
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
  assert.deepEqual(frame.partitions.workspace.residentDirectory.items, [])
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
  const assistantHistory = request.history.filter((item) => item.role === 'assistant')
  assert(assistantHistory.length > 0)
  assert(assistantHistory.every((item) => !item.content.startsWith('{"origin":"assistant-script"')))
  assert.equal(
    entries.filter((item) => item.origin === 'runtime-execution' && item.bodyIncluded).length,
    1
  )
  assert.equal(
    frame.partitions.recent.historyState.records,
    entries.length + assistantHistory.length
  )
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
  assert.match(baseText(f.requests[0]), /persistent reasoning summary/)
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
  assert.match(baseText(f.requests[1]), /Maintenance preserved progress/)
  assert.doesNotMatch(baseText(f.requests[1]), /Original main-model progress/)
  const state = await f.storage.load('s')
  const results = await Promise.all(
    state.records
      .filter((item) => /^script:[0-9a-f-]+:result$/u.test(item.title))
      .map(async (item) => JSON.parse(await f.storage.get('s', item.objectId)))
  )
  assert.equal(results.filter((item) => item.mode === 'observe').length, 1)
  assert.equal(results.filter((item) => item.mode === 'execute').length, 0)
})

test('INV-74 actual requests retain maintenance narrative provenance through continued execution', async (t) => {
  const summary = 'MAINTENANCE_NARRATIVE_ORIGINAL: the source was inspected. '.repeat(8)
  const unresolved = ['Review the remaining integration boundary. '.repeat(6)]
  let maintenanceCalls = 0
  let reused = 0
  const maintenance = {
    id: 'maintenance',
    limits: { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      maintenanceCalls++
      const snapshot = JSON.parse(
        JSON.parse(request.materials[0].text).partitions.task.goals[0].text
      ).snapshot
      const patch = { baseRevision: snapshot.baseRevision, summary, unresolved }
      const part = turn(request, {
        execute: {
          source: `import {submit} from 'velaros:context-materials';await submit(${JSON.stringify(patch)});`,
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
      const actual = modelRequestEncoder
        .messages(request)
        .map((item) =>
          typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
        )
      assert.equal(actual.join('\n').split(summary).length - 1, 1)
      const state = JSON.parse(request.materials[0].text).memoryStatus.maintenance
      assert.equal(state.summary, summary, 'the authoritative frame keeps the complete narrative')
      assert.deepEqual(state.unresolved, unresolved)
      if (request.compiledPrompt.includes('"summaryInEarlierFrame":true')) {
        reused++
        assert(request.history.some((item) => item.content.includes?.(summary)))
        assert(!request.compiledPrompt.includes(summary))
      } else assert(request.compiledPrompt.includes(summary))
      assert(request.compiledPrompt.includes(unresolved[0]), 'pending work remains in this frame')
      if (call === 6) yield* done(request)
      else {
        yield turn(request, {
          execute: {
            source: `import {output} from 'velaros';output('continued step ${call}');`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      }
    },
    { context: { sources: [], maintenance: { model: maintenance } } }
  )
  await f.session.execute(
    { source: `import {output} from 'velaros';output('${'retained source '.repeat(600)}');` },
    'task'
  )
  await run(f, 'Continue the implementation and verification after inspecting the source.')
  assert.equal(maintenanceCalls, 1)
  assert.equal(f.requests.length, 6)
  assert(reused > 0, 'at least one real accepted prefix must exercise narrative reuse')
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
  assert.match(baseText(f.requests[0]), /另有 16 份驻留笔记没有列出/)
  assert.deepEqual(
    { ...frame.partitions.workspace.snapshot, sourcesChanged: undefined },
    { notes: 20, shown: 4, omitted: 16, sourcesChanged: undefined }
  )
  assert.deepEqual(frame.partitions.workspace.notes, [])
  const directory = frame.partitions.workspace.residentDirectory
  assert(directory.items.length > 0 && directory.items.length <= 64)
  assert.equal(directory.items.length + directory.omitted, 20)
  assert(directory.items.some((item) => item.bodyLocation === 'segment-base'))
  assert(
    directory.items.every(
      (item) => item.key && item.revision === 1 && item.ref.id && !Object.hasOwn(item, 'text')
    )
  )
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
    next.history.filter((item) => item.role === 'assistant').map((item) => item.content),
    await Promise.all(
      responses.slice(2).map(async (record) => (await f.session.context.read(record.ref)).text)
    )
  )
  // 延续结果附当次源码：产生它的那条响应已经封进卷；其余结果的源码就在前一条响应里
  assert.match(next.history[1].content, /当次源码/)
  assert.doesNotMatch(next.history.at(-1).content, /当次源码/)
  assert.equal(next.history.at(-1).cacheBreakpoint, true)
  assert.equal(await memory.fold('runway', 24000, signal), false)
})

test('INV-53 batched execution gets a volume narrative even when it uses few model turns', async (t) => {
  for (const { label, results, reason, note, expected } of [
    { label: 'many results in one response', results: 6, reason: 'runway', expected: true },
    { label: 'small batch', results: 5, reason: 'runway', expected: false },
    { label: 'explicit organization', results: 6, reason: 'organize', expected: false },
    {
      label: 'progress already recorded',
      results: 6,
      reason: 'runway',
      note: true,
      expected: false,
    },
  ])
    await t.test(label, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const recent = new RecentContext('s', f.session.context, f.storage)
      const view = {
        id: 'batch-frame',
        scope: { sessionId: 's', revision: 0 },
        goals: [],
        capsule: {},
        mandatory: [],
        evidence: [],
        gaps: [],
        readSet: [],
        progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
      }
      await f.memory.project(view, undefined, [], signal, 24000)
      await f.session.context.append({
        kind: 'assistant',
        body: 'Read independent sources in one batch.',
      })
      for (let index = 0; index < results; index++)
        await archiveResult(f, programs, `source-${index}`)
      if (note)
        await f.session.context.append({
          kind: 'audit',
          title: 'workspace:note:progress',
          body: JSON.stringify({
            key: 'progress',
            revision: 1,
            body: 'Current findings are recorded.',
          }),
        })
      // 最近窗口留在下一段；批量执行整体进入将被压缩的那一卷。
      for (let index = 0; index < 8; index++)
        await f.session.context.append({ kind: 'assistant', body: `Recent progress ${index}` })
      assert(await f.memory.fold(reason, 24000, signal))
      const [sealed] = await recent.volumes(signal)
      assert.equal(sealed.volume.turns, 1)
      assert.equal(sealed.volume.results, results)
      assert.deepEqual(await f.memory.narration(signal), expected ? sealed.ref : null)
      assert.equal(await f.memory.narration(signal), null, 'the automatic intent is consumed once')
      assert.equal(f.requests.length, 0, 'folding records an intent without invoking a model')
    })
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
  const base = baseText(frame)
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
  const next = baseText(nextFrame)
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

async function archiveRequired(f, programs, values, maxChars = 20000, required = true) {
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
            required,
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

test('INV-75 authenticated page lineage preserves original debt only when delivery or provenance is incomplete', async (t) => {
  const values = [
    ['unicode', '可信来源😀\n'.repeat(120)],
    [
      'object',
      { rows: Array.from({ length: 35 }, (_, index) => ({ index, label: `异质-${index}-Δ` })) },
    ],
  ]
  const cases = [
    ...values.map(([name, value]) => ({ name: `complete-${name}`, value, complete: true })),
    { name: 'complete-chain', value: values[0][1], complete: true },
    ...[
      'clipped-carrier',
      'unsigned-inner',
      'partial-outer',
      'partial-inner',
      'changed-inner',
      'changed-source',
      'wrong-pointer',
      'forward-receipt',
      'receipt-cycle-to-carrier',
    ].map((name) => ({ name, value: values[0][1], complete: false })),
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(f, programs, [scenario.value], 512)
      const pointer = '/output/blocks/0/value'
      const page = await f.memory.readMaterial(
        source,
        0,
        scenario.name === 'partial-inner' ? 200 : 12000,
        signal,
        pointer
      )
      if (scenario.name === 'unsigned-inner') delete page.delivery
      if (scenario.name === 'changed-inner') page.text += 'changed'
      const firstCarrier = await archiveRequired(f, programs, [page], 512)
      const originalGet = f.storage.get.bind(f.storage)
      if (scenario.name === 'changed-source') {
        const record = (await f.session.context.read(source)).record
        f.storage.get = async (sessionId, objectId) => {
          const text = await originalGet(sessionId, objectId)
          if (objectId !== record.objectId) return text
          const changed = JSON.parse(text)
          changed.output.blocks[0].value += 'changed-version'
          return JSON.stringify(changed)
        }
      }
      if (['forward-receipt', 'receipt-cycle-to-carrier'].includes(scenario.name)) {
        const later = await f.memory.readMaterial(source, 0, 12000, signal, pointer)
        const record = (await f.session.context.read(firstCarrier)).record
        f.storage.get = async (sessionId, objectId) => {
          const text = await originalGet(sessionId, objectId)
          if (objectId !== record.objectId) return text
          const changed = JSON.parse(text)
          changed.output.blocks[0].value.delivery =
            scenario.name === 'forward-receipt' ? later.delivery : { receipt: firstCarrier }
          return JSON.stringify(changed)
        }
      }
      let recalled = await f.memory.readMaterial(
        firstCarrier,
        0,
        scenario.name === 'partial-outer' ? 200 : 12000,
        signal,
        scenario.name === 'wrong-pointer' ? `${pointer}/text` : pointer
      )
      if (scenario.name === 'complete-chain') {
        const middle = await archiveRequired(f, programs, [recalled], 512)
        recalled = await f.memory.readMaterial(middle, 0, 12000, signal, pointer)
      }
      const lastCarrier = await archiveRequired(
        f,
        programs,
        [recalled],
        scenario.name === 'clipped-carrier' ? 512 : 20000,
        false
      )
      const projected = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      const frame = JSON.parse(projected.body)
      const missing = frame.partitions.runtime.decision.missing.some(
        (item) => item.ref === source.id
      )
      assert.equal(missing, !scenario.complete)
      if (scenario.complete) {
        const shown = historyEntries(projected).find((entry) => entry.ref.id === lastCarrier.id)
        assert(shown)
        assert(shown.text.includes('memory-page'))
        // The same accepted provider carrier must satisfy the actual completion gate.
        const events = []
        for await (const event of f.session.submit('Finish the synthetic page-lineage task.'))
          events.push(event)
        assert.equal(f.requests.length, 1)
        const accepted = JSON.parse(
          f.requests[0].materials.find((material) => material.origin === 'runtime-view').text
        )
        assert(!accepted.partitions.runtime.decision.missing.some((item) => item.ref === source.id))
        assert(events.some((event) => event.type === 'verification' && event.completed))
      }
    })
  }
})

test('INV-75 authenticated page lineage rejects stale or foreign inner receipts behind a valid outer page', async (t) => {
  for (const scenario of ['cross-session', 'task-reset', 'search-reset']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const value = '同内容不能转移来源权限😀\n'.repeat(50)
      const original = await archiveRequired(f, programs, [value], 512)
      const pointer = '/output/blocks/0/value'
      const inner = await f.memory.readMaterial(original, 0, 12000, signal, pointer)
      let target = original
      if (scenario === 'cross-session') inner.delivery.receipt.sessionId = 'foreign-session'
      else {
        if (scenario === 'task-reset') {
          const input = await f.session.context.append({
            kind: 'user',
            body: 'A new synthetic task',
          })
          await f.session.view.end()
          await f.session.view.begin(input.ref, signal, 'new')
        } else {
          await f.session.context.append({
            kind: 'audit',
            title: 'search:history-reset',
            body: 'The host changes the authorization epoch',
          })
        }
        target = await archiveRequired(f, programs, [value], 512)
      }
      const firstCarrier = await archiveRequired(f, programs, [inner], 512)
      const outer = await f.memory.readMaterial(firstCarrier, 0, 12000, signal, pointer)
      assert(outer.delivery?.receipt)
      assert.equal(outer.offset, 0)
      assert.equal(outer.text.length, outer.totalChars)
      const lastCarrier = await archiveRequired(f, programs, [outer], 20000, false)
      const projected = await programs.project(requiredView(), undefined, [], signal, 600000)
      const shown = JSON.parse(projected.body).results.find((item) => item.ref === lastCarrier.id)
      // The current, authentic complete outer page is accepted by readDelivery;
      // only the nested receipt is rejected by its own session/epoch check.
      assert(shown.outputProofs.some((proof) => proof.ref === firstCarrier.id))
      assert(!shown.outputProofs.some((proof) => proof.ref === original.id))
      const frame = JSON.parse(
        (await f.memory.project(requiredView(), undefined, [], signal, 600000)).body
      )
      assert(frame.partitions.runtime.decision.missing.some((item) => item.ref === target.id))
      assert.equal(f.requests.length, 0)
    })
  }
})

function acceptedMemoryRequest(frame) {
  return {
    compiledPrompt: frame.prompt,
    history: frame.history,
    instructions: 'synthetic accepted request',
    materials: [
      { origin: 'runtime-view', ref: 'synthetic', text: frame.body, totalChars: frame.body.length },
    ],
    response: { type: 'text' },
    mode: 'work',
    outputTokens: 100,
  }
}

test('INV-75 full recalled carriers beyond the logical entry cap reach actual acceptance and completion', async (t) => {
  for (const value of [
    { ok: true, text: 'u'.repeat(24000) },
    Array.from({ length: 650 }, (_, index) => ({ index, text: '异质😀'.repeat(4) })),
  ]) {
    await t.test(Array.isArray(value) ? 'array' : 'object', async (t) => {
      const f = await fixture(
        t,
        async function* (request, count) {
          if (count === 1) {
            yield turn(request, {
              execute: { source: 'import {output} from "velaros";output("accepted boundary");' },
            })
            yield { type: 'finish', reason: 'stop' }
          } else yield* done(request)
        },
        {
          limits: {
            turns: 4,
            outputTokens: 2048,
            safetyTokens: 1024,
            projectionChars: 600000,
            recoveryChars: 6000,
            timeoutMs: 20000,
          },
        }
      )
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(f, programs, [value], 512)
      const executed = await f.session.execute(
        {
          source: `import {output} from 'velaros';import {memory} from 'velaros:system';output.configure({maxChars:30000});const page=await memory.read({ref:${JSON.stringify(source.id)},pointer:'/output/blocks/0/value',limit:30000});output(page,{key:'carrier',view:{mode:'full'}});`,
        },
        'task'
      )
      assert(executed.checked && !executed.result?.failed)
      const events = []
      for await (const event of f.session.submit('Complete the synthetic delivery task.'))
        events.push(event)
      assert.equal(f.requests.length, 2)
      const first = f.requests[0]
      const current = JSON.parse(
        first.materials.find((item) => item.origin === 'runtime-view').text
      )
      const carrier = current.partitions.recent.results.find(
        (item) => item.ref === executed.resultRef
      )
      assert.equal(carrier.representation, 'full')
      assert.equal(carrier.truncated, false)
      assert(carrier.text.length > 24000)
      assert(
        !historyEntries(first).some(
          (item) => item.ref?.id === executed.resultRef && item.bodyIncluded
        )
      )
      const identity = (message) => {
        const copy = { ...message }
        delete copy.cacheBreakpoint
        return JSON.stringify(copy)
      }
      const accepted = modelRequestEncoder.messages(first).at(-1)
      if (!f.requests[1].history.some((message) => identity(message) === identity(accepted))) {
        // 暂态帧超过开销阈值时重建；超出逻辑条目上限的正文必须完整重新出线。
        const next = JSON.parse(
          f.requests[1].materials.find((item) => item.origin === 'runtime-view').text
        )
        const delivered = next.partitions.recent.results.find(
          (item) => item.ref === executed.resultRef
        )
        assert.equal(delivered.representation, 'full')
        assert.equal(delivered.truncated, false)
        assert.equal(delivered.text, carrier.text)
        assert(
          modelRequestEncoder
            .messages(f.requests[1])
            .some(
              (message) =>
                typeof message.content === 'string' &&
                (message.content.includes(carrier.text) ||
                  message.content.includes(JSON.stringify(carrier.text).slice(1, -1)))
            )
        )
      }
      for (const request of f.requests) {
        const frame = JSON.parse(
          request.materials.find((item) => item.origin === 'runtime-view').text
        )
        assert(!frame.partitions.runtime.decision.missing.some((gap) => gap.ref === source.id))
      }
      assert(events.some((event) => event.type === 'verification' && event.completed))
    })
  }
})

test('INV-75 accepted carrier reuse requires exact actual history and current lifetime', async (t) => {
  for (const scenario of ['unsent', 'drop', 'changed', 'wrong-role', 'release']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t)
      const programs = new ProgramContext('s', f.session.context, f.storage)
      const source = await archiveRequired(f, programs, [{ text: 'bound page'.repeat(2500) }], 512)
      const page = await f.memory.readMaterial(source, 0, 30000, signal, '/output/blocks/0/value')
      const carrier = await archiveRequired(f, programs, [page], 30000, false)
      const first = await f.memory.project(requiredView(), undefined, [], signal, 600000)
      const resolved = await f.memory.reconcile(first.body, first.history, undefined, signal)
      const request = acceptedMemoryRequest({ ...first, ...resolved })
      if (scenario !== 'unsent')
        await f.memory.acknowledge(JSON.parse(first.body).frameId, signal, request)
      let accepted = modelRequestEncoder.messages(request).at(-1)
      if (scenario === 'changed') accepted = { ...accepted, content: `${accepted.content}changed` }
      if (scenario === 'wrong-role') accepted = { ...accepted, role: 'assistant' }
      if (scenario === 'release') await f.memory.retainMaterial(carrier, null, signal)
      const next = await f.memory.project(requiredView(), undefined, [], signal, 6000)
      const actual = ['drop', 'unsent'].includes(scenario)
        ? next.history
        : [...next.history, accepted]
      const result = await f.memory.reconcile(next.body, actual, undefined, signal)
      assert(
        JSON.parse(result.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      assert.equal(f.requests.length, 0)
    })
  }
})

test('INV-75 unchanged accepted rounds do not duplicate proof carriers or ranges', async (t) => {
  const f = await fixture(t)
  const programs = new ProgramContext('s', f.session.context, f.storage)
  const source = await archiveRequired(f, programs, [{ text: 's'.repeat(24000) }], 512)
  const page = await f.memory.readMaterial(source, 0, 30000, signal, '/output/blocks/0/value')
  await archiveRequired(f, programs, [page], 30000, false)
  await archiveRequired(f, programs, ['small full required value'], 8000)
  let previous
  let history
  let firstCount
  for (let round = 0; round < 6; round++) {
    const projected = await f.memory.project(requiredView(), undefined, [], signal, 600000)
    history ??= projected.history
    const frame = await f.memory.reconcile(projected.body, history, previous, signal)
    const request = acceptedMemoryRequest({ ...frame, history })
    await f.memory.acknowledge(JSON.parse(frame.body).frameId, signal, request)
    const saved = (await f.storage.load('s')).records.findLast(
      (item) => item.title === 'context:delivered'
    )
    const accepted = JSON.parse(await f.storage.get('s', saved.objectId)).accepted.carriers
    const identities = accepted.flatMap((item) =>
      item.proofs.map((proof) => JSON.stringify([item.message, proof]))
    )
    assert.equal(new Set(identities).size, identities.length)
    firstCount ??= identities.length
    assert.equal(identities.length, firstCount)
    assert(
      !JSON.parse(frame.body).partitions.runtime.decision.missing.some(
        (gap) => gap.ref === source.id
      )
    )
    history = [...history, modelRequestEncoder.messages(request).at(-1)]
    previous = frame.body
  }
  assert.equal(f.requests.length, 0)
})

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

test('INV-69 an authorization reset during projection drops stale retained output and goals', async (t) => {
  for (const required of [true, false]) {
    await t.test(required ? 'required' : 'optional', async (t) => {
      const f = await fixture(t)
      const input = (await f.storage.load('s')).records.findLast((item) => item.kind === 'user')
      await f.session.view.begin(input.ref, signal)
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
      const value = 'RESET_RACE_ORIGINAL_BODY\n'.repeat(200)
      const original = await archiveRequired(f, programs, [value], 30000, required)
      const view = await f.session.view.build({ maxChars: 200000, visibleExecutionIds: [] }, signal)
      const first = await memory.project(view, undefined, [], signal, 600000)
      await memory.acknowledge(JSON.parse(first.body).frameId, signal)
      assert(
        historyEntries(first).some(
          (entry) => entry.ref?.id === original.id && entry.text.includes(value)
        )
      )
      const project = programs.project.bind(programs)
      const retainedCounts = []
      let current
      programs.project = async (...args) => {
        const result = await project(...args)
        retainedCounts.push(args[5]?.length ?? 0)
        if (retainedCounts.length === 1) {
          assert(retainedCounts[0] > 0, 'the old frozen body was considered before the reset')
          // A trusted host may append an authorization event while a projection is awaiting I/O.
          await f.session.context.append({
            kind: 'audit',
            title: 'search:history-reset',
            body: 'The host starts a new authorization epoch during projection',
          })
          // Equal text under the new identity cannot inherit the old full block proof.
          current = await archiveRequired(f, programs, [value], 512)
        }
        return result
      }
      const next = await memory.project(view, undefined, [], signal, 600000)
      const frame = JSON.parse(next.body)
      const outgoing = JSON.stringify({
        body: next.body,
        prompt: next.prompt,
        history: next.history,
      })
      assert.equal(retainedCounts.length, 2, 'a changed carrier causes one bounded local rebuild')
      assert.equal(retainedCounts[1], 0, 'the rebuilt projection carries no old frozen coverage')
      assert.equal(await f.session.view.validate(view, signal), true)
      assert(!frame.partitions.recent.results.some((item) => item.ref === original.id))
      assert(!frame.partitions.task.goals.some((item) => item.record.ref.id === input.ref.id))
      assert(
        !historyEntries(next).some(
          (entry) => entry.ref?.id === original.id || entry.ref?.id === input.ref.id
        )
      )
      assert(!outgoing.includes('RESET_RACE_ORIGINAL_BODY'))
      assert(!outgoing.includes('Investigate without losing progress'))
      const currentArchive = JSON.parse((await f.session.context.read(current)).text)
      const expected = scriptOutputs.project(
        currentArchive.output,
        current.id,
        512,
        undefined,
        undefined,
        undefined,
        'text'
      )
      const actual = historyEntries(next).find((entry) => entry.ref?.id === current.id)
      for (const item of frame.partitions.recent.results.filter((item) => item.bodyInHistory)) {
        assert.equal(item.ref, current.id, 'history coverage belongs to the new result identity')
        assert.equal(actual?.bodyIncluded, true)
        assert.equal(actual.text, expected.prompt, 'the exact new reference encoding was delivered')
      }
      assert(expected.blocks.every((block) => !block.bodyIncluded))
      assert(
        frame.partitions.runtime.decision.missing.some((item) => item.ref === current.id),
        'an unseen required result in the new epoch retains its own completion gap'
      )
      assert(!frame.partitions.runtime.decision.missing.some((item) => item.ref === original.id))
      await memory.acknowledge(frame.frameId, signal)
      const frozen = await recent.segment(signal)
      assert(
        frozen.entries.every(
          (entry) =>
            !entry.outputProofs?.some((proof) => [original.id, current.id].includes(proof.ref))
        ),
        'an actually delivered reference encoding mints no complete block proof'
      )
      assert.equal(
        f.requests.length,
        0,
        'local rebuilding and authorization checks do not call a model'
      )
    })
  }
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
  // 当前任务租约仍可在新段重新完整交付载体；这里明确释放它，验证没有载体的缺口。
  await programs.release(carrier.id, signal)
  assert(await f.memory.fold('runway', 20000, signal))
  const folded = await f.memory.project(requiredView(), undefined, [], signal, 20000)
  const foldedGaps = JSON.parse(folded.body).partitions.runtime.decision.missing
  for (const ref of [source, other, changed]) assert(foldedGaps.some((gap) => gap.ref === ref.id))
  assert(
    !historyEntries(folded)
      .find((entry) => entry.ref?.id === carrier.id)
      ?.text.includes(page.text)
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
  const next = await f.memory.project(view, undefined, [], signal, 256)
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
    const mismatch = await f.memory.project(view, undefined, [], signal, 256)
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
  const omitted = await noHistory.project(view, undefined, [], signal, 4000)
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
  const folded = await f.memory.project(view, undefined, [], signal, 4000)
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
  assert.match(baseText(request), /runtime-segment-base/)
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
  const before = await f.memory.project(requiredView(), undefined, [], signal, 2000)
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
      const first = 'COVERED_FIRST "界😀"\n'.repeat(300)
      const second = 'KEEP_SECOND_NEW_CONTENT\n'.repeat(300)
      // Freeze a real short body while the required large blocks remain unavailable.
      const source = await archiveRequired(f, programs, [first, second, 'INITIAL_ANCHOR'], 40000)
      const other =
        scenario === 'same-value-other-ref'
          ? await archiveRequired(f, programs, [first, 'OTHER_INITIAL_ANCHOR'], 40000)
          : undefined
      const initial = await f.memory.project(requiredView(), undefined, [], signal, 10000)
      assert(
        JSON.parse(initial.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      await f.memory.acknowledge(JSON.parse(initial.body).frameId, signal)
      assert(historyEntries(initial).find((entry) => entry.ref?.id === source.id)?.bodyIncluded)
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
      const value = 'KEEP_ORIGINAL_WITHOUT_FULL_COVERAGE\n'.repeat(300)
      const source = await archiveRequired(f, programs, [value, 'INITIAL_ANCHOR'], 20000)
      const initial = await f.memory.project(requiredView(), undefined, [], signal, 6000)
      assert(
        JSON.parse(initial.body).partitions.runtime.decision.missing.some(
          (gap) => gap.ref === source.id
        )
      )
      await f.memory.acknowledge(JSON.parse(initial.body).frameId, signal)
      assert(historyEntries(initial).find((entry) => entry.ref?.id === source.id)?.bodyIncluded)
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

/** 当前视图测试用的最小分区材料；只放渲染用到的字段。 */
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

/** 仅从实际展示过的完整快照恢复未变任务，不能借用原始内部帧。 */
function nodeTaskSnapshot(prompt, history = []) {
  const heading = 'task（earlier 为此前运行的输入）：\n'
  if (!prompt.includes(heading))
    assert(prompt.includes('task：与本次请求中最近的完整 task 相同（内容、状态和顺序均未变）。'))
  const snapshot = [...history, prompt].findLast((item) => item.includes(heading))
  assert(snapshot, 'the actual request must retain a complete task snapshot')
  return JSON.parse(snapshot.split(heading)[1].split('\n')[0])
}

test('INV-74 Node task reuse retains a complete snapshot while current runtime failures change', () => {
  const task = {
    goals: [],
    active: {
      revision: 4,
      items: [
        {
          id: 'work',
          text: 'Check every public entry point and preserve its behavior. '.repeat(12),
        },
      ],
      status: 'running',
      pendingInputs: [{ sessionId: 's', id: 'input' }],
    },
    future: { zero: 0, empty: [], value: null, flag: false },
  }
  const body = frameBody({ presentation: 'node', 'partitions.task': task })
  const history = [memoryPrompt(body)]
  let previous = body
  for (const failure of ['FIRST_FAILURE', 'SECOND_FAILURE', 'THIRD_FAILURE']) {
    const current = frameBody({
      presentation: 'node',
      'partitions.task': task,
      'partitions.runtime.mandatory': [{ id: failure, outcome: 'failed', code: 'CONFLICT' }],
      'partitions.runtime.gaps': [{ reason: failure }],
    })
    const prompt = memoryPrompt(current, previous)
    assert(!prompt.includes(task.active.items[0].text))
    assert.deepEqual(nodeTaskSnapshot(prompt, history), task)
    const runtime = JSON.parse(prompt.split('runtime：\n')[1].split('\n')[0])
    assert.equal(runtime.mandatory[0].id, failure)
    assert.deepEqual(runtime.gaps, [{ reason: failure }])
    history.push(prompt)
    previous = current
  }
  assert.deepEqual(JSON.parse(body).partitions.task, task)
})

test('INV-74 Node task changes always send a full snapshot including removals and ordered duplicates', () => {
  const task = {
    goals: [],
    active: {
      revision: 4,
      status: 'running',
      items: [
        { id: 'a', text: 'FIRST_TASK_BODY '.repeat(30) },
        { id: 'b', text: 'SECOND_TASK_BODY '.repeat(30) },
        { id: 'a', text: 'FIRST_TASK_BODY '.repeat(30) },
      ],
      pendingInputs: [{ sessionId: 's', id: 'pending' }],
    },
    future: { 'x/~': [0, null, false] },
  }
  const original = frameBody({ presentation: 'node', 'partitions.task': task })
  for (const change of [
    (value) => {
      value.active.items.splice(1, 1)
    },
    (value) => {
      ;[value.active.items[0], value.active.items[1]] = [
        value.active.items[1],
        value.active.items[0],
      ]
    },
    (value) => {
      value.active.items[0].text += ' corrected'
    },
    (value) => {
      value.active.items = []
    },
    (value) => {
      value.active.status = 'complete'
    },
    (value) => {
      value.active.revision++
    },
    (value) => {
      value.active.pendingInputs = []
    },
    (value) => {
      value.future['x/~'] = [false, null, 0]
    },
    (value) => {
      delete value.future
    },
  ]) {
    const current = structuredClone(task)
    change(current)
    const prompt = memoryPrompt(
      frameBody({ presentation: 'node', 'partitions.task': current }),
      original
    )
    assert(prompt.includes('task（earlier 为此前运行的输入）：\n'))
    assert.deepEqual(nodeTaskSnapshot(prompt), current)
  }
  assert.deepEqual(JSON.parse(original).partitions.task, task)
})

test('INV-74 Node task reuse requires retained Node history and a substantial repeated body', () => {
  const task = {
    goals: [],
    active: { items: [{ id: 'item', text: 'FULL_TASK_BODY '.repeat(40) }] },
  }
  const node = frameBody({ presentation: 'node', 'partitions.task': task })
  const legacy = frameBody({ 'partitions.task': task })
  assert(memoryPrompt(node, node).includes('task：与本次请求中最近的完整 task 相同'))
  for (const previous of [undefined, legacy])
    assert.deepEqual(nodeTaskSnapshot(memoryPrompt(node, previous)), task)
  assert.deepEqual(section(memoryPrompt(legacy, node), 'task'), task)
  const small = frameBody({ presentation: 'node', 'partitions.task': { goals: [] } })
  assert.deepEqual(nodeTaskSnapshot(memoryPrompt(small, small)), { goals: [] })
})

// 当前决定仅靠最新状态可恢复；未变的正文仍由保留的历史消息承载。
function section(prompt, name) {
  return JSON.parse(prompt.split(new RegExp(`分区 ${name}[^\\n]*：\\n`, 'u'))[1].split('\n')[0])
}

test('INV-74 current state is self-contained while unchanged result and observation bodies remain in history', () => {
  const failed = {
    id: 'failed',
    executionId: 'e1',
    operation: 'files.write',
    outcome: 'failed',
    effect: 'none',
    code: 'CONFLICT',
    detail: 'DIAGNOSTIC',
  }
  const before = frameBody({
    'partitions.runtime.mandatory': [failed],
    'partitions.runtime.children': [{ id: 'child', status: 'waiting' }],
    'partitions.runtime.gaps': [{ reason: 'required-body-missing' }],
    'partitions.observation': {
      sourceRef: 'observer',
      resultRef: 'observed',
      source: 'readCurrent()',
      text: 'OBSERVED-BODY',
      observedAt: 'T1',
    },
    'partitions.recent.results': [{ ref: 'result', text: 'LARGE-RESULT', source: 'readFile()' }],
  })
  const current = frameBody({
    'partitions.runtime.mandatory': [failed],
    'partitions.runtime.children': [{ id: 'child', status: 'waiting' }],
    'partitions.runtime.gaps': [{ reason: 'required-body-missing' }],
    'partitions.observation': {
      sourceRef: 'observer',
      resultRef: 'observed',
      source: 'readCurrent()',
      text: 'OBSERVED-BODY',
      observedAt: 'T1',
    },
    'partitions.recent.results': [
      { ref: 'result', text: 'LARGE-RESULT', source: 'readFile()', remainingTurns: 2 },
    ],
  })
  const prompt = memoryPrompt(current, before)
  for (const partition of ['task', 'workspace', 'observation', 'recent', 'runtime'])
    assert(section(prompt, partition))
  const runtime = section(prompt, 'runtime')
  assert.equal(runtime.mandatory[0].code, 'CONFLICT')
  assert.equal(runtime.mandatory[0].detailInEarlierFrame, true)
  assert.deepEqual(runtime.children, [{ id: 'child', status: 'waiting' }])
  assert.deepEqual(runtime.gaps, [{ reason: 'required-body-missing' }])
  assert(!prompt.includes('DIAGNOSTIC'))
  assert(!prompt.includes('LARGE-RESULT'))
  assert(!prompt.includes('OBSERVED-BODY'))
  assert(!prompt.includes('readCurrent()'))
  assert(!prompt.includes('readFile()'))
  assert.match(prompt, /"remainingTurns":2/)
  assert.deepEqual(section(prompt, 'runtime').environment, {
    os: 'linux x64',
    shell: 'posix',
    time: 'T1',
  })
  assert.equal(section(prompt, 'observation').outputInEarlierFrame, true)
  assert.match(memoryPrompt(current), /DIAGNOSTIC/)
  assert.match(memoryPrompt(current), /LARGE-RESULT/)
  assert.match(memoryPrompt(current), /OBSERVED-BODY/)
  const changed = JSON.parse(current)
  changed.partitions.observation.text = 'CHANGED-OBSERVATION'
  changed.partitions.recent.results[0].text = 'CHANGED-RESULT'
  changed.partitions.runtime.mandatory[0].detail = 'CHANGED-DIAGNOSTIC'
  const updated = memoryPrompt(JSON.stringify(changed), current)
  assert.match(updated, /CHANGED-OBSERVATION/)
  assert.match(updated, /CHANGED-RESULT/)
  assert.match(updated, /CHANGED-DIAGNOSTIC/)
})

test('INV-74 retained maintenance material reuses only matching delivered ranges and rematerializes on rebuild', () => {
  const original = 'Exact material including 😀, quotes " and newlines\n'.repeat(80)
  const page = {
    ref: { sessionId: 'parent', id: 'input' },
    offset: 0,
    totalChars: original.length,
    text: original,
    nextOffset: null,
  }
  const material = {
    kind: 'context-maintenance',
    baseRevision: 'snapshot-one',
    inputs: [page],
    recent: [{ ...page, ref: { sessionId: 'parent', id: 'receipt' }, sequence: 5 }],
    future: { empty: [], zero: 0, flag: false },
  }
  const body = (value) => frameBody({ 'partitions.runtime.modelTool': value })
  const current = body(material)
  const shown = section(memoryPrompt(current, current), 'runtime').modelTool
  assert.equal(shown.inputs[0].text, undefined)
  assert.equal(shown.inputs[0].bodyInEarlierFrame, true)
  assert.equal(shown.inputs[0].shownChars, original.length)
  assert.equal(shown.recent[0].bodyInEarlierFrame, true)
  assert.deepEqual(shown.future, material.future)
  assert.equal(section(memoryPrompt(current), 'runtime').modelTool.inputs[0].text, original)
  assert.equal(JSON.parse(current).partitions.runtime.modelTool.inputs[0].text, original)
  const partial = structuredClone(material)
  partial.inputs[0] = { ...page, offset: 10, text: original.slice(10, 100), nextOffset: 100 }
  assert.equal(
    section(memoryPrompt(body(partial), current), 'runtime').modelTool.inputs[0].shownChars,
    90
  )
  for (const change of [
    (value) => {
      value.baseRevision = 'snapshot-two'
    },
    (value) => {
      value.kind = 'other-tool'
    },
    (value) => {
      value.inputs[0].ref.sessionId = 'another-parent'
    },
    (value) => {
      value.inputs[0].ref.id = 'another-input'
    },
    (value) => {
      value.inputs[0].totalChars++
    },
    (value) => {
      value.inputs[0].text = ''
    },
    (value) => {
      value.inputs[0].text = 'CHANGED'
    },
    (value) => {
      value.inputs[0].offset = original.length
    },
  ]) {
    const changed = structuredClone(material)
    change(changed)
    const delivered = section(memoryPrompt(body(changed), current), 'runtime').modelTool.inputs[0]
    assert.equal(delivered.text, changed.inputs[0].text)
    assert.equal(delivered.bodyInEarlierFrame, undefined)
  }
  const gap = structuredClone(material)
  gap.inputs[0].offset = 20
  gap.inputs[0].text = original.slice(20)
  assert.equal(
    section(memoryPrompt(current, body(gap)), 'runtime').modelTool.inputs[0].text,
    original,
    'a partial prior page does not replace a full current page'
  )
})

test('INV-74 reference-only materials never claim delivery and source delivery is distinct from output', () => {
  const frame = frameBody({
    'partitions.workspace.notes': [
      {
        key: 'reference-note',
        revision: 1,
        ref: { sessionId: 's', id: 'n' },
        text: '',
        bodyIncluded: false,
      },
    ],
    'partitions.recent.results': [
      { ref: 'reference-result', text: '', source: '', bodyIncluded: false },
      { ref: 'source-only-result', text: '', source: 'readSourceOnly()', bodyIncluded: false },
      { ref: 'output-only-result', text: 'ACTUAL-OUTPUT', source: '', bodyIncluded: true },
    ],
    'partitions.runtime.gaps': [{ ref: 'reference-result', reason: 'required-body-missing' }],
  })
  const prompt = memoryPrompt(frame, frame)
  const cards = prompt
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
  const note = cards.find((card) => card.key === 'reference-note')
  assert.equal(note.bodyInEarlierFrame, undefined)
  const reference = cards.find((card) => card.ref === 'reference-result')
  assert.equal(reference.bodyInEarlierFrame, false)
  assert.equal(reference.sourceInEarlierFrame, false)
  const source = cards.find((card) => card.ref === 'source-only-result')
  assert.equal(source.bodyInEarlierFrame, false)
  assert.equal(source.sourceInEarlierFrame, true)
  const output = cards.find((card) => card.ref === 'output-only-result')
  assert.equal(output.bodyInEarlierFrame, true)
  assert.equal(output.sourceInEarlierFrame, false)
  assert.equal(section(prompt, 'observation').sourceInEarlierFrame, false)
  assert.equal(section(prompt, 'observation').outputInEarlierFrame, false)
  assert.deepEqual(section(prompt, 'runtime').gaps, [
    { ref: 'reference-result', reason: 'required-body-missing' },
  ])
  assert(!prompt.includes('ACTUAL-OUTPUT'))
  assert(!prompt.includes('readSourceOnly()'))
  assert.match(memoryPrompt(frame), /ACTUAL-OUTPUT/)
  assert.match(memoryPrompt(frame), /readSourceOnly\(\)/)
})

test('INV-74 actual structured reference presentations distinguish metadata from delivered bodies', () => {
  for (const format of ['json', 'text'])
    for (const mode of ['reference', 'full']) {
      const projection = scriptOutputs.project(
        {
          config: {},
          issues: [],
          blocks: [
            { key: 'item', value: 'RAW-BODY', chars: 10, options: { key: 'item', view: { mode } } },
          ],
        },
        'actual-result',
        4096,
        undefined,
        undefined,
        undefined,
        format
      )
      const bodyIncluded = projection.blocks.some((block) => block.bodyIncluded)
      const frame = frameBody({
        'partitions.observation': {
          sourceRef: 'observer',
          resultRef: 'actual-result',
          source: '',
          text: projection.prompt,
          blocks: projection.blocks.map((block) => ({ bodyIncluded: block.bodyIncluded })),
          presentation: { format },
        },
        'partitions.recent.results': [
          {
            ref: 'actual-result',
            text: projection.prompt,
            structuredOutput: true,
            outputFormat: format,
            bodyIncluded,
          },
        ],
        'partitions.runtime.gaps': bodyIncluded
          ? []
          : [{ ref: 'actual-result', reason: 'required-body-missing' }],
      })
      const prompt = memoryPrompt(frame, frame)
      const observation = section(prompt, 'observation')
      assert.equal(observation.outputInEarlierFrame, bodyIncluded)
      assert.equal(observation.outputPresentationInEarlierFrame, true)
      const result = prompt
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((card) => card.ref === 'actual-result')
      assert.equal(result.bodyInEarlierFrame, bodyIncluded)
      assert.equal(result.presentationInEarlierFrame, true)
      assert(!prompt.includes('RAW-BODY'))
      assert.equal(memoryPrompt(frame).includes('RAW-BODY'), bodyIncluded)
      assert.equal(section(prompt, 'runtime').gaps.length, bodyIncluded ? 0 : 1)
    }
})

test('INV-74 newly included bodies cannot inherit delivery from identical prior reference metadata', () => {
  const make = (bodyIncluded) =>
    frameBody({
      'partitions.observation': { source: '', text: 'IMAGE-METADATA', blocks: [{ bodyIncluded }] },
      'partitions.workspace.notes': [
        { key: 'note', revision: 1, ref: 'note', text: 'NOTE-METADATA', bodyIncluded },
      ],
      'partitions.recent.results': [{ ref: 'image', text: 'IMAGE-METADATA', bodyIncluded }],
    })
  const prompt = memoryPrompt(make(true), make(false))
  assert.equal(section(prompt, 'observation').outputInEarlierFrame, false)
  assert.equal(section(prompt, 'observation').outputPresentationInEarlierFrame, true)
  const cards = prompt
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
  assert.equal(cards.find((card) => card.ref === 'image').bodyInEarlierFrame, undefined)
  assert.equal(cards.find((card) => card.key === 'note').bodyInEarlierFrame, undefined)
  assert.match(prompt, /NOTE-METADATA/)
  assert.match(prompt, /当次输出：\nIMAGE-METADATA/)
})

test('INV-74 latest lists independently preserve removal, reorder, duplicate identities and empty state', () => {
  const values = ['alpha', { id: 'beta', status: 'waiting' }, null]
  const lists = [[]]
  let layer = [[]]
  for (let length = 1; length <= 3; length++) {
    layer = layer.flatMap((prefix) => values.map((value) => [...prefix, value]))
    lists.push(...layer)
  }
  for (const previous of lists)
    for (const current of lists) {
      const prompt = memoryPrompt(
        frameBody({ 'partitions.runtime.children': current }),
        frameBody({ 'partitions.runtime.children': previous })
      )
      assert.deepEqual(section(prompt, 'runtime').children, current)
    }
  const before = frameBody({
    'partitions.runtime.scope': { version: 1, stale: true },
    'partitions.runtime.environment': { host: 'linux', stale: true },
    'memoryStatus.temporary': true,
  })
  const current = JSON.parse(
    frameBody({
      'partitions.runtime.scope': { version: 2 },
      'partitions.runtime.environment': { host: 'linux' },
    })
  )
  delete current.partitions.runtime.jobs
  const prompt = memoryPrompt(JSON.stringify(current), before)
  assert.deepEqual(section(prompt, 'runtime').environment, { host: 'linux' })
  assert.deepEqual(section(prompt, 'runtime').scope, { version: 2 })
  assert(!Object.hasOwn(section(prompt, 'runtime'), 'jobs'))
  assert(!Object.hasOwn(JSON.parse(prompt.split('内存状态：\n')[1]), 'temporary'))
})

test('INV-74 current note and result directories preserve identities while repeated bodies stay once', () => {
  const a = { key: 'a', revision: 1, ref: { sessionId: 's', id: 'a' }, text: 'NOTE-A' }
  const b = { key: 'b', revision: 2, ref: { sessionId: 's', id: 'b' }, text: 'NOTE-B' }
  const before = frameBody({
    'partitions.workspace.notes': [a, b],
    'partitions.recent.results': [
      { ref: 'a', text: 'RESULT-A' },
      { ref: 'b', text: 'RESULT-B' },
    ],
  })
  for (const notes of [[b, a], [a], [b], [], [b, b]]) {
    const results = notes.map((note) => ({
      ref: note.key,
      text: `RESULT-${note.key.toUpperCase()}`,
    }))
    const prompt = memoryPrompt(
      frameBody({ 'partitions.workspace.notes': notes, 'partitions.recent.results': results }),
      before
    )
    assert.deepEqual(
      section(prompt, 'workspace').shownNotes,
      notes.map(({ key, revision, ref }) => ({ key, revision, ref }))
    )
    assert.deepEqual(
      section(prompt, 'recent').shownResults,
      results.map((item) => item.ref)
    )
    for (const body of ['NOTE-A', 'NOTE-B', 'RESULT-A', 'RESULT-B']) assert(!prompt.includes(body))
  }
  const updated = { ...a, revision: 3, ref: { sessionId: 's', id: 'new-a' }, text: 'NEW-A' }
  assert.match(
    memoryPrompt(frameBody({ 'partitions.workspace.notes': [updated] }), before),
    /NEW-A/
  )
})

test('INV-74 same output body under a new ref is delivered again and failures remain explicit', () => {
  const output = '{"omittedBlocks":0,"displayChars":900}\nBODY'
  const before = frameBody({ 'partitions.recent.results': [{ ref: 'old', text: output }] })
  const current = frameBody({
    'partitions.recent.results': [{ ref: 'new', text: output }],
    'partitions.runtime.mandatory': [
      { id: 'f', outcome: 'unknown', effect: 'unknown', detail: 'UNKNOWN-EFFECT' },
    ],
  })
  const prompt = memoryPrompt(current, before)
  assert.match(prompt, /BODY/)
  assert.match(prompt, /UNKNOWN-EFFECT/)
  const repeated = memoryPrompt(
    frameBody({
      'partitions.recent.results': [{ ref: 'old', text: output.replace('900', '700') }],
    }),
    before
  )
  assert(!repeated.includes('BODY'))
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

test('INV-79 state compilation keeps constraints, failures, gaps and ordered identities while recalling optional detail', async (t) => {
  const f = await fixture(t)
  const optionalBody = 'optional source 😀\r\n'.repeat(1200)
  const requiredBody = 'required diagnostic intact'
  const incompleteBody = 'incomplete source '.repeat(250)
  const evidence = [
    {
      id: 'same-id',
      intentIds: [],
      target: 'optional',
      body: optionalBody,
      hash: 'optional-hash',
      complete: true,
      form: 'text',
      trust: 'external',
      freshness: 'current',
      readSet: Array.from({ length: 80 }, (_, n) => ({ id: `r${n}`, revision: String(n) })),
    },
    {
      id: 'same-id',
      intentIds: ['required'],
      target: 'required',
      body: requiredBody,
      hash: 'required-hash',
      complete: true,
      form: 'text',
      trust: 'external',
      freshness: 'current',
    },
    {
      id: 'unfinished',
      intentIds: [],
      target: 'partial',
      body: incompleteBody,
      complete: false,
      form: 'text',
      trust: 'external',
      freshness: 'unknown',
    },
  ]
  const mandatory = [
    {
      id: 'failed-effect',
      operation: 'domain.write',
      outcome: 'failed',
      effect: 'unknown',
      code: 'UNAVAILABLE',
    },
  ]
  const gaps = [
    { intentId: 'required', required: true, reason: 'missing source', target: 'required' },
  ]
  const view = {
    id: 'budget-test',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory,
    evidence,
    gaps,
    readSet: evidence[0].readSet,
    progress: { step: 1, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const projected = await f.memory.project(view, undefined, [], signal, 12000)
  const raw = JSON.parse(projected.body)
  const archive = raw.memoryStatus.decisionState
  assert(archive?.ref, 'large optional metadata has a source-backed recall archive')
  assert.deepEqual(
    raw.partitions.runtime.evidence,
    evidence,
    'internal source and coverage remain complete'
  )
  assert(projected.prompt.includes(requiredBody))
  assert(projected.prompt.includes(incompleteBody))
  assert(projected.prompt.includes('failed-effect') && projected.prompt.includes('unknown'))
  assert(projected.prompt.includes('missing source'))
  assert(!projected.prompt.includes(optionalBody))
  const recalled = await f.memory.readMaterial(
    archive.ref,
    0,
    optionalBody.length + 1,
    signal,
    '/evidence/0/body'
  )
  assert.equal(recalled.text, optionalBody)
  assert.equal(recalled.totalChars, optionalBody.length)
  assert.equal(recalled.delivery, undefined, 'state detail never signs an execution output proof')
  const repeated = await f.memory.project(view, undefined, [], signal, 12000)
  assert.deepEqual(
    JSON.parse(repeated.body).memoryStatus.decisionState.ref,
    archive.ref,
    'unchanged detail reuses its immutable archive'
  )
  const active = {
    interpretations: [
      { id: 'constraint', kind: 'constraint', text: 'keep protected input byte identical' },
    ],
    pendingInputs: ['user-new'],
    pendingSources: ['source-new'],
  }
  const runtime = {
    ...raw.partitions.runtime,
    children: [{ id: 'child', status: 'running' }],
    jobs: [{ executionId: 'job', status: 'running' }],
  }
  const before = JSON.stringify({ runtime, active })
  const projection = decisionStateProjection(runtime, active, 100)
  assert(projection.overBudget, 'irreducible required state explicitly exceeds a soft budget')
  assert.deepEqual(
    projection.runtime.evidence.map(({ id, target }) => ({ id, target })),
    evidence.map(({ id, target }) => ({ id, target }))
  )
  assert.deepEqual(projection.runtime.mandatory, mandatory)
  assert.deepEqual(projection.runtime.gaps, gaps)
  assert.deepEqual(projection.runtime.children, runtime.children)
  assert.deepEqual(projection.runtime.jobs, runtime.jobs)
  assert.equal(projection.runtime.evidence[1].body, requiredBody)
  assert.equal(projection.runtime.evidence[2].body, incompleteBody)
  assert.equal(
    JSON.stringify({ runtime, active }),
    before,
    'pure projection cannot mutate authoritative state'
  )
  const record = (await f.storage.load('s')).records.find((item) => item.ref.id === archive.ref.id)
  const originalGet = f.storage.get.bind(f.storage)
  let releaseRead
  let notifyRead
  const blockedRead = new Promise((resolve) => {
    releaseRead = resolve
  })
  const enteredRead = new Promise((resolve) => {
    notifyRead = resolve
  })
  f.storage.get = async (id, objectId) => {
    if (objectId === record.objectId) {
      notifyRead()
      await blockedRead
    }
    return originalGet(id, objectId)
  }
  const reading = f.memory.readMaterial(archive.ref, 0, 100, signal, '/evidence/0/body')
  await enteredRead
  const user = await f.session.context.append({ kind: 'user', body: 'new independent task' })
  await f.session.view.begin(user.ref, signal, 'new')
  releaseRead()
  await assert.rejects(reading, { code: 'SCOPE_MISMATCH' }, 'late read cannot cross a task reset')
  f.storage.get = originalGet
  const late = await f.session.context.append({
    kind: 'audit',
    title: 'context:decision-state:none:0',
    body: JSON.stringify({ evidence }),
  })
  await assert.rejects(f.memory.readMaterial(late.ref, 0, 100, signal), { code: 'SCOPE_MISMATCH' })
})

test('INV-79 small state remains full and full policy preserves large optional source for ablation', async (t) => {
  const body = 'stable optional detail '.repeat(500)
  const view = {
    id: 'full-state',
    scope: { sessionId: 's', revision: 0 },
    goals: [],
    capsule: {},
    mandatory: [],
    evidence: [{ id: 'large', body, complete: true, intentIds: [], readSet: [] }],
    gaps: [],
    readSet: [],
    progress: { step: 0, repeatedSteps: 0, stalled: false, evidence: [] },
  }
  const f = await fixture(t, undefined, { context: { memory: { stateDetails: 'full' } } })
  const frame = await f.memory.project(view, undefined, [], signal, 12000)
  assert.equal(JSON.parse(frame.body).memoryStatus.decisionState, undefined)
  assert(frame.prompt.includes(body))
  const small = {
    mandatory: [{ id: 'important', effect: 'unknown' }],
    readSet: [{ id: 'source' }],
    evidence: [{ id: 'short', body: 'one fact', complete: true }],
    progress: { script: { changed: true, patch: 'short patch' } },
  }
  const projection = decisionStateProjection(small, { constraints: ['keep'] }, 10000)
  assert.equal(projection.savedChars, 0)
  assert.equal(projection.overBudget, false)
  assert.deepEqual(projection.runtime, small)
  assert.deepEqual(projection.details, [])
})

test('full assistant history preserves original prose and JSON without adding runtime metadata', async (t) => {
  const f = await fixture(t)
  const bodies = [
    '第一项工作已完成，继续核对。',
    '{"origin":"assistant-script"}\n用户要求返回的 JSON 示例',
    '{"representation":"excerpt"}\n这是用户数据，不是历史条目元信息。',
  ]
  for (const body of bodies) await f.session.context.append({ kind: 'assistant', body })
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
  const frame = await f.memory.project(view, undefined, [], signal, 24000)
  assert.deepEqual(
    frame.history.filter((item) => item.role === 'assistant').map((item) => item.content),
    bodies
  )
  const recent = new RecentContext('s', f.session.context, f.storage)
  const segment = await recent.segment(signal)
  assert(segment)
  const first = await recent.project({ ...segment, entries: [] }, [], 24000, signal)
  const frozen = await recent.project({ ...segment, entries: first.fresh }, [], 24000, signal)
  assert.deepEqual(
    frozen.messages.filter((item) => item.role === 'assistant').map((item) => item.content),
    bodies
  )
  assert(
    frozen.items
      .filter((item) => item.role === 'assistant')
      .every((item) => item.representation === 'full')
  )
})
