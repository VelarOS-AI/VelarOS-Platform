import { expect, test } from 'bun:test'

import type {
  ContextInvocationJournalApi,
  ContextRecord,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { createContextInvocationJournal, createContextRuntime } from '@velaros-ai/context'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { RuntimeTrace } from '../impl/RuntimeTrace.js'
import {
  modelAccounting,
  summarizeVerificationAttempt,
  summarizeVerificationCosts,
} from '../utils/trace-accounting.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

const cost = (coverage = 'complete', amount: number | undefined = 2, id = 'charge-1') => ({
  coverage,
  charges: [
    {
      id,
      kind: 'external',
      currency: 'USD',
      basis: 'actual',
      ...(amount === undefined ? {} : { amount }),
    },
  ],
})
const attempt = (phase: string, overrides: Record<string, unknown> = {}) => ({
  attemptId: 'a',
  taskId: 'task',
  checkId: 'check',
  scope: 'artifact',
  verifierId: 'provider',
  verifierVersion: 'v1',
  phase,
  mode: 'executed',
  status: phase === 'started' ? 'pending' : 'passed',
  applicability: 'current',
  startedAt: '2026-10-01T00:00:00Z',
  settledAt: '2026-10-01T00:00:01Z',
  durationMs: 10,
  probeMs: 4,
  runMs: 6,
  cost: phase === 'started' ? { coverage: 'unknown', charges: [] } : cost(),
  ...overrides,
})
const events = (...values: unknown[]) =>
  values.map((value, index) => ({ value, ref: { sessionId: 's', id: `phase-${index}` } }))

test('request accounting retains rejected measured zero and never fills unknown cache fields', () => {
  expect(
    modelAccounting(
      {
        status: 'rejected',
        usage: { inputTokens: 0, outputTokens: 0 },
        error: { code: 'CANCELLED' },
      },
      false
    )
  ).toMatchObject({
    status: 'settled',
    outcome: 'rejected',
    usage: {
      coverage: 'known',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    },
  })
  expect(modelAccounting({ status: 'accepted' }, false).usage).toEqual({
    coverage: 'unknown',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  })
  expect(modelAccounting(undefined, true).usage.coverage).toBe('inflight')
  expect(modelAccounting(undefined, false).status).toBe('unknown')
})

test('settled replaces started, late charge cannot complete unknown scope, and phases are not added', () => {
  const complete = summarizeVerificationAttempt(events(attempt('started'), attempt('settled')))!
  expect(complete.cost.coverage).toBe('complete')
  expect(complete.cost.totals[0].amount).toBe(2)
  const cancelled = summarizeVerificationAttempt(
    events(
      attempt('started'),
      attempt('settled', { status: 'cancelled', cost: { coverage: 'unknown', charges: [] } }),
      attempt('late-result', { status: 'passed', durationMs: 20, probeMs: 4, runMs: 16 })
    )
  )!
  expect(cancelled.status).toBe('cancelled')
  expect(cancelled.cost.coverage).toBe('partial')
  expect(cancelled.cost.totals[0].amount).toBe(2)
  expect([cancelled.durationMs, cancelled.probeMs, cancelled.runMs]).toEqual([20, 4, 16])
  expect(cancelled.phases).toEqual(['started', 'settled', 'late-result'])
})

test('reused and probed attempts bill only their own charges and global charge IDs deduplicate', () => {
  const reused = summarizeVerificationAttempt(
    events(
      attempt('started'),
      attempt('settled', {
        mode: 'reused',
        runMs: 0,
        cost: cost('complete', 0.2, 'probe'),
        check: {
          reusedFrom: { sessionId: 's', id: 'prior-expensive-proof' },
          cost: cost('complete', 100),
        },
      })
    )
  )!
  const probed = summarizeVerificationAttempt(
    events(
      attempt('started'),
      attempt('settled', { mode: 'probed', runMs: 0, cost: cost('complete', 0.2, 'probe') })
    )
  )!
  expect(summarizeVerificationCosts([reused.cost, probed.cost]).totals[0].amount).toBe(0.2)
  const conflict = summarizeVerificationCosts([
    reused.cost,
    summarizeVerificationAttempt(
      events(attempt('settled', { cost: cost('complete', 0.3, 'probe') }))
    )!.cost,
  ])
  expect(conflict.conflictingChargeIds).toEqual(['probe'])
  expect(conflict.coverage).toBe('unknown')
  expect(conflict.totals).toEqual([])
})

test('missing amounts stay unknown while actual zero and reference quotes remain distinct', () => {
  const missing = summarizeVerificationAttempt(
    events(
      attempt('settled', {
        cost: {
          coverage: 'complete',
          charges: [{ id: 'missing', kind: 'model', currency: 'USD', basis: 'actual' }],
        },
      })
    )
  )!
  expect(missing.cost.coverage).toBe('unknown')
  expect(missing.cost.charges[0].amount).toBeNull()
  expect(missing.cost.totals).toEqual([])
  const known = summarizeVerificationAttempt(
    events(
      attempt('settled', {
        cost: {
          coverage: 'complete',
          charges: [
            { id: 'free', kind: 'model', currency: 'USD', basis: 'actual', amount: 0 },
            { id: 'quote', kind: 'model', currency: 'USD', basis: 'reference', amount: 10 },
          ],
        },
      })
    )
  )!
  expect(known.cost.coverage).toBe('complete')
  expect(known.cost.totals).toEqual([
    { kind: 'model', currency: 'USD', basis: 'actual', amount: 0 },
    { kind: 'model', currency: 'USD', basis: 'reference', amount: 10 },
  ])
})

function fixture() {
  const records: ContextRecord[] = []
  const bodies = new Map<string, string>()
  const state: { -readonly [Key in keyof ContextState]: ContextState[Key] } = {
    version: 1,
    records,
    workingSet: { revision: 0, cursor: 0, items: [] },
  }
  const add = (
    title: string,
    value: unknown,
    sources: ReadonlyArray<ContextRecord['ref']> = []
  ) => {
    const body = JSON.stringify(value)
    const id = `r${records.length + 1}`
    const record: ContextRecord = {
      ref: { sessionId: 's', id },
      sequence: records.length + 1,
      kind: 'audit',
      title,
      objectId: id,
      chars: body.length,
      sources,
      createdAt: '2026-10-01T00:00:00Z',
    }
    records.push(record)
    bodies.set(id, body)
    return record
  }
  const storage = {
    load: async () => state,
    get: async (_session: string, id: string) => bodies.get(id) ?? null,
  } as unknown as ContextStorage
  const lookups: string[] = []
  const journal = {
    list: async (_session: string, id: string) => {
      lookups.push(id)
      return []
    },
  } as unknown as ContextInvocationJournalApi
  return { state, add, storage, journal, lookups, bodies }
}

test('trace reuses bounded page facts but observes new responses and missing bodies on the next page', async () => {
  const f = fixture()
  const shared = f.add('shared-evidence', { evidence: true })
  f.bodies.delete(shared.objectId)
  const requests = Array.from({ length: 3 }, (_, turn) =>
    f.add('model-request', {
      runId: 'run',
      turn,
      repair: 0,
      request: {
        materials: [
          {
            origin: 'runtime-view',
            text: JSON.stringify({
              goals: [{ record: { ref: shared.ref } }],
            }),
          },
        ],
      },
    })
  )
  const counts = new Map<string, number>()
  const port = {
    ...f.storage,
    get: async (sessionId: string, id: string) => {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      return f.storage.get(sessionId, id)
    },
  }
  const trace = new RuntimeTrace('s', port, f.journal)
  const first = await trace.page({ limit: 3, fullContent: true })
  expect(first.turns).toHaveLength(3)
  for (const request of requests) expect(counts.get(request.objectId)).toBe(1)
  expect(counts.get(shared.objectId)).toBe(1)
  expect(first.turns.every((turn) => turn.gaps.includes(`原文缺失：${shared.ref.id}`))).toBe(true)
  f.bodies.set(shared.objectId, JSON.stringify({ evidence: true }))
  const response = f.add(
    'model-response',
    {
      status: 'accepted',
      usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0 },
    },
    [requests[0].ref]
  )
  f.state.version++
  const second = await trace.page({ limit: 3, fullContent: true })
  expect(counts.get(shared.objectId)).toBe(2)
  expect(second.snapshotVersion).toBe(f.state.version)
  expect(second.turns[0].decision?.ref).toEqual(response.ref)
  expect(second.turns[0].modelAccounting.usage.coverage).toBe('known')
  expect(second.turns.every((turn) => !turn.gaps.includes(`原文缺失：${shared.ref.id}`))).toBe(true)
})

