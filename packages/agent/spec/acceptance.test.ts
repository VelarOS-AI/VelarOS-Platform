import { createHash } from 'node:crypto'

import { expect, test } from 'bun:test'

import type { ContextState } from '@velaros-ai/context'
import type { ContextStorage } from '@velaros-ai/context'
import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { ActChildSession } from '../src/contract/requires.js'
import type { ActRunServiceOptions } from '../src/contract/requires.js'
import { createAgentSupervisor } from '../src/index.js'
import { createActRunService } from '../src/index.js'
import { sessionCacheKey } from '../src/utils/cache-key.js'
import { boundedModelStream } from '../src/utils/model-stream.js'

function runFixture() {
  const store = storage()
  const context = createContextRuntime({ storage: store, sessionId: 'fault' })
  const view = createContextView({ storage: store, sessionId: 'fault', context, sources: [] })
  const options: { -readonly [Key in keyof ActRunServiceOptions]: ActRunServiceOptions[Key] } = {
    storage: store,
    context,
    view,
    sessionId: 'fault',
    instructions: 'fixture',
    limits: {
      turns: 4,
      outputTokens: 100,
      safetyTokens: 10,
      projectionChars: 10000,
      recoveryChars: 1000,
      timeoutMs: 2000,
    },
    model: {
      id: 'fixture',
      limits: { contextTokens: 10000, inputTokens: 9000, outputTokens: 100 },
      estimate: async () => ({ tokens: 1, precision: 'exact', basis: 'fixture' }),
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'finish', reason: 'stop' }
      },
    },
    protocol: {
      open: () => ({
        instructions: 'fixture',
        reset() {},
        push() {
          return []
        },
        finish() {
          return { message: 'done', done: true, events: [] }
        },
      }),
    },
    frames: {
      mode: 'runtime-view',
      setPhase() {},
      async prepare() {},
      async visibleExecutions() {
        return []
      },
      async project() {
        return { body: '{}', images: [] }
      },
      async needsRefresh() {
        return false
      },
      async acknowledge() {},
    },
    execution: { pending: () => false, async wait() {}, async invoke() {}, async stop() {} },
  }
  return { store, context, view, options }
}

test('INV-40 accepted provider usage drives growth while calibrated admission remains independent', async () => {
  const f = runFixture()
  const requests: ModelTurnRequest[] = []
  f.options.frames.project = async () => ({
    body: '{}',
    images: [],
    segment: { id: 'one-segment', index: 1, revision: 0, volumes: 0, turns: requests.length },
  })
  f.options.model.estimate = async () => ({
    tokens: 5_000,
    precision: 'estimate',
    basis: 'fixture',
  })
  f.options.model.stream = async function* (request) {
    requests.push(request)
    yield { type: 'usage', inputTokens: 1_000 + requests.length * 200, outputTokens: 1 }
    yield { type: 'text', text: 'accepted' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.protocol.open = () => ({
    instructions: 'fixture',
    reset() {},
    push() {
      return []
    },
    finish() {
      return requests.length >= 3
        ? { message: 'done', done: true, events: [] }
        : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
    },
  })
  const service = createActRunService(f.options)
  const events = []
  try {
    for await (const event of service.submit('complete three steps')) events.push(event)
    expect(requests).toHaveLength(3)
    expect(requests[2]!.contextStatus?.runway?.growthPerTurn).toBe(200)
    expect(requests[2]!.contextStatus?.inputTokens).toBeGreaterThan(1_400)
    expect(events.some((event) => event.type === 'state' && event.status === 'completed')).toBe(
      true
    )
  } finally {
    await service.close()
  }
})

test.each(['overflow', 'forecast', 'irreducible'] as const)(
  'INV-40 fold cooldown preserves forecasting stability without blocking actual overflow: %s',
  async (mode) => {
    const f = runFixture()
    let calls = 0
    let folds = 0
    let foldAttempts = 0
    let executed = 0
    let pressure = 0
    f.options.frames.policy = { windowTokens: 2000 }
    f.options.frames.project = async () => ({
      body: '{}',
      images: [],
      segment: { id: `segment-${folds}`, index: folds, revision: 0, volumes: folds, turns: 3 },
    })
    f.options.frames.fold = async (reason) => {
      foldAttempts++
      expect(reason).toBe(folds < 2 ? 'runway' : 'overflow')
      if (folds === 2 && mode === 'irreducible') return false
      folds++
      return true
    }
    f.options.frames.maintain = async ({ reason }) => {
      if (reason === 'pressure') pressure++
      return false
    }
    f.options.model.estimate = async () => ({
      tokens: calls <= folds ? 1000 : calls < 3 || mode === 'forecast' ? 1930 : 10000,
      precision: 'exact',
      basis: 'one accepted frame between folds followed by actual capacity pressure',
    })
    f.options.model.stream = async function* () {
      calls++
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return calls >= 4
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
      },
    })
    f.options.execution.invoke = async () => {
      executed++
    }
    const service = createActRunService(f.options)
    const events = []
    try {
      for await (const event of service.submit('Complete the ongoing edits')) events.push(event)
      expect(executed).toBe(3)
      expect(calls).toBe(mode === 'irreducible' ? 3 : 4)
      expect(folds).toBe(mode === 'overflow' ? 3 : 2)
      expect(foldAttempts).toBe(mode === 'forecast' ? 2 : 3)
      expect(pressure).toBe(mode === 'irreducible' ? 1 : 0)
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        status: mode === 'irreducible' ? 'context_blocked' : 'completed',
      })
    } finally {
      await service.close()
    }
  }
)

test.each(['fits', 'window', 'provider', 'exact', 'abort', 'timeout'] as const)(
  'INV-51 candidate admission uses the live calibration and obeys capacity and cancellation: %s',
  async (mode) => {
    const f = runFixture()
    let calls = 0
    let checked = 0
    let executed = 0
    let outcome = ''
    f.options.frames.policy = { windowTokens: 2000 }
    f.options.limits = { ...f.options.limits, timeoutMs: mode === 'timeout' ? 100 : 2000 }
    f.options.model.estimate = async (request) => {
      if (request.compiledPrompt?.includes('candidate')) {
        checked++
        if (mode === 'timeout') return new Promise(() => {})
        return {
          tokens: mode === 'window' ? 19_000 : mode === 'exact' ? 3000 : 12_000,
          precision: mode === 'exact' ? 'exact' : 'estimate',
          basis: 'candidate fixture',
        }
      }
      return { tokens: 1000, precision: 'estimate', basis: 'live fixture' }
    }
    f.options.model.stream = async function* () {
      calls++
      yield { type: 'usage', inputTokens: 100, outputTokens: 1 }
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return executed
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
      },
    })
    const candidate: ModelTurnRequest = {
      instructions: 'candidate',
      materials: [],
      compiledPrompt: 'candidate body',
      images: [],
      response: { type: 'text' },
      mode: 'work',
      outputTokens: mode === 'provider' ? 9000 : 100,
    }
    const service = createActRunService(f.options)
    const signal = mode === 'abort' ? AbortSignal.abort() : new AbortController().signal
    await expect(service.validateContext(candidate, signal)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    f.options.execution.invoke = async () => {
      executed++
      try {
        await service.validateContext(candidate, signal)
        outcome = 'accepted'
      } catch (error) {
        outcome = (error as Error).name === 'AbortError' ? 'cancelled' : (error as AppError).code
      }
    }
    const events = []
    try {
      for await (const event of service.submit('work')) events.push(event)
      expect(executed).toBe(1)
      expect(checked).toBe(mode === 'abort' ? 0 : 1)
      expect(outcome).toBe(
        mode === 'fits'
          ? 'accepted'
          : mode === 'abort' || mode === 'timeout'
            ? 'cancelled'
            : 'CONTEXT_BUDGET'
      )
      // 验收本身不派发模型；取消只作用于候选时主循环仍可继续。
      expect(calls).toBe(mode === 'timeout' ? 1 : 2)
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        status: mode === 'timeout' ? 'cancelled' : 'completed',
      })
      await expect(service.validateContext(candidate, signal)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    } finally {
      await service.close()
    }
  }
)

