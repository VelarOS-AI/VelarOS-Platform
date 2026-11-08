import { expect, test } from 'bun:test'

import type {
  ContextInvocationJournalApi,
  ContextRecord,
  ContextState,
  ContextStorage,
} from '@velaros-ai/context'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { RuntimeTrace } from '../impl/RuntimeTrace.js'
import { modelAccounting } from '../utils/trace-accounting.js'
import { ActRuntimeTuning } from '../utils/tuning.js'

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
  const frame = f.add('context:frame:shared', {
    frameId: 'shared',
    entries: [{ ref: shared.ref.id }],
    observation: {},
  })
  const requests = Array.from({ length: 3 }, (_, turn) =>
    f.add('model-request', {
      runId: 'run',
      turn,
      repair: 0,
      frameRef: frame.ref,
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
  const frame = f.add('context:frame:large', {
    frameId: 'large',
    entries: [{ ref: evidence.ref.id }],
    observation: {},
  })
  for (let turn = 0; turn < 2; turn++)
    f.add('model-request', {
      runId: 'run',
      turn,
      repair: 0,
      frameRef: frame.ref,
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
  const frame = f.add('context:frame:snapshot', {
    frameId: 'snapshot',
    entries: [],
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
  })
  const request = f.add('model-request', {
    runId: 'run',
    turn: 0,
    repair: 0,
    frameRef: frame.ref,
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

test('branch directory reads current-task ownership without loading request history', async () => {
  const f = fixture()
  f.state.task = { id: 'current-task' } as NonNullable<ContextState['task']>
  const current = {
    sessionId: 'current-child',
    parentSessionId: 's',
    rootSessionId: 's',
    rootTaskId: 'current-task',
    kind: 'agent' as const,
    depth: 1,
    activationId: 'current',
    deadline: 1,
    status: 'closed' as const,
  }
  const previous = { ...current, sessionId: 'previous-child', rootTaskId: 'previous-task' }
  const bindings = [
    f.add('model-tool:node:current', current),
    f.add('model-tool:node:previous', previous),
  ]
  f.add('model-request', { request: 'history must not be loaded' })
  const port = {
    ...f.storage,
    load: async () => {
      throw new Error('directory query loaded full history')
    },
    selectSnapshot: async (id: string, selections: unknown) => {
      expect(id).toBe('s')
      expect(selections).toEqual([{ titlePrefix: 'model-tool:node:', latestPerTitle: true }])
      const { records: _records, ...metadata } = f.state
      return { metadata, records: bindings }
    },
    get: async (id: string, objectId: string) => {
      expect(bindings.some((record) => record.objectId === objectId)).toBe(true)
      return f.storage.get(id, objectId)
    },
  }
  expect(await new RuntimeTrace('s', port, f.journal).branches()).toEqual([current])
})