test('branch trace selects only current root bindings and still rejects unrelated sessions', async () => {
  const f = fixture()
  const binding = f.add('model-tool:node:child', {
    sessionId: 'child',
    rootSessionId: 's',
    rootTaskId: 'task',
    status: 'open',
  })
  const child = { ...f.state, records: [] }
  const loads: string[] = []
  const selections: unknown[] = []
  const port = {
    ...f.storage,
    load: async (id: string) => {
      loads.push(id)
      return id === 's' ? f.state : child
    },
    selectSnapshot: async (id: string, selection: unknown) => {
      expect(id).toBe('s')
      selections.push(selection)
      const { records: _records, ...metadata } = f.state
      return { metadata, records: [binding] }
    },
  }
  const trace = new RuntimeTrace('s', port, f.journal)
  expect((await trace.page({ sessionId: 'child' })).turns).toEqual([])
  expect(loads).toEqual(['child'])
  expect(selections).toEqual([[{ titlePrefix: 'model-tool:node:', latestPerTitle: true }]])
  await expect(trace.page({ sessionId: 'unrelated' })).rejects.toThrow('支线不属于指定根会话')
  expect(loads).toEqual(['child'])
  f.bodies.set(binding.objectId, JSON.stringify({ sessionId: 'other', rootSessionId: 's' }))
  await expect(trace.page({ sessionId: 'child' })).rejects.toThrow('支线不属于指定根会话')
})