test('INV-51 adding final context status retries a smaller projection before blocking', async () => {
  const f = runFixture()
  let calls = 0
  const budgets: number[] = []
  f.options.frames.project = async (_view, _signal, maxChars) => {
    budgets.push(maxChars)
    return { body: maxChars > 1000 ? 'full' : 'compact', images: [] }
  }
  f.options.model.estimate = async (request) => ({
    tokens: request.materials[0]?.text === 'compact' ? 1000 : request.contextStatus ? 9100 : 8990,
    precision: 'exact',
    basis: 'final status boundary',
  })
  f.options.model.stream = async function* (request) {
    calls++
    expect(request.materials[0]?.text).toBe('compact')
    expect(request.contextStatus).toBeDefined()
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  try {
    for await (const event of service.submit('work')) events.push(event)
    expect(calls).toBe(1)
    expect(budgets).toContain(1000)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  } finally {
    await service.close()
  }
})

test.each(['ready', 'not-ready', 'execution-failed', 'verification-rejected', 'pending'] as const)(
  'INV-52 native host delivery obeys execution and ordinary completion gates: %s',
  async (mode) => {
    const f = runFixture()
    let calls = 0
    let checks = 0
    let readyChecks = 0
    let pending = false
    f.options.frames.deliveryReady = () => {
      readyChecks++
      return mode !== 'not-ready'
    }
    f.options.frames.completion = async () => {
      checks++
      return mode === 'verification-rejected'
        ? { completed: false, verified: false, reason: 'not verified', recovery: 'input' }
        : { completed: true, verified: true }
    }
    f.options.protocol.open = () => ({
      instructions: 'native fixture',
      response: {
        type: 'tools',
        tools: [{ name: 'node', description: 'fixture', schema: { type: 'object' } }],
      },
      reset() {},
      push() {
        return []
      },
      acceptTool() {
        return []
      },
      finish() {
        return calls === 1
          ? { message: '', done: false, submission: { code: 'deliver' }, events: [] }
          : { message: 'done', done: true, events: [] }
      },
    })
    f.options.model.stream = async function* () {
      calls++
      if (calls === 1) yield { type: 'tool-call', value: { id: 'report', name: 'node', input: {} } }
      else yield { type: 'text', text: 'done' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.execution.invoke = async () => {
      pending = mode === 'pending'
      return {
        succeeded: mode !== 'execution-failed',
        results: [{ id: 'report', name: 'node', output: { recorded: true } }],
      }
    }
    f.options.execution.pending = () => pending
    f.options.execution.wait = async () => {
      pending = false
    }
    const service = createActRunService(f.options)
    const events = []
    try {
      for await (const event of service.submit('work')) events.push(event)
      expect(calls).toBe(mode === 'ready' || mode === 'verification-rejected' ? 1 : 2)
      expect(readyChecks).toBe(mode === 'execution-failed' ? 0 : 1)
      expect(checks).toBe(1)
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        status: mode === 'verification-rejected' ? 'waiting' : 'completed',
      })
      const records = (await f.store.load('fault'))!.records
      expect(records.filter((record) => record.title === 'model-tool-exchange')).toHaveLength(1)
      expect(records.filter((record) => record.title === 'execution-completion')).toHaveLength(
        mode === 'execution-failed' || mode === 'not-ready' ? 0 : 1
      )
    } finally {
      await service.close()
    }
  }
)

test('INV-34 cleanup failure still releases ownership and cannot report a completed run', async () => {
  const f = runFixture()
  let ended = 0
  let stop = true
  f.options.execution.stop = async () => {
    if (stop) throw Error('stop storage failure')
  }
  f.options.frames.end = async () => {
    ended++
  }
  const service = createActRunService(f.options)
  const events = []
  await expect(
    (async () => {
      for await (const event of service.submit('first')) events.push(event)
    })()
  ).rejects.toThrow()
  expect(ended).toBe(1)
  expect((await f.view.inspect())?.lease).toBeNull()
  expect(events.some((event) => event.type === 'state' && event.status === 'completed')).toBe(false)
  expect((await service.inspect()).status).toBe('failed')
  stop = false
  for await (const event of service.submit('retry after cleanup')) {
    expect(typeof event.type).toBe('string')
  }
  expect((await service.inspect()).status).toBe('completed')
  await service.close()
})

test.each(['fits', 'needs-finalization'] as const)(
  'INV-53 a leaf tries smaller evidence before reserving its last delivery request: %s',
  async (mode) => {
    const f = runFixture()
    let finalizing = false
    let calls = 0
    f.options.frames.policy = { windowTokens: 2000 }
    f.options.frames.pressure = () => {
      finalizing = true
    }
    f.options.frames.phase = () => ({ phase: finalizing ? 'finalizing' : 'work', instructions: '' })
    f.options.frames.project = async (_view, _signal, maxChars) => ({
      body: JSON.stringify({ size: maxChars <= 1000 ? 'small' : 'large' }),
      images: [],
    })
    f.options.model.estimate = async (request) => ({
      tokens:
        finalizing || (mode === 'fits' && request.materials[0]!.text.includes('small'))
          ? 100
          : 50000,
      precision: 'exact',
      basis: 'bounded leaf evidence',
    })
    f.options.model.stream = async function* (request) {
      calls++
      expect(request.contextStatus?.phase).toBe(mode === 'fits' ? 'work' : 'finalizing')
      yield { type: 'text', text: 'completed' }
      yield { type: 'finish', reason: 'stop' }
    }
    const events = []
    const service = createActRunService(f.options)
    try {
      for await (const event of service.submit('summarize the supplied records')) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      expect(calls).toBe(1)
      expect(finalizing).toBe(mode === 'needs-finalization')
    } finally {
      await service.close()
    }
  }
)

test.each(['linear', 'stepped', 'mandatory-overflow', 'status-overflow', 'cancel'] as const)(
  'INV-53 bounded local projection keeps usable evidence and enforces the final work window: %s',
  async (mode) => {
    const f = runFixture()
    const controller = new AbortController()
    const sent: ModelTurnRequest[] = []
    const projections: number[] = []
    let maintained = 0
    let acknowledged = 0
    let finalizing = false
    f.options.frames.policy = { windowTokens: 3000 }
    f.options.frames.project = async (_view, _signal, maxChars) => {
      projections.push(maxChars)
      return {
        body: JSON.stringify({
          required: 'Keep all original conditions',
          evidence: 'x'.repeat(maxChars),
        }),
        images: [],
      }
    }
    f.options.frames.acknowledge = async () => {
      acknowledged++
    }
    f.options.frames.maintain = async ({ reason }) => {
      if (reason === 'pressure') maintained++
      return false
    }
    f.options.frames.pressure = () => {
      finalizing = true
    }
    f.options.frames.phase = () => ({ phase: finalizing ? 'finalizing' : 'work', instructions: '' })
    f.options.model.estimate = async (request) => {
      const chars = JSON.parse(request.materials[0]!.text).evidence.length
      if (mode === 'cancel' && chars > 1000 && chars < 10000) {
        controller.abort()
        return new Promise(() => {})
      }
      return {
        tokens:
          mode === 'mandatory-overflow'
            ? 4000
            : 400 +
              Math.ceil(chars / 3) +
              (mode === 'stepped' && chars > 5000 ? 3000 : 0) +
              (mode === 'status-overflow' && request.contextStatus ? 1400 : 0),
        precision: 'exact',
        basis: 'mandatory prefix and bounded optional evidence',
      }
    }
    f.options.model.stream = async function* (request) {
      sent.push(request)
      yield { type: 'text', text: 'complete' }
      yield { type: 'finish', reason: 'stop' }
    }
    const service = createActRunService(f.options)
    const events = []
    try {
      for await (const event of service.submit('Use the supplied facts', controller.signal))
        events.push(event)
      expect(projections.length).toBeLessThanOrEqual(12)
      if (mode === 'mandatory-overflow' || mode === 'cancel') {
        expect(sent).toHaveLength(0)
        expect(acknowledged).toBe(0)
        expect(events.at(-1)).toMatchObject({
          type: 'state',
          status: mode === 'cancel' ? 'cancelled' : 'context_blocked',
        })
      } else {
        expect(sent).toHaveLength(1)
        expect(acknowledged).toBe(1)
        const payload = JSON.parse(sent[0]!.materials[0]!.text)
        expect(payload.required).toBe('Keep all original conditions')
        expect((await f.options.model.estimate(sent[0]!)).tokens).toBeLessThanOrEqual(3000)
        if (mode !== 'status-overflow') expect(payload.evidence.length).toBeGreaterThan(4000)
        expect(finalizing).toBe(false)
        expect(maintained).toBe(0)
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      }
    } finally {
      await service.close()
    }
  }
)

test.each([
  { role: 'user' as const, content: 'same result' },
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'same result' }] },
  { role: 'assistant' as const, content: 'same answer' },
])('retained cache boundaries track each logical occurrence of $role messages', async (message) => {
  const f = runFixture()
  const logical: ModelHistoryMessage[] = [
    { ...message, cacheBreakpoint: true },
    { ...message, cacheBreakpoint: false },
  ]
  let turn = 0
  const requests: ModelHistoryMessage[][] = []
  f.options.frames = {
    ...f.options.frames,
    async project() {
      return {
        body: JSON.stringify({ turn }),
        images: [],
        prompt: `full frame ${turn}`,
        history: logical.map((item) => ({ ...item })),
      }
    },
    delta() {
      return `delta frame ${turn}`
    },
  }
  f.options.protocol = {
    open: () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return turn >= 2
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
      },
    }),
  }
  f.options.model.stream = async function* (request) {
    requests.push(modelRequestEncoder.messages(request))
    yield { type: 'text', text: 'accepted' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.execution.invoke = async () => {
    turn++
    logical.push({ ...message, cacheBreakpoint: false })
    if (turn === 2) {
      logical[0] = { ...message, cacheBreakpoint: false }
      logical[1] = { ...message, cacheBreakpoint: true }
    }
  }
  const service = createActRunService(f.options)
  for await (const _event of service.submit('work')) {
    // The fixture runs through the normal acceptance and retained-prefix path.
  }
  expect(requests).toHaveLength(3)
  expect(requests[1]![0]!.cacheBreakpoint).toBe(true)
  expect(requests[1]![1]!.cacheBreakpoint).toBeUndefined()
  expect(requests[1]![3]!.cacheBreakpoint).toBe(false)
  expect(requests[2]![0]!.cacheBreakpoint).toBeUndefined()
  expect(requests[2]![1]!.cacheBreakpoint).toBe(true)
  expect(requests[2]![2]!.cacheBreakpoint).toBeUndefined()
  expect(requests[2]![3]!.cacheBreakpoint).toBeUndefined()
  expect(requests[2]![4]!.cacheBreakpoint).toBe(true)
  expect(requests[2]![5]!.cacheBreakpoint).toBe(false)
  await service.close()
})

test.each([
  { fallback: false, repair: false },
  { fallback: true, repair: false },
  { fallback: false, repair: true },
])(
  'INV-49 final history reconciliation follows retained selection, fallback and acceptance $fallback/$repair',
  async ({ fallback, repair }) => {
    const f = runFixture()
    const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'logical entry' }]
    let turn = 0
    let responses = 0
    let acknowledgements = 0
    const requests: Array<Parameters<NonNullable<typeof f.options.frames.acknowledge>>[0]> = []
    const calls: Array<{ previous?: string; retained: boolean; body: string }> = []
    f.options.frames = {
      ...f.options.frames,
      async project() {
        return {
          body: JSON.stringify({ turn }),
          images: [],
          prompt: 'old prompt',
          history: logical,
        }
      },
      delta() {
        return 'old delta'
      },
      async reconcile(body, history, previous) {
        const retained = history.length > logical.length
        const resolved = JSON.stringify({ ...JSON.parse(body), retained })
        calls.push({ previous, retained, body: resolved })
        return { body: resolved, prompt: `actual ${resolved}` }
      },
      async acknowledge(request) {
        acknowledgements++
        expect(request.compiledPrompt).toContain(request.materials[0]!.text)
      },
    }
    f.options.model.estimate = async (request) => ({
      tokens: fallback && turn === 1 && (request.history?.length ?? 0) > logical.length ? 9500 : 1,
      precision: 'exact',
      basis: 'fixture',
    })
    f.options.model.stream = async function* (request) {
      requests.push(request)
      responses++
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        if (repair && responses === 1)
          throw new AppError('SCRIPT_PROTOCOL', 'synthetic protocol rejection')
        return turn === 0
          ? { message: 'work', done: false, submission: { code: 'work' }, events: [] }
          : { message: 'done', done: true, events: [] }
      },
    })
    f.options.execution.invoke = async () => {
      turn++
    }
    const service = createActRunService(f.options)
    try {
      for await (const _event of service.submit('work')) {
        /* acceptance path */
      }
      expect(acknowledgements).toBe(2)
      expect(requests).toHaveLength(repair ? 3 : 2)
      const last = requests.at(-1)!
      expect(JSON.parse(last.materials[0]!.text).retained).toBe(!fallback)
      expect(last.compiledPrompt).toContain(last.materials[0]!.text)
      expect(
        calls.some((call) => call.previous === requests[0]!.materials[0]!.text && call.retained)
      ).toBe(true)
      if (fallback) expect(calls.at(-1)!.previous).toBeUndefined()
    } finally {
      await service.close()
    }
  }
)

test('INV-35 accepted event persistence failure prevents execution and leaves a failed recoverable run', async () => {
  const f = runFixture()
  let executed = 0
  let fail = true
  f.options.protocol = {
    open: () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return { message: 'execute', done: false, submission: { code: 'work' }, events: [] }
      },
    }),
  }
  f.options.execution.invoke = async () => {
    executed++
  }
  const put = f.store.put
  f.store.put = async (id, body) => {
    if (fail && body.startsWith('{"type":"accepted"')) {
      fail = false
      throw Error('accepted journal unavailable')
    }
    return put(id, body)
  }
  const service = createActRunService(f.options)
  await expect(
    (async () => {
      for await (const event of service.submit('work')) {
        expect(typeof event.type).toBe('string')
      }
    })()
  ).rejects.toThrow('accepted journal unavailable')
  expect(executed).toBe(0)
  expect((await f.view.inspect())?.lease).toBeNull()
  expect((await service.inspect()).status).toBe('failed')
  const reopened = createActRunService(f.options)
  expect((await reopened.inspect()).status).toBe('failed')
  await service.close()
  await reopened.close()
})

test('INV-41 a run waits out the hourly model limit and continues; the total cap pauses it for the user', async () => {
  const f = runFixture()
  let refusals = 1
  let exhausted = false
  f.options.view = new Proxy(f.view, {
    get(target, key) {
      if (key === 'reserveModel')
        return async (role: 'main' | 'context', tokens: number) => {
          if (exhausted) throw Object.assign(Error('budget'), { code: 'MODEL_BUDGET' })
          if (refusals-- > 0)
            throw Object.assign(Error('rate'), { code: 'MODEL_RATE', retryAfterMs: 5 })
          return target.reserveModel(role, tokens)
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit('work')) events.push(event)
  expect(events).toContainEqual(expect.objectContaining({ type: 'throttled', retryAfterMs: 5 }))
  expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  exhausted = true
  const paused = []
  for await (const event of service.submit('more')) paused.push(event)
  // 请求还没发出，输入保留给下一次运行；运行本身停在等待
  expect(paused.some((event) => event.type === 'error')).toBe(true)
  expect(paused.filter((event) => event.type === 'state').at(-1)).toMatchObject({
    status: 'waiting',
  })
  expect(paused.at(-1)).toMatchObject({ type: 'input-retained' })
  expect((await service.inspect()).status).toBe('waiting')
  await service.close()
})

test('INV-42 fitting requests expose repeated material gaps to the main model without allocating paid maintenance', async () => {
  const f = runFixture()
  const reasons: string[] = []
  const overloads: Array<string | undefined> = []
  f.options.frames.project = async () => ({
    body: '{}',
    images: [],
    segment: { id: 'segment', index: 1, revision: 0, volumes: 0, turns: 4, faults: 3 },
  })
  f.options.frames.maintain = async (input) => {
    reasons.push(input.reason)
    return input.reason === 'pressure'
  }
  f.options.model.stream = async function* (request) {
    overloads.push(request.contextStatus?.overload)
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  for await (const event of service.submit('work')) expect(typeof event.type).toBe('string')
  // 缺页是工作集提示，实际容量仍足够，不另起一条模型工作流。
  expect(reasons.filter((reason) => reason === 'pressure')).toEqual([])
  expect(overloads.at(-1)).toMatch(/3 次读回/)
  await service.close()
})

test('INV-42 a low forecast with a fitting request does not dispatch pressure maintenance', async () => {
  const f = runFixture()
  const reasons: string[] = []
  const requests: ModelTurnRequest[] = []
  f.options.frames.policy = { windowTokens: 2000 }
  f.options.model.estimate = async () => ({
    tokens: 1930,
    precision: 'exact',
    basis: 'fits with little forecast runway',
  })
  f.options.frames.fold = async () => false
  f.options.frames.maintain = async ({ reason }) => {
    reasons.push(reason)
    return false
  }
  f.options.model.stream = async function* (request) {
    requests.push(request)
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  try {
    const events = []
    for await (const event of service.submit('Finish the current check')) events.push(event)
    expect(requests).toHaveLength(1)
    expect(reasons.filter((reason) => reason === 'pressure')).toEqual([])
    expect(requests[0]!.contextStatus?.inputTokens).toBe(1930)
    expect(requests[0]!.contextStatus?.runway?.turns).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  } finally {
    await service.close()
  }
})

test('INV-45 measured usage reaches the host and persisted response with reported cache reads and writes', async () => {
  const usageOf = async (usage: Record<string, number>) => {
    const f = runFixture()
    const decisions: Array<Record<string, unknown>> = []
    const append = f.context.append.bind(f.context)
    f.context.append = async (input, signal) => {
      if (input.title === 'model-response') decisions.push(JSON.parse(input.body))
      return append(input, signal)
    }
    f.options.model = {
      ...f.options.model,
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'usage', inputTokens: 900, outputTokens: 20, ...usage }
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const service = createActRunService(f.options)
    const events = []
    for await (const event of service.submit('work')) events.push(event)
    await service.close()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.usage).toEqual({ inputTokens: 900, outputTokens: 20, ...usage })
    return events.filter((event) => event.type === 'usage')
  }
  expect(await usageOf({ cacheReadTokens: 600, cacheWriteTokens: 100 })).toEqual([
    {
      type: 'usage',
      runId: expect.any(String),
      inputTokens: 900,
      outputTokens: 20,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    },
  ])
  // 供应商没报告缓存时不带这两个数，宿主不会把「没报告」当成零
  const [plain] = await usageOf({})
  expect(plain).toEqual({
    type: 'usage',
    runId: expect.any(String),
    inputTokens: 900,
    outputTokens: 20,
  })
  expect('cacheReadTokens' in plain!).toBe(false)
})

test('INV-45 received usage survives simultaneous cancellation in the durable rejected request', async () => {
  const f = runFixture()
  const controller = new AbortController()
  let calls = 0
  f.options.model = {
    ...f.options.model,
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next() {
          calls++
          controller.abort(new DOMException('cancel with measured terminal', 'AbortError'))
          return Promise.resolve({
            done: false,
            value: { type: 'usage' as const, inputTokens: 19, outputTokens: 7, cacheReadTokens: 3 },
          })
        },
        return: async () => ({ done: true, value: undefined }),
      }),
    }),
  }
  const service = createActRunService(f.options)
  const events = []
  try {
    for await (const event of service.submit('work', controller.signal)) events.push(event)
    const state = await f.store.load('fault')
    const request = state!.records.find((record) => record.title === 'model-request')!
    const response = state!.records.find((record) => record.title === 'model-response')!
    const body = JSON.parse((await f.store.get('fault', response.objectId))!)
    expect(calls).toBe(1)
    expect(body).toMatchObject({
      status: 'rejected',
      turnId: request.ref.id,
      usage: { inputTokens: 19, outputTokens: 7, cacheReadTokens: 3 },
    })
    expect(response.sources).toContainEqual(request.ref)
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
    expect(events.some((event) => event.type === 'accepted')).toBe(false)
    expect((await service.inspect()).status).toBe('cancelled')
    expect(state!.task!.usage).toMatchObject({
      mainCalls: 1,
      inputTokens: 19,
      outputTokens: 7,
      unmeasuredCalls: 0,
    })
  } finally {
    await service.close()
  }
})