test('trace preserves oversized shared evidence without retaining it in the page cache', async () => {
  const f = fixture()
  const evidence = f.add('large-evidence', 'x'.repeat(ActRuntimeTuning.tracePageCacheChars + 1))
  for (let turn = 0; turn < 2; turn++)
    f.add('model-request', {
      runId: 'run',
      turn,
      repair: 0,
      request: {
        materials: [
          {
            origin: 'runtime-view',
            text: JSON.stringify({
              goals: [{ record: { ref: evidence.ref } }],
            }),
          },
        ],
      },
    })
  let reads = 0
  const port = {
    ...f.storage,
    get: async (sessionId: string, id: string) => {
      if (id === evidence.objectId) reads++
      return f.storage.get(sessionId, id)
    },
  }
  const page = await new RuntimeTrace('s', port, f.journal).page({ limit: 2, fullContent: true })
  expect(reads).toBe(2)
  for (const turn of page.turns) {
    const record = turn.records.find((item) => item.ref.id === evidence.ref.id)
    expect(record?.body).toBe(f.bodies.get(evidence.objectId))
    expect(record?.truncated).toBe(false)
  }
})

test('metadata-only trace cursors preserve branches and verification without reading old model bodies', async () => {
  const f = fixture()
  const binding = {
    sessionId: 'child',
    parentSessionId: 's',
    rootSessionId: 's',
    kind: 'agent',
    depth: 1,
    activationId: 'active-child',
    deadline: Number.MAX_SAFE_INTEGER,
    status: 'active',
  } as const
  f.add('model-tool:node:child', binding)
  const request = f.add('model-request', { runId: 'old', turn: 0, large: 'x'.repeat(100_000) })
  f.add('task:verification:task:a:started', attempt('started'))
  f.add('task:verification:task:a:settled', attempt('settled'))
  const gets: string[] = []
  const port = {
    ...f.storage,
    get: async (sessionId: string, id: string) => {
      gets.push(id)
      return f.storage.get(sessionId, id)
    },
  }
  const page = await new RuntimeTrace('s', port, f.journal).page({
    after: Number.MAX_SAFE_INTEGER,
    activityAfter: Number.MAX_SAFE_INTEGER,
    limit: 1,
    activityLimit: 1,
    maxChars: 1,
  })
  expect(page.branches).toEqual([binding])
  expect(page.turns).toEqual([])
  expect(page.sessionActivity.entries).toEqual([])
  expect(page.accounting.verificationCost.charges).toHaveLength(1)
  expect(page.accounting.verificationCost.coverage).toBe('complete')
  expect(gets).not.toContain(request.objectId)
})