test('INV-46 continuation is linked only to an accepted complete response and never emitted to the host', async () => {
  for (const mode of [
    'accepted',
    'rejected',
    'length',
    'wrong-model',
    'duplicate',
    'write-failed',
  ]) {
    const f = runFixture()
    let executed = 0
    f.options.execution.invoke = async () => {
      executed++
    }
    const value = {
      model: mode === 'wrong-model' ? 'other' : 'fixture',
      format: 'fixture-v1',
      data: 'opaque-fixture',
      tokens: 40,
    }
    f.options.model = {
      ...f.options.model,
      async *stream() {
        yield { type: 'text', text: 'done' }
        yield { type: 'continuation', value }
        if (mode === 'duplicate') yield { type: 'continuation', value }
        yield { type: 'finish', reason: mode === 'length' ? 'length' : 'stop' }
      },
    }
    if (mode === 'rejected')
      f.options.protocol = {
        open: () => ({
          instructions: 'fixture',
          reset() {},
          push: () => [],
          finish() {
            throw Error('fixture protocol rejection')
          },
        }),
      }
    if (mode === 'write-failed') {
      const append = f.context.append.bind(f.context)
      f.context.append = async (input, signal) => {
        if (input.title === 'model-continuation') throw Error('fixture persistence failure')
        return append(input, signal)
      }
    }
    const service = createActRunService(f.options)
    const events = []
    for await (const event of service.submit('fixture')) events.push(event)
    const state = (await f.store.load('fault'))!
    const saved = state.records.filter((record) => record.title === 'model-continuation')
    const accepted = state.records.filter((record) => record.kind === 'assistant')
    expect(saved.length).toBe(mode === 'accepted' ? 1 : 0)
    expect(accepted.length).toBe(mode === 'accepted' ? 1 : 0)
    if (mode === 'accepted') {
      expect(accepted[0]!.sources).toContainEqual(saved[0]!.ref)
      expect(JSON.parse((await f.store.get('fault', saved[0]!.objectId))!)).toEqual(value)
      expect(saved[0]!.sequence).toBeLessThan(accepted[0]!.sequence)
    }
    expect(JSON.stringify(events)).not.toContain('opaque-fixture')
    expect(executed).toBe(0)
    await service.close()
  }
})

test('INV-43 reasoning reaches the host after its turn and never enters the context or the event journal', async () => {
  const f = runFixture()
  const written: string[] = []
  const put = f.store.put
  f.store.put = async (id, body) => {
    written.push(body)
    return put(id, body)
  }
  f.options.model = {
    ...f.options.model,
    async *stream() {
      yield { type: 'reasoning', text: 'weighing the options' }
      yield { type: 'reasoning', text: '' }
      yield { type: 'text', text: 'done' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit('work')) events.push(event)
  expect(events.filter((event) => event.type === 'reasoning')).toEqual([
    { type: 'reasoning', runId: expect.any(String), text: 'weighing the options' },
  ])
  // 思考属于最近一个 turn 事件，宿主据此把它归进那一轮
  const turn = events.findIndex((event) => event.type === 'turn')
  expect(turn).toBeGreaterThanOrEqual(0)
  expect(events.findIndex((event) => event.type === 'reasoning')).toBeGreaterThan(turn)
  expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  expect((await service.events()).some((item) => item.event.type === 'reasoning')).toBe(false)
  expect(written.some((body) => body.includes('weighing the options'))).toBe(false)
  await service.close()
  const malformed = {
    ...f.options.model,
    async *stream() {
      yield { type: 'reasoning', text: 42 } as never
    },
  }
  await expect(
    (async () => {
      for await (const _ of boundedModelStream(
        malformed,
        {
          instructions: '',
          materials: [],
          response: { type: 'text' },
          mode: 'work',
          outputTokens: 10,
        },
        AbortSignal.timeout(1000)
      ))
        throw Error('accepted a malformed reasoning delta')
    })()
  ).rejects.toThrow('模型思考增量不是文本')
})
test('INV-44 every model request of a session carries the same fixed-length cache key, protocol repairs included', async () => {
  const f = runFixture()
  const keys: Array<string | undefined> = []
  f.options.model = {
    ...f.options.model,
    async *stream(request) {
      keys.push(request.cacheKey)
      yield { type: 'text', text: 'done' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  // 第一份响应按协议错误拒掉，逼出一次修复重发
  let rejected = false
  f.options.protocol = {
    open: () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        if (!rejected) {
          rejected = true
          throw new AppError('SCRIPT_PROTOCOL', 'fixture rejects the first response')
        }
        return { message: 'done', done: true, events: [] }
      },
    }),
  }
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit('work')) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  await service.close()
  const expected = createHash('sha256').update('fault').digest('hex').slice(0, 32)
  expect(keys).toEqual([expected, expected])
  // 普通会话下的子任务 id 已有 66 个字符，键仍是 32 位，碰不到 OpenAI 64 字符的上限
  const child = 'agent:session-1789097089764-4:22a2d800-9c22-4105-a411-06d2b0427538'
  expect(child.length).toBeGreaterThan(64)
  expect(await sessionCacheKey(child)).toMatch(/^[0-9a-f]{32}$/)
})
test('closing a consumer during thinking releases the view without accepting late model output', async () => {
  const f = runFixture()
  let stopped = 0
  f.options.model.stream = async function* () {
    yield { type: 'text', text: 'preview' }
    await new Promise(() => {})
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.execution.stop = async () => {
    stopped++
  }
  const service = createActRunService(f.options)
  for await (const event of service.submit('work'))
    if (event.type === 'state' && event.status === 'thinking') break
  expect(stopped).toBe(1)
  expect((await f.view.inspect())?.lease).toBeNull()
  expect((await service.inspect()).status).toBe('cancelled')
  expect((await service.events()).some((item) => item.event.type === 'accepted')).toBe(false)
  await service.close()
})

test('INV-36 a fault persisting a child result reaches wait even after the live slot has been released', async () => {
  const store = storage()
  const put = store.put
  let failed = false
  store.put = async (id, body) => {
    if (body.includes('"events"')) {
      failed = true
      throw Error('child result disk failure')
    }
    return put(id, body)
  }
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open() {
      return child()
    },
  })
  const signal = new AbortController().signal
  const job = await supervisor.start('p', { task: 'work', profile: 'read' }, signal)
  while (!failed) await new Promise((r) => setTimeout(r, 1))
  await expect(supervisor.wait('p', job.id, signal)).rejects.toThrow('child result disk failure')
  await expect(supervisor.close()).rejects.toThrow('child result disk failure')
})

test('INV-37 steering invalidates a stale response before slow input persistence completes', async () => {
  const f = runFixture()
  let release!: () => void
  let received!: () => void
  let calls = 0
  let executed = 0
  const gate = new Promise<void>((r) => (release = r))
  const arrived = new Promise<void>((r) => (received = r))
  const ingest = f.context.ingest.bind(f.context)
  f.context.ingest = async (input, signal) => {
    if (input.text === 'new direction') {
      received()
      await gate
    }
    return ingest(input, signal)
  }
  f.options.model.stream = async function* () {
    calls++
    if (calls === 1) {
      yield { type: 'text', text: 'old' }
      await arrived
      yield { type: 'text', text: 'stale code' }
      yield { type: 'finish', reason: 'stop' }
    } else {
      yield { type: 'text', text: 'done' }
      yield { type: 'finish', reason: 'stop' }
    }
  }
  f.options.protocol = {
    open: () => ({
      instructions: 'fixture',
      reset() {},
      push(text) {
        return [{ type: 'text', text }]
      },
      finish() {
        return calls === 1
          ? { message: 'stale', done: false, submission: { code: 'stale' }, events: [] }
          : { message: 'done', done: true, events: [] }
      },
    }),
  }
  f.options.execution.invoke = async () => {
    executed++
  }
  const service = createActRunService(f.options)
  let steering: Promise<void> | undefined
  for await (const event of service.submit('original')) {
    if (event.type === 'text' && !steering) {
      steering = service.steer('new direction')
      await arrived
      setTimeout(release, 15)
    }
  }
  await steering
  expect(calls).toBe(2)
  expect(executed).toBe(0)
  expect((await f.view.inspect())?.goals.length).toBe(2)
  await service.close()
})

test('all cleanup stages are attempted when both execution and frame cleanup fail', async () => {
  const f = runFixture()
  let release = 0
  f.options.execution.stop = async () => {
    throw Error('execution cleanup')
  }
  f.options.frames.end = async () => {
    throw Error('frame cleanup')
  }
  const end = f.view.end.bind(f.view)
  f.view.end = async (status) => {
    release++
    await end(status)
  }
  const service = createActRunService(f.options)
  let error: unknown
  try {
    for await (const event of service.submit('work')) {
      expect(typeof event.type).toBe('string')
    }
  } catch (value) {
    error = value
  }
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors).toHaveLength(2)
  expect(release).toBe(1)
  expect((await f.view.inspect())?.lease).toBeNull()
  await service.close()
})

test('steering during completion verification invalidates the old completion and delivers the new goal', async () => {
  const f = runFixture()
  let entered!: () => void
  let release!: () => void
  let checks = 0
  const checking = new Promise<void>((r) => (entered = r))
  const gate = new Promise<void>((r) => (release = r))
  const service = createActRunService({
    ...f.options,
    completionVerifier: {
      async verify() {
        if (++checks === 1) {
          entered()
          await gate
        }
        return { verified: true, reason: 'fixture' }
      },
    },
  })
  const events = []
  const running = (async () => {
    for await (const event of service.submit('first')) events.push(event)
  })()
  await checking
  await service.steer('new goal during verification')
  release()
  await running
  expect(checks).toBe(2)
  expect((await f.view.inspect())?.goals.length).toBe(2)
  expect(
    events.filter((event) => event.type === 'state' && event.status === 'completed')
  ).toHaveLength(1)
  expect(events.filter((event) => event.type === 'turn')).toHaveLength(2)
  await service.close()
})

function storage(): ContextStorage {
  const states = new Map<string, ContextState>()
  const objects = new Map<string, string>()
  return {
    async load(id) {
      return structuredClone(states.get(id) ?? null)
    },
    async compareAndSwap(id, version, next) {
      if ((states.get(id)?.version ?? 0) !== version) return false
      states.set(id, structuredClone(next))
      return true
    },
    async put(id, text) {
      const key = crypto.randomUUID()
      objects.set(id + key, text)
      return key
    },
    async get(id, key) {
      return objects.get(id + key) ?? null
    },
    async close() {},
  }
}
function child(block = false): ActChildSession {
  return {
    async *submit(_input, signal) {
      yield { type: 'state', runId: 'child', status: 'thinking' }
      if (block)
        await new Promise<void>((resolve) => {
          signal!.addEventListener('abort', () => resolve(), { once: true })
          if (signal!.aborted) resolve()
        })
      yield { type: 'state', runId: 'child', status: signal?.aborted ? 'cancelled' : 'completed' }
    },
    async answer() {},
    async steer() {},
    cancel() {},
    async close() {},
  }
}

test('INV-38 child delivery bounds embedded history and never turns an unfinished end into completion', async () => {
  const store = storage()
  const signal = new AbortController().signal
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open() {
      return {
        ...child(),
        async *submit() {
          for (let i = 0; i < 1000; i++)
            yield {
              type: 'accepted',
              runId: 'child',
              turnId: String(i),
              text: 'x'.repeat(5000),
              ref: { sessionId: 'child', id: String(i) },
            }
          yield { type: 'state', runId: 'child', status: 'context_blocked' }
        },
      }
    },
  })
  const started = await supervisor.start('p', { task: 'many turns', profile: 'read' }, signal)
  const job = await supervisor.wait('p', started.id, signal)
  expect(job.status).toBe('failed')
  const context = createContextRuntime({ sessionId: 'p', storage: store })
  const record = await context.read(job.result!, { limit: 1 })
  const raw = (await store.get('p', record.record.objectId))!
  const result = JSON.parse(raw)
  expect(raw.length).toBeLessThan(130000)
  expect(result.omittedEvents).toBeGreaterThan(970)
  expect(result.events.length + result.omittedEvents).toBe(1001)
  expect(result.events.at(-1).status).toBe('context_blocked')
  expect(result.eventSource.sessionId).toBe(job.sessionId)
  await supervisor.close()
})

test('INV-29 a driver ignoring cancellation cannot publish late deltas', async () => {
  const model = {
    id: 'hung',
    limits: { contextTokens: 100, inputTokens: 90, outputTokens: 10 },
    estimate: async () => ({ tokens: 1, precision: 'exact' as const, basis: 'fixture' }),
    async *stream() {
      await new Promise(() => {})
      yield { type: 'finish' as const, reason: 'stop' as const }
    },
  }
  await expect(
    (async () => {
      for await (const _ of boundedModelStream(
        model,
        {
          instructions: '',
          materials: [],
          response: { type: 'text' },
          mode: 'work',
          outputTokens: 10,
        },
        AbortSignal.timeout(20)
      ))
        throw Error('late')
    })()
  ).rejects.toThrow()
})
test('INV-30 concurrent child dispatch reserves quota before opening; children do not claim write scopes', async () => {
  let opened = 0
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 2,
    maxChildren: 5,
    async open() {
      opened++
      return child(true)
    },
  })
  const signal = new AbortController().signal
  try {
    // 两个子任务做同一类事也能同时跑：子任务不占写入范围，能做的与父任务一样
    const a = await supervisor.start('p', { task: 'a', profile: 'read' }, signal)
    const b = await supervisor.start('p', { task: 'b', profile: 'read' }, signal)
    await expect(supervisor.start('p', { task: 'c', profile: 'read' }, signal)).rejects.toThrow(
      '额度'
    )
    expect(opened).toBe(2)
    await supervisor.cancel('p', a.id)
    await supervisor.cancel('p', b.id)
  } finally {
    await supervisor.close()
  }
})
test('INV-31 child quota and parent identity survive reopen and resume does not create a new session', async () => {
  const store = storage()
  const signal = new AbortController().signal
  const ids: string[] = []
  const options = {
    storage: store,
    concurrency: 2,
    maxChildren: 1,
    async open(job: { sessionId: string }) {
      ids.push(job.sessionId)
      return child()
    },
  }
  const first = createAgentSupervisor(options)
  const job = await first.start('p', { task: 'a', profile: 'read' }, signal)
  await first.wait('p', job.id, signal)
  await first.close()
  const next = createAgentSupervisor(options)
  try {
    await expect(next.status('other', job.id)).rejects.toThrow()
    await expect(next.start('p', { task: 'b', profile: 'read' }, signal)).rejects.toThrow('额度')
    await next.resume('p', job.id, { input: 'more' }, signal)
    const result = await next.wait('p', job.id, signal)
    expect(result.status).toBe('completed')
    expect(result.result?.sessionId).toBe('p')
    expect(ids).toEqual([job.sessionId, job.sessionId])
  } finally {
    await next.close()
  }
})
test('INV-32 parent cancellation reaches children and leaves a readable partial result', async () => {
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 2,
    maxChildren: 3,
    async open() {
      return child(true)
    },
  })
  const parent = new AbortController()
  try {
    const job = await supervisor.start('p', { task: 'a', profile: 'read' }, parent.signal)
    parent.abort()
    const done = await supervisor.wait('p', job.id, new AbortController().signal)
    expect(done.status).toBe('cancelled')
    expect(done.result).toBeDefined()
    expect(supervisor.pending('p')).toBe(false)
  } finally {
    await supervisor.close()
  }
})
test('INV-33 independent JS dispatch preserves completed children when one child fails', async () => {
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 3,
    maxChildren: 4,
    async open(job) {
      if (job.profile === 'fail') throw Error('fixture failure')
      return child()
    },
  })
  const signal = new AbortController().signal
  try {
    const jobs = await Promise.all(
      ['ok', 'fail'].map((profile) => supervisor.start('p', { task: profile, profile }, signal))
    )
    const states = await Promise.all(jobs.map((job) => supervisor.wait('p', job.id, signal)))
    expect(states.map((x) => x.status)).toEqual(['completed', 'failed'])
    expect(states[1]?.error).toContain('fixture failure')
  } finally {
    await supervisor.close()
  }
})