test('trace reading yields to pending IO callbacks between expensive synchronous facts', async () => {
  const f = fixture()
  f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  f.add('model-request', { runId: 'run', turn: 1, repair: 0 })
  let timer: Promise<void> | undefined
  let yielded = false
  let reads = 0
  const port = {
    ...f.storage,
    get: async (sessionId: string, id: string) => {
      reads++
      if (reads === 1) {
        timer = TimerScope.sleep(0).then(() => {
          yielded = true
        })
        const until = Date.now() + 12
        while (Date.now() < until) {
          /* represent a synchronous storage/JSON read */
        }
      } else expect(yielded).toBe(true)
      return f.storage.get(sessionId, id)
    },
  }
  try {
    await new RuntimeTrace('s', port, f.journal).page({ limit: 2, fullContent: true })
    expect(reads).toBe(2)
    expect(yielded).toBe(true)
  } finally {
    await timer
  }
})

function persistedFixture() {
  const states = new Map<string, ContextState>()
  const bodies = new Map<string, string>()
  const owners = new Map<string, string>()
  const storage: ContextStorage = {
    load: async (session) => structuredClone(states.get(session) ?? null),
    get: async (session, id) => (owners.get(id) === session ? (bodies.get(id) ?? null) : null),
    put: async (session, body) => {
      const id = crypto.randomUUID()
      bodies.set(id, body)
      owners.set(id, session)
      return id
    },
    compareAndSwap: async (session, version, next) => {
      if ((states.get(session)?.version ?? 0) !== version) return false
      states.set(session, structuredClone(next))
      return true
    },
    close: async () => {},
  }
  const context = createContextRuntime({ sessionId: 's', storage })
  const add = (title: string, value: unknown, sources: ReadonlyArray<ContextRecord['ref']> = []) =>
    context.append({ kind: 'audit', title, body: JSON.stringify(value), sources })
  const phases = async (id: string, cancelled = false) => {
    await add(`task:verification:task:${id}:started`, attempt('started', { attemptId: id }))
    return add(
      `task:verification:task:${id}:settled`,
      attempt('settled', {
        attemptId: id,
        mode: 'probed',
        status: cancelled ? 'cancelled' : 'passed',
        cost: cancelled ? { coverage: 'unknown', charges: [] } : cost(),
      })
    )
  }
  const journal = createContextInvocationJournal(storage)
  return { add, phases, bodies, trace: new RuntimeTrace('s', storage, journal) }
}

test('session verification ledger includes paid probes without any model request', async () => {
  const f = persistedFixture()
  await f.phases('no-request')
  const page = await f.trace.page({ limit: 1, maxChars: 1 })
  expect(page.turns).toEqual([])
  expect(page.accounting.verificationScope).toBe('session')
  expect(page.accounting.modelRequests).toEqual({ known: 0, unknown: 0, inflight: 0 })
  expect(page.accounting.verificationCost.coverage).toBe('complete')
  expect(page.accounting.verificationCost.totals).toEqual([
    { kind: 'external', currency: 'USD', basis: 'actual', amount: 2 },
  ])
})

test('session ledger includes probes before the first request without inventing turn ownership', async () => {
  const f = persistedFixture()
  await f.phases('before-request')
  const request = await f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  await f.add(
    'model-response',
    { status: 'accepted', usage: { inputTokens: 5, outputTokens: 2 } },
    [request.ref]
  )
  const page = await f.trace.page()
  expect(page.turns[0].verification.attempts).toEqual([])
  expect(page.accounting.modelRequests).toEqual({ known: 1, unknown: 0, inflight: 0 })
  expect(page.accounting.verificationCost.totals[0].amount).toBe(2)
})