test('shutdown waits for an in-flight admission before cancelling the created child', async () => {
  const store = storage()
  const put = store.put
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((r) => (entered = r))
  const blocked = new Promise<void>((r) => (release = r))
  let first = true
  store.put = async (id, text) => {
    if (first) {
      first = false
      entered()
      await blocked
    }
    return put(id, text)
  }
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open() {
      return child(true)
    },
  })
  const pending = supervisor.start(
    'p',
    { task: 'a', profile: 'read' },
    new AbortController().signal
  )
  await started
  const closing = supervisor.close()
  release()
  const job = await pending
  await closing
  expect(supervisor.pending('p')).toBe(false)
  expect((await supervisor.status('p', job.id)).status).toBe('cancelled')
})

test('child request ownership, duplicate answers and interrupted recovery preserve the original run boundary', async () => {
  const store = storage()
  const answered = Promise.withResolvers<void>()
  const signal = new AbortController().signal
  const request = {
    id: 'question',
    runId: 'original-run',
    kind: 'capability' as const,
    message: 'Need write scope',
  }
  let answers = 0
  const options = {
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open(): Promise<ActChildSession> {
      return {
        ...child(),
        async *submit() {
          yield { type: 'interaction', runId: request.runId, request }
          await answered.promise
          yield { type: 'answer', runId: request.runId, id: request.id }
          yield { type: 'state', runId: request.runId, status: 'completed' }
        },
        async answer(value) {
          expect(value.runId).toBe(request.runId)
          expect(value.id).toBe(request.id)
          answers++
          answered.resolve()
        },
      }
    },
  }
  const supervisor = createAgentSupervisor(options)
  const job = await supervisor.start('parent', { task: 'inspect', profile: 'read' }, signal)
  const waiting = await supervisor.wait('parent', job.id, signal)
  expect(waiting.status).toBe('waiting')
  expect(waiting.pending?.[0]?.kind).toBe('capability')
  await expect(supervisor.reply('other', job.id, request.id, true)).rejects.toThrow('不属于')
  await expect(supervisor.reply('parent', job.id, 'wrong', true)).rejects.toThrow('请求')
  await expect(
    supervisor.resume('parent', job.id, { input: 'replace while active' }, signal)
  ).rejects.toThrow()
  const reopened = createAgentSupervisor(options)
  expect((await reopened.status('parent', job.id)).status).toBe('interrupted')
  await expect(reopened.reply('parent', job.id, request.id, true)).rejects.toThrow('请求')
  await supervisor.reply('parent', job.id, request.id, { finishPhase: true })
  expect((await supervisor.wait('parent', job.id, signal)).status).toBe('completed')
  await expect(supervisor.reply('parent', job.id, request.id, true)).rejects.toThrow('请求')
  expect(answers).toBe(1)
  await supervisor.close()
  await reopened.close()
})

test('child start, status and resume without optional grants produce strict JSON receipts', async () => {
  const store = storage()
  const signal = new AbortController().signal
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open() {
      return child()
    },
  })
  try {
    const first = await supervisor.start('p', { task: 'inspect', profile: 'read' }, signal)
    expect(first).toEqual(JSON.parse(JSON.stringify(first)))
    expect(Object.hasOwn(first, 'stores')).toBe(false)
    const completed = await supervisor.wait('p', first.id, signal)
    expect(completed).toEqual(JSON.parse(JSON.stringify(completed)))
    const resumed = await supervisor.resume(
      'p',
      first.id,
      { id: first.id, input: 'continue' },
      signal
    )
    expect(resumed).toEqual(JSON.parse(JSON.stringify(resumed)))
    expect(Object.hasOwn(resumed, 'stores')).toBe(false)
    expect((await supervisor.wait('p', first.id, signal)).status).toBe('completed')
  } finally {
    await supervisor.close()
  }
})

test('INV-39 input receipts bind host identity to durable admission and the exact model request', async () => {
  const f = runFixture()
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit({ text: 'root', inputId: 'host-root' }))
    events.push(event)
  const accepted = events.find((event) => event.type === 'input')!
  const applied = events.find((event) => event.type === 'input-applied')!
  const turn = events.find((event) => event.type === 'turn')!
  expect(accepted).toMatchObject({ source: 'submit', inputId: 'host-root' })
  expect(applied).toMatchObject({
    inputId: 'host-root',
    ref: accepted.type === 'input' ? accepted.ref : undefined,
    turnId: turn.type === 'turn' ? turn.turnId : undefined,
  })
  expect(events.indexOf(accepted)).toBeLessThan(events.indexOf(applied))
  expect(events.indexOf(applied)).toBeLessThan(events.indexOf(turn))
  const persisted = (await service.events()).map((item) => item.event)
  expect(persisted).toContainEqual(accepted)
  expect(persisted).toContainEqual(applied)
  expect(events.some((event) => event.type === 'input-retained')).toBe(false)
  await service.close()
})

test('cancellation before a model request retains the input and restart consumes it once', async () => {
  const f = runFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  f.options.frames.prepare = () => gate
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit({ text: 'first', inputId: 'retained-root' })) {
    events.push(event)
    if (event.type === 'input') {
      service.cancel()
      release()
    }
  }
  expect(events.some((event) => event.type === 'turn')).toBe(false)
  expect(events.some((event) => event.type === 'input-applied')).toBe(false)
  expect(events.find((event) => event.type === 'input-retained')).toMatchObject({
    inputId: 'retained-root',
  })
  await service.close()
  f.options.frames.prepare = async () => {}
  const reopened = createActRunService(f.options)
  const resumed = []
  for await (const event of reopened.submit({ text: 'continue', inputId: 'next-root' }))
    resumed.push(event)
  expect(
    resumed.filter((event) => event.type === 'input-applied' && event.inputId === 'retained-root')
  ).toHaveLength(1)
  const again = []
  for await (const event of reopened.submit('one more')) again.push(event)
  expect(
    again.some((event) => event.type === 'input-applied' && event.inputId === 'retained-root')
  ).toBe(false)
  await reopened.close()
})

test('guidance cancellation reports exactly the accepted input left outside a model request', async () => {
  const f = runFixture()
  let started!: () => void
  const ready = new Promise<void>((resolve) => (started = resolve))
  f.options.model.stream = async function* (_request, signal) {
    started()
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
      if (signal.aborted) resolve()
    })
    signal.throwIfAborted()
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  const running = (async () => {
    for await (const event of service.submit('original')) events.push(event)
  })()
  await ready
  await service.steer({ text: 'queued direction', inputId: 'host-guide' })
  service.cancel()
  await running
  expect(
    events.filter((event) => event.type === 'input' && event.inputId === 'host-guide')
  ).toHaveLength(1)
  const applied = events.filter(
    (event) => event.type === 'input-applied' && event.inputId === 'host-guide'
  )
  const retained = events.filter(
    (event) => event.type === 'input-retained' && event.inputId === 'host-guide'
  )
  expect(applied.length + retained.length).toBe(1)
  const durable = (await service.events()).map((item) => item.event)
  expect(durable).toContainEqual((applied[0] ?? retained[0])!)
  await service.close()
})

test('failed input receipt persistence never acknowledges or dispatches the accepted input', async () => {
  const f = runFixture()
  const put = f.store.put
  let calls = 0
  f.store.put = async (id, body) => {
    if (body.startsWith('{"type":"input"')) throw Error('input receipt disk failure')
    return put(id, body)
  }
  f.options.model.stream = async function* () {
    calls++
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  await expect(
    (async () => {
      for await (const event of service.submit({ text: 'work', inputId: 'failed' }))
        events.push(event)
    })()
  ).rejects.toThrow('input receipt disk failure')
  expect(events.some((event) => event.type === 'input')).toBe(false)
  expect(calls).toBe(0)
  await service.close()
})

test('overlapping guidance receipts preserve identities and bind to their prepared requests', async () => {
  const f = runFixture()
  let started!: () => void
  let calls = 0
  let release!: () => void
  let preparing!: () => void
  let preparations = 0
  const ready = new Promise<void>((resolve) => (started = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const arrived = new Promise<void>((resolve) => (preparing = resolve))
  f.options.frames.prepare = async () => {
    if (++preparations === 2) {
      preparing()
      await gate
    }
  }
  f.options.model.stream = async function* (_request, signal) {
    if (++calls === 1) {
      started()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
        if (signal.aborted) resolve()
      })
      signal.throwIfAborted()
    }
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  const running = (async () => {
    for await (const event of service.submit('first')) events.push(event)
  })()
  await ready
  await service.steer({ text: 'guide one', inputId: 'one' })
  await arrived
  await service.steer({ text: 'guide two', inputId: 'two' })
  release()
  await running
  for (const id of ['one', 'two']) {
    expect(events.filter((event) => event.type === 'input' && event.inputId === id)).toHaveLength(1)
    const applied = events.filter((event) => event.type === 'input-applied' && event.inputId === id)
    expect(applied).toHaveLength(1)
    expect(
      events.some((event) => event.type === 'turn' && event.turnId === applied[0]!.turnId)
    ).toBe(true)
  }
  expect(events.some((event) => event.type === 'input-retained')).toBe(false)
  await service.close()
})

test('failed applied receipt persistence keeps admission truthful and prevents model dispatch', async () => {
  const f = runFixture()
  const put = f.store.put
  let calls = 0
  f.store.put = async (id, body) => {
    if (body.startsWith('{"type":"input-applied"')) throw Error('applied receipt disk failure')
    return put(id, body)
  }
  f.options.model.stream = async function* () {
    calls++
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  await expect(
    (async () => {
      for await (const event of service.submit({ text: 'work', inputId: 'unapplied' }))
        events.push(event)
    })()
  ).rejects.toThrow('applied receipt disk failure')
  expect(events.some((event) => event.type === 'input' && event.inputId === 'unapplied')).toBe(true)
  expect(events.some((event) => event.type === 'input-applied')).toBe(false)
  expect(events.find((event) => event.type === 'input-retained')).toMatchObject({
    inputId: 'unapplied',
  })
  expect(calls).toBe(0)
  await service.close()
})

test('INV-47 retrying an interrupted unaccepted frame resets decoding and never repeats earlier effects', async () => {
  const f = runFixture()
  const executed: string[] = []
  let requests = 0
  let decoded = 0
  const rejected = JSON.stringify({
    message: 'unaccepted fixture',
    done: false,
    submission: { code: 'must-not-execute' },
  })
  const history: string[] = []
  f.options.protocol = {
    open: () => {
      let text = ''
      return {
        instructions: 'fixture',
        reset() {
          text = ''
        },
        push(delta) {
          text += delta
          return []
        },
        finish() {
          decoded++
          return { ...JSON.parse(text), events: [] }
        },
      }
    },
  }
  f.options.model.stream = async function* (request) {
    history.push(JSON.stringify(request))
    const index = requests++
    if (index === 1) {
      yield { type: 'text', text: rejected }
      yield {
        type: 'error',
        code: 'provider',
        message: 'fixture transport ended before terminal',
        retryAfterMs: 0,
      }
      return
    }
    yield {
      type: 'text',
      text: JSON.stringify(
        index === 3
          ? { message: 'done', done: true }
          : {
              message: 'work',
              done: false,
              submission: { code: index === 0 ? 'first' : 'second' },
            }
      ),
    }
    yield { type: 'usage', inputTokens: 19, outputTokens: 7 }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.execution.invoke = async (submission) => {
    executed.push((submission as { code: string }).code)
  }
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit('work')) events.push(event)
  expect(requests).toBe(4)
  expect(decoded).toBe(3)
  expect(executed).toEqual(['first', 'second'])
  expect(events.filter((event) => event.type === 'turn')).toHaveLength(4)
  expect(events.filter((event) => event.type === 'usage')).toHaveLength(3)
  expect(events.filter((event) => event.type === 'rejected')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  expect(history[2]).toBe(history[1])
  expect(history.slice(2).some((body) => body.includes('must-not-execute'))).toBe(false)
  const records = (await f.store.load('fault'))!.records
  const responses = await Promise.all(
    records
      .filter((record) => record.title === 'model-response')
      .map(async (record) => JSON.parse((await f.store.get('fault', record.objectId))!))
  )
  expect(responses.map((response) => response.status)).toEqual([
    'accepted',
    'rejected',
    'accepted',
    'accepted',
  ])
  expect(responses[1]).not.toHaveProperty('usage')
  const raw = records.find((record) => record.title === 'model-response-raw')!
  expect(await f.store.get('fault', raw.objectId)).toBe(rejected)
  const retry = records.find((record) => record.title === 'model-retry')!
  expect(JSON.parse((await f.store.get('fault', retry.objectId))!)).toMatchObject({
    attempt: 1,
    executed: false,
  })
  await service.close()
})

test('INV-47 interrupted response retries are bounded and permanent rejection or cancellation never retries', async () => {
  for (const mode of ['transient', 'permanent', 'cancelled'] as const) {
    const f = runFixture()
    const controller = new AbortController()
    let calls = 0
    let executed = 0
    f.options.execution.invoke = async () => {
      executed++
    }
    f.options.model.stream = async function* () {
      calls++
      yield { type: 'text', text: 'complete-looking unaccepted fixture' }
      if (mode === 'cancelled') controller.abort()
      yield {
        type: 'error',
        code: 'provider',
        message: 'fixture interrupted',
        ...(mode === 'permanent' ? {} : { retryAfterMs: 0 }),
      }
    }
    const service = createActRunService(f.options)
    const events = []
    for await (const event of service.submit('work', controller.signal)) events.push(event)
    expect(calls).toBe(mode === 'transient' ? 3 : 1)
    expect(executed).toBe(0)
    expect(events.some((event) => event.type === 'accepted')).toBe(false)
    expect(events.some((event) => event.type === 'usage')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'state',
      status: mode === 'cancelled' ? 'cancelled' : 'failed',
    })
    await service.close()
  }
})

test('INV-48 each request continues the previous accepted one: sent frames stay in history, later frames render only changes, rewrites start over', async () => {
  const f = runFixture()
  const logical: Array<{ role: 'user' | 'assistant'; content: string; cacheBreakpoint?: boolean }> =
    [
      { role: 'user', content: 'segment base', cacheBreakpoint: true },
      { role: 'user', content: 'task', cacheBreakpoint: true },
    ]
  let turn = 0
  const requests: Array<ReturnType<typeof modelRequestEncoder.messages>> = []
  const deltas: Array<{ body: string; previous: string }> = []
  f.options.limits = { ...f.options.limits, turns: 8 }
  f.options.frames = {
    ...f.options.frames,
    async project() {
      const body = JSON.stringify({ turn, stable: 'same' })
      return {
        body,
        images: [],
        prompt: `full frame ${turn}`,
        history: logical.map((message, index) =>
          index === logical.length - 1 ? { ...message, cacheBreakpoint: true } : message
        ),
      }
    },
    delta(body, previous) {
      deltas.push({ body, previous })
      return `delta frame ${JSON.parse(body).turn}`
    },
  }
  f.options.protocol = {
    open: () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return turn >= 5
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
      },
    }),
  }
  f.options.model.stream = async function* (request) {
    requests.push(modelRequestEncoder.messages(request))
    yield { type: 'text', text: `response ${turn}` }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.execution.invoke = async () => {
    turn++
    logical.push({ role: 'assistant', content: `response ${turn}` })
    logical.push({ role: 'user', content: `result ${turn}` })
    // 第三轮之后改写更早的结果（如容量不足退成引用卡），下一次请求只能完整重发
    if (turn === 3) logical[3] = { role: 'user', content: 'result 1 reference card' }
  }
  const service = createActRunService(f.options)
  for await (const event of service.submit('work')) expect(typeof event.type).toBe('string')
  const text = (message: (typeof requests)[number][number]) =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  const extends_ = (next: (typeof requests)[number], previous: (typeof requests)[number]) =>
    previous.every((message, index) => text(next[index]!) === text(message))
  expect(requests).toHaveLength(6)
  // 第 1 帧完整；第 2、3 帧把上一请求整段原样留在前面，只追加新条目和增量帧
  expect(text(requests[0]!.at(-1)!)).toContain('full frame 0')
  for (const index of [1, 2]) {
    expect(extends_(requests[index]!, requests[index - 1]!)).toBe(true)
    expect(text(requests[index]!.at(-1)!)).toContain(`delta frame ${index}`)
  }
  // 历史被改写后不再沿用，完整重发；之后又从这一次重新开始只往后加
  expect(extends_(requests[3]!, requests[2]!)).toBe(false)
  expect(text(requests[3]!.at(-1)!)).toContain('full frame 3')
  for (const index of [4, 5]) {
    expect(extends_(requests[index]!, requests[index - 1]!)).toBe(true)
    expect(text(requests[index]!.at(-1)!)).toContain(`delta frame ${index}`)
  }
  expect(deltas.map((item) => JSON.parse(item.previous).turn)).toEqual([0, 1, 3, 4])
  // 断点只沿用逻辑历史里的标记，另加上一请求的末尾，不随轮数累积
  const marks = requests.at(-1)!.filter((message) => message.cacheBreakpoint)
  expect(marks.length).toBeLessThanOrEqual(4)
  await service.close()
})

test.each(['available', 'forecast', 'capacity'] as const)(
  'INV-48 large delivered material retains the accepted prefix until actual capacity requires rebuilding: %s',
  async (mode) => {
    const f = runFixture()
    const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'Read the evidence' }]
    const evidence = 'Preserve the supplied evidence and its exact contents.\n'.repeat(160)
    const requests: ModelTurnRequest[] = []
    let turn = 0
    let reclaimed = 0
    f.options.frames = {
      ...f.options.frames,
      async project() {
        return {
          body: JSON.stringify({ evidence, turn }),
          prompt: evidence,
          images: [],
          history: [...logical],
        }
      },
      delta() {
        return `Current step ${turn}; evidence is in the retained history.`
      },
      async retire() {
        reclaimed++
        return false
      },
      async fold() {
        reclaimed++
        return false
      },
    }
    f.options.model.estimate = async (request) => ({
      tokens:
        mode === 'capacity' && turn === 1 && (request.history?.length ?? 0) > logical.length
          ? 9500
          : mode === 'forecast' && turn === 1
            ? 8500
            : 2000,
      precision: 'exact',
      basis: 'bounded evidence with a capacity change',
    })
    f.options.model.stream = async function* (request) {
      requests.push(request)
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return turn >= 2
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: { code: 'work' }, events: [] }
      },
    })
    f.options.execution.invoke = async () => {
      logical.push({ role: 'assistant', content: `accepted ${turn++}` })
      logical.push({ role: 'user', content: `result ${turn}` })
    }
    const service = createActRunService(f.options)
    try {
      for await (const _event of service.submit('Read the evidence and complete two steps')) {
        // Exercise acceptance, retention, admission, and normal completion together.
      }
      expect(requests).toHaveLength(3)
      expect(reclaimed).toBe(0)
      const contents = (request: ModelTurnRequest) =>
        modelRequestEncoder.messages(request).map(({ role, content }) => ({ role, content }))
      const first = contents(requests[0]!)
      const second = contents(requests[1]!)
      if (mode !== 'capacity') {
        expect(second.slice(0, first.length)).toEqual(first)
        expect(requests[1]!.compiledPrompt).not.toContain(evidence)
        if (mode === 'forecast') expect(requests[1]!.contextStatus?.runway?.turns).toBe(1)
      } else {
        expect(second.slice(0, first.length)).not.toEqual(first)
        expect(requests[1]!.compiledPrompt).toContain(evidence)
      }
      expect(contents(requests[2]!).slice(0, second.length)).toEqual(second)
      for (const request of requests) {
        expect(
          JSON.stringify(contents(request)).split(JSON.stringify(evidence).slice(1, -1))
        ).toHaveLength(2)
        expect((await f.options.model.estimate(request)).tokens).toBeLessThanOrEqual(9000)
      }
    } finally {
      await service.close()
    }
  }
)