test('session ledger includes cancelled post-terminal probes and late fees without completing coverage', async () => {
  const f = persistedFixture()
  const request = await f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  await f.add(
    'model-response',
    { status: 'accepted', usage: { inputTokens: 5, outputTokens: 2 } },
    [request.ref]
  )
  await f.add('act:state', { id: 'run', status: 'completed' })
  await f.add('act:event', { type: 'state', runId: 'run', status: 'completed' })
  await f.phases('after-terminal', true)
  const pending = await f.trace.page()
  expect(pending.turns[0].verification.attempts).toEqual([])
  expect(pending.accounting.verificationCost.coverage).toBe('unknown')
  await f.add(
    'task:verification:task:after-terminal:late-result',
    attempt('late-result', { attemptId: 'after-terminal', mode: 'probed', durationMs: 20 })
  )
  const late = await f.trace.page()
  expect(late.turns[0].verification.attempts).toEqual([])
  expect(late.accounting.verificationCost.coverage).toBe('partial')
  expect(late.accounting.verificationCost.totals[0].amount).toBe(2)
})

test('each page returns the same cumulative session ledger with charge deduplication', async () => {
  const f = persistedFixture()
  const first = await f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  await f.add('model-response', { status: 'accepted' }, [first.ref])
  await f.phases('first')
  const second = await f.add('model-request', { runId: 'run', turn: 1, repair: 0 })
  await f.add('model-response', { status: 'accepted' }, [second.ref])
  await f.phases('second')
  const page1 = await f.trace.page({ limit: 1 })
  const page2 = await f.trace.page({ limit: 1, after: first.sequence })
  expect(page1.turns.map((turn) => turn.turnId)).toEqual([first.ref.id])
  expect(page2.turns.map((turn) => turn.turnId)).toEqual([second.ref.id])
  expect(page1.accounting.modelRequests).toEqual({ known: 0, unknown: 1, inflight: 0 })
  expect(page2.accounting.verificationCost).toEqual(page1.accounting.verificationCost)
  expect(page2.accounting.verificationCost.charges).toHaveLength(1)
  expect(page2.accounting.verificationCost.totals[0].amount).toBe(2)
})

test('missing persisted probe phases cannot become a complete empty session ledger', async () => {
  const f = persistedFixture()
  const settled = await f.phases('missing-body')
  f.bodies.delete(settled.objectId)
  const page = await f.trace.page()
  expect(page.accounting.verificationCost.coverage).toBe('unknown')
  expect(page.accounting.verificationCost.totals).toEqual([])
})

test('missing response only means inflight with a current thinking run and live task lease', async () => {
  const f = fixture()
  const request = f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  f.add('act:state', { id: 'run', status: 'thinking' })
  f.state.task = {
    status: 'view-ready',
    lease: { id: 'lease', expiresAt: Date.now() + 10000 },
  } as ContextState['task']
  const trace = new RuntimeTrace('s', f.storage, f.journal)
  expect((await trace.read(request.ref.id)).modelAccounting.status).toBe('inflight')
  f.state.task = { ...f.state.task!, lease: null }
  expect((await trace.read(request.ref.id)).modelAccounting.status).toBe('unknown')
  f.state.task = { ...f.state.task!, lease: { id: 'lease', expiresAt: Date.now() - 1 } }
  expect((await trace.read(request.ref.id)).modelAccounting.status).toBe('unknown')
})