test.each(['fits', 'overflow', 'provider-reject', 'timeout', 'abort'] as const)(
  'INV-50 protocol repair preserves calibrated admission and execution boundaries: %s',
  async (mode) => {
    const f = runFixture()
    const controller = new AbortController()
    let calls = 0
    let executed = 0
    let folded = false
    let folds = 0
    let abortTimer: Optional<ReturnType<typeof setTimeout>>
    const sent: string[] = []
    f.options.limits = { ...f.options.limits, timeoutMs: mode === 'timeout' ? 100 : 2000 }
    f.options.model.estimate = async (request) => {
      const repair = request.compiledPrompt?.includes('本帧上次响应未通过校验')
      if (repair && (mode === 'timeout' || mode === 'abort')) {
        if (mode === 'abort') abortTimer = setTimeout(() => controller.abort(), 20)
        return new Promise(() => {})
      }
      return {
        tokens:
          folded || executed === 0 ? 1000 : repair ? (mode === 'overflow' ? 120000 : 12020) : 12000,
        precision: 'estimate',
        basis: 'synthetic repair estimate',
      }
    }
    f.options.model.stream = async function* (request) {
      calls++
      sent.push(request.compiledPrompt!)
      if (mode === 'provider-reject' && calls === 2) {
        yield { type: 'error', code: 'context-limit', message: 'synthetic provider rejection' }
        return
      }
      yield { type: 'usage', inputTokens: calls === 1 ? 100 : 1000, outputTokens: 1 }
      yield { type: 'text', text: calls === 2 ? 'unaccepted response' : 'accepted response' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'synthetic protocol',
      reset() {},
      push() {
        return []
      },
      finish() {
        if (calls === 2) throw new AppError('SCRIPT_PROTOCOL', 'synthetic invalid intent')
        return executed === 0
          ? { message: 'work', done: false, submission: { code: 'synthetic work' }, events: [] }
          : { message: 'done', done: true, events: [] }
      },
    })
    f.options.execution.invoke = async () => {
      executed++
    }
    if (mode === 'provider-reject')
      f.options.frames.fold = async (reason) => {
        expect(reason).toBe('provider')
        folded = true
        folds++
        return true
      }
    const service = createActRunService(f.options)
    const started = performance.now()
    const events = []
    try {
      for await (const event of service.submit('synthetic task', controller.signal))
        events.push(event)
      const records = (await f.store.load('fault'))!.records
      const requests = await Promise.all(
        records
          .filter((record) => record.title === 'model-request')
          .map(async (record) => JSON.parse((await f.store.get('fault', record.objectId))!))
      )
      const responses = await Promise.all(
        records
          .filter((record) => record.title === 'model-response')
          .map(async (record) => JSON.parse((await f.store.get('fault', record.objectId))!))
      )
      // The rejected response cannot be executed or become repair history.
      expect(executed).toBe(1)
      expect(sent.every((prompt) => !prompt.includes('unaccepted response'))).toBe(true)
      expect(requests[1].estimate.tokens).toBe(Math.ceil(12000 * ((100 / 1000) * 1.1)))
      expect(responses[1].status).toBe('rejected')
      if (mode !== 'provider-reject')
        expect(responses[1].usage).toEqual({ inputTokens: 1000, outputTokens: 1 })
      if (mode === 'fits') {
        expect(calls).toBe(3)
        // Both provider usages count, including the protocol-rejected response.
        // The learned growth is 900 / 11000 with a separately rounded fixed reserve.
        const slope = (1000 - 100) / (12000 - 1000)
        const overhead = Math.ceil((100 - slope * 1000) * 1.1)
        expect(requests[2].estimate.tokens).toBe(Math.ceil(12020 * slope * 1.1 + overhead))
        expect(requests[2].request.compiledPrompt).toContain('synthetic invalid intent')
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      } else if (mode === 'overflow') {
        expect(calls).toBe(2)
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'context_blocked' })
      } else if (mode === 'provider-reject') {
        expect(calls).toBe(3)
        expect(folds).toBe(1)
        expect(requests[2].estimate.basis).not.toContain('校准')
        expect(responses[1]).not.toHaveProperty('usage')
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      } else {
        expect(calls).toBe(2)
        expect(performance.now() - started).toBeLessThan(1000)
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'cancelled' })
      }
    } finally {
      clearTimeout(abortTimer)
      await service.close()
    }
  }
)