test('late verification belongs to its started request and page deduplicates charges', async () => {
  const f = fixture()
  const first = f.add('model-request', { runId: 'run', turn: 0, repair: 0 })
  f.add('model-response', { status: 'rejected', usage: { inputTokens: 19, outputTokens: 7 } }, [
    first.ref,
  ])
  f.add('task:verification:task:a:started', attempt('started'))
  f.add(
    'task:verification:task:a:settled',
    attempt('settled', { status: 'cancelled', cost: { coverage: 'unknown', charges: [] } })
  )
  const second = f.add('model-request', { runId: 'run', turn: 1, repair: 0 })
  f.add('model-response', { status: 'accepted' }, [second.ref])
  f.add('task:verification:task:b:started', attempt('started', { attemptId: 'b' }))
  f.add(
    'task:verification:task:b:settled',
    attempt('settled', { attemptId: 'b', mode: 'reused', runMs: 0 })
  )
  f.add(
    'task:verification:task:a:late-result',
    attempt('late-result', { durationMs: 20, runMs: 16 })
  )
  const page = await new RuntimeTrace('s', f.storage, f.journal).page({ limit: 2 })
  expect(page.turns[0].verification.attempts.map((item) => item.attemptId)).toEqual(['a'])
  expect(page.turns[1].verification.attempts.map((item) => item.attemptId)).toEqual(['b'])
  expect(page.turns[0].verification.attempts[0].records).toHaveLength(3)
  expect(page.accounting.modelRequests).toEqual({ known: 1, unknown: 1, inflight: 0 })
  expect(page.accounting.verificationCost.coverage).toBe('partial')
  expect(page.accounting.verificationCost.totals[0].amount).toBe(2)
})

test('snapshot capture is a fresh journal fact even when its old derivation is reused', async () => {
  const f = fixture()
  const oldId = crypto.randomUUID()
  const captureId = crypto.randomUUID()
  const source = f.add('source', { source: 'export default () => 1' })
  const old = f.add(
    `script:${oldId}:result`,
    { checked: true, result: {}, timing: { durationMs: 1 } },
    [source.ref]
  )
  const capture = f.add(`script:${captureId}:result`, {
    checked: true,
    kind: 'snapshot-capture',
    result: {},
    timing: { durationMs: 4 },
  })
  f.add(`script:execution:${captureId}`, { executionId: captureId, kind: 'snapshot-capture' })
  const request = f.add('model-request', {
    runId: 'run',
    turn: 0,
    repair: 0,
    request: {
      materials: [
        {
          origin: 'runtime-view',
          text: JSON.stringify({
            observation: {
              sourceRef: source.ref.id,
              resultRef: old.ref.id,
              freshness: {
                status: 'reused',
                executionId: oldId,
                resultRef: old.ref.id,
                sourceRef: source.ref.id,
                observedAt: '2026-10-01T00:00:00Z',
                ageMs: 10,
                probeMs: 0,
                reason: 'snapshot-unchanged',
                snapshot: {
                  captureExecutionId: captureId,
                  captureResultRef: capture.ref.id,
                  checkedAt: '2026-10-01T00:00:01Z',
                  captureMs: 4,
                  deriveMs: 0,
                  derived: false,
                  reused: true,
                },
              },
            },
            results: [],
          }),
        },
      ],
    },
  })
  f.journal.list = async (_session, executionId) => {
    f.lookups.push(executionId!)
    const prepared = {
      id: `${executionId}:1`,
      sessionId: 's',
      executionId: executionId!,
      mode: 'observe' as const,
      binding: {
        moduleId: 'velaros:project',
        instanceId: 'project',
        generation: 1,
        schemaRevision: '1',
      },
      operation: executionId === captureId ? 'snapshot' : 'old-read',
      input: {},
      inputFingerprint: 'input',
      requestFingerprint: 'request',
    }
    return [
      {
        phase: 'settled',
        prepared,
        receipt: {
          invocation: prepared,
          outcome: 'succeeded',
          effect: 'none',
          retry: 'safe',
          value: { complete: true },
        },
      },
    ] as Awaited<ReturnType<ContextInvocationJournalApi['list']>>
  }
  const value = await new RuntimeTrace('s', f.storage, f.journal).read(request.ref.id)
  expect(value.records.some((record) => record.ref.id === capture.ref.id)).toBe(true)
  expect(f.lookups.filter((id) => id === captureId)).toHaveLength(1)
  expect(value.observation.run!.executionId).toBe(oldId)
  expect(value.invocations.map((item) => [item.executionId, item.summary.operation])).toEqual([
    [captureId, 'snapshot'],
  ])
  // 旧派生的回执只用于解释原结果状态，不被当成本轮调用交付。
  expect(f.lookups.filter((id) => id === oldId)).toHaveLength(1)
})
