import { createHash } from 'node:crypto'

import { afterEach, expect, test } from 'bun:test'

import type { ContextStorage } from '@velaros-ai/context'
import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import type { ModelHistoryMessage, ModelTurnRequest } from '@velaros-ai/kernel'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import type { ActChildSession } from '../src/contract/requires.js'
import type { ActRunServiceOptions } from '../src/contract/requires.js'
import { createAgentSupervisor } from '../src/index.js'
import { createActRunService } from '../src/index.js'
import { sessionCacheKey } from '../src/utils/cache-key.js'
import { agentCollaboration, agentCollaborationConflicts } from '../src/utils/delegation.js'
import { remainingFrameImages, requestChars } from '../src/utils/frame-prompt.js'
import { boundedModelStream } from '../src/utils/model-stream.js'

test('collaboration normalizes lexical roots and rejects ambiguous write paths', () => {
  const input = { root: 'C:\\Work\\temp\\..\\Repo\\', plannedWrites: ['SRC\\a', './SRC/a', '.'] }
  expect(agentCollaboration(input)).toEqual({ root: 'c:/work/repo', plannedWrites: ['src/a', '.'] })
  expect(agentCollaboration({ root: '//Server/Share/app/../', plannedWrites: ['SRC'] })).toEqual({
    root: '//server/share',
    plannedWrites: ['src'],
  })
  expect(agentCollaboration({ root: '/work/../repo', plannedWrites: ['SRC'] })).toEqual({
    root: '/repo',
    plannedWrites: ['SRC'],
  })
  expect(agentCollaboration(undefined)).toBeUndefined()
  for (const path of ['../a', 'a/../b', '/a', 'C:/a', '\\a', '**', 'a?b', ''])
    expect(() => agentCollaboration({ root: '/repo', plannedWrites: [path] })).toThrow()
  for (const root of ['relative', 'C:repo', '//server', '/../../repo'])
    expect(() => agentCollaboration({ root, plannedWrites: ['a'] })).toThrow()
  expect(() => agentCollaboration({ root: '/repo', plannedWrites: Array(33).fill('a') })).toThrow()
  expect(() => agentCollaboration({ root: '/repo', plannedWrites: ['a'.repeat(1025)] })).toThrow()
})

test('collaboration reports bounded verifiable overlaps without confusing prefix or task', () => {
  const base = {
    id: 'a',
    sessionId: 'a',
    parentSessionId: 'p',
    parentTaskId: 'task',
    profile: 'read',
    status: 'running' as const,
  }
  const job = {
    ...base,
    collaboration: agentCollaboration({ root: 'C:/Repo', plannedWrites: ['src'] }),
  }
  const peer = {
    ...base,
    id: 'b',
    sessionId: 'b',
    collaboration: agentCollaboration({ root: 'c:/repo/src', plannedWrites: ['file.ts'] }),
  }
  expect(agentCollaborationConflicts(job, [peer]).conflicts).toEqual([
    {
      jobId: 'b',
      sessionId: 'b',
      path: 'c:/repo/src',
      otherPath: 'c:/repo/src/file.ts',
      reason: 'path-overlap',
    },
  ])
  for (const other of [
    { ...peer, status: 'completed' as const },
    { ...peer, parentTaskId: 'old' },
    { ...peer, parentSessionId: 'other' },
    {
      ...peer,
      collaboration: agentCollaboration({ root: 'c:/repo', plannedWrites: ['src-other'] }),
    },
  ])
    expect(agentCollaborationConflicts(job, [other]).conflicts).toEqual([])
  const peers = Array.from({ length: 70 }, (_, i) => ({ ...peer, id: `b${i}` }))
  expect(agentCollaborationConflicts(job, peers).conflicts).toHaveLength(64)
  expect(agentCollaborationConflicts(job, peers).omittedConflicts).toBe(6)
})

test('collaboration is advisory, durable, copied and refreshed on resume', async () => {
  const store = storage()
  const options = {
    storage: store,
    concurrency: 4,
    maxChildren: 10,
    async open() {
      return child(true)
    },
  }
  const supervisor = createAgentSupervisor(options)
  const signal = new AbortController().signal
  try {
    const declaration = { root: 'C:/Repo', plannedWrites: ['src'] }
    const a = await supervisor.start(
      'p',
      { task: 'a', profile: 'read', collaboration: declaration },
      signal
    )
    declaration.plannedWrites[0] = 'elsewhere'
    const b = await supervisor.start(
      'p',
      {
        task: 'b',
        profile: 'read',
        collaboration: { root: 'c:/repo', plannedWrites: ['src/a.ts'] },
      },
      signal
    )
    expect(a.collaboration?.plannedWrites).toEqual(['src'])
    expect(b.status).toBe('running')
    expect(b.conflicts?.[0]?.jobId).toBe(a.id)
    const old = await supervisor.start('p', { task: 'old client', profile: 'read' }, signal)
    expect(old.collaboration).toBeUndefined()
    expect(old.conflicts).toBeUndefined()
    await supervisor.cancel('p', b.id)
    const cleared = await supervisor.resume(
      'p',
      b.id,
      { input: 'clear', collaboration: { root: 'c:/repo', plannedWrites: [] } },
      signal
    )
    expect(cleared.conflicts).toEqual([])
    await supervisor.cancel('p', b.id)
    const replaced = await supervisor.resume(
      'p',
      b.id,
      { input: 'replace', collaboration: { root: 'c:/repo', plannedWrites: ['src'] } },
      signal
    )
    expect(replaced.conflicts?.[0]?.jobId).toBe(a.id)
    await supervisor.cancel('p', a.id)
    await supervisor.cancel('p', b.id)
    const resumed = await supervisor.resume('p', b.id, { input: 'retain' }, signal)
    expect(resumed.collaboration?.plannedWrites).toEqual(['src'])
    expect(resumed.conflicts).toEqual([])
    await supervisor.cancel('p', b.id)
    const reopened = createAgentSupervisor(options)
    expect((await reopened.status('p', b.id)).collaboration).toEqual(resumed.collaboration)
    await reopened.close()
  } finally {
    await supervisor.close()
  }
})

test('submit messages preserve durable text and parent origin through ordinary input receipts', async () => {
  for (const origin of [undefined, { kind: 'parent' as const, sessionId: 'parent' }]) {
    const f = runFixture()
    const readInput = f.options.context.readInput.bind(f.options.context)
    f.options.context.readInput = (ref, range) => readInput(ref, { ...range, limit: 3 })
    const service = createActRunService(f.options)
    try {
      for (let run = 0; run < 2; run++) {
        const events = []
        for await (const event of service.submit({
          text: 'same message',
          inputId: `input-${run}`,
          origin,
        }))
          events.push(event)
        const inputs = events.filter((event) => event.type === 'input')
        const applied = events.filter((event) => event.type === 'input-applied')
        expect(inputs).toHaveLength(1)
        expect(applied).toHaveLength(1)
        expect(inputs[0]).toMatchObject({
          text: 'same message',
          source: 'submit',
          inputId: `input-${run}`,
        })
        expect(inputs[0]!.origin).toEqual(origin)
        expect(applied[0]!.ref).toEqual(inputs[0]!.ref)
        const state = await f.store.load('fault')
        const record = state!.records.find((item) => item.ref.id === inputs[0]!.ref.id)!
        expect(await f.store.get('fault', record.objectId)).toBe(inputs[0]!.text)
        const persisted = (await service.events()).map((item) => item.event)
        expect(
          persisted.filter((event) => event.type === 'input' && event.ref.id === inputs[0]!.ref.id)
        ).toHaveLength(1)
      }
    } finally {
      await service.close()
    }
  }
})

test('resume uses ordinary ActInput with trusted parent origin while start stays a single task input', async () => {
  const received: Array<
    string | { text?: string; origin?: { kind: 'parent'; sessionId: string } }
  > = []
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 1,
    maxChildren: 1,
    async open() {
      return {
        ...child(),
        async *submit(input) {
          received.push(input)
          yield { type: 'state' as const, runId: 'child', status: 'completed' as const }
        },
      }
    },
  })
  const signal = new AbortController().signal
  try {
    const job = await supervisor.start('parent', { task: 'initial task', profile: 'read' }, signal)
    await supervisor.wait('parent', job.id, signal)
    await expect(
      supervisor.resume('other', job.id, { input: 'rejected' }, signal)
    ).rejects.toThrow()
    expect(received).toEqual(['initial task'])
    await supervisor.resume('parent', job.id, { input: 'next message' }, signal)
    await supervisor.wait('parent', job.id, signal)
    expect(received).toEqual([
      'initial task',
      { text: 'next message', origin: { kind: 'parent', sessionId: 'parent' } },
    ])
  } finally {
    await supervisor.close()
  }
})

test('parent submit receipt persistence failure never displays or applies a resume message', async () => {
  const f = runFixture()
  const put = f.store.put
  let calls = 0
  f.store.put = async (id, body) => {
    if (body.startsWith('{"type":"input"')) throw Error('parent receipt disk failure')
    return put(id, body)
  }
  f.options.model.stream = async function* () {
    calls++
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  try {
    await expect(
      (async () => {
        for await (const event of service.submit({
          text: 'resume',
          origin: { kind: 'parent', sessionId: 'parent' },
        }))
          events.push(event)
      })()
    ).rejects.toThrow('parent receipt disk failure')
    expect(events.some((event) => event.type === 'input' || event.type === 'input-applied')).toBe(
      false
    )
    expect(calls).toBe(0)
  } finally {
    await service.close()
  }
})

function runFixture() {
  const store = storage()
  const context = createContextRuntime({ storage: store, sessionId: 'fault' })
  const view = createContextView({ storage: store, sessionId: 'fault', context, sources: [] })
  type Frame = Awaited<ReturnType<ActRunServiceOptions['frames']['beginFrame']>>
  const frame: {
    project(maxChars: number): Promise<Awaited<ReturnType<Frame['project']>> & { prompt?: string }>
    delta?: (body: string, previous: string) => string
    reconcile?: Frame['reconcile']
  } = { project: async () => ({ body: '{}', images: [] }) }
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
      async beginFrame() {
        let projected: Awaited<ReturnType<typeof frame.project>>
        return {
          retainFrames: Boolean(frame.delta),
          async project(maxChars) {
            projected = await frame.project(maxChars)
            return projected
          },
          async reconcile(body, history, previous, signal) {
            if (frame.reconcile) return frame.reconcile(body, history, previous, signal)
            return {
              body,
              dynamic: projected.dynamic,
              prompt:
                previous && frame.delta ? frame.delta(body, previous) : (projected.prompt ?? body),
            }
          },
          async publish() {},
        }
      },
      async needsRefresh() {
        return false
      },
      async acknowledge() {},
    },
    execution: { pending: () => false, async wait() {}, async invoke() {}, async stop() {} },
  }
  return { store, context, view, options, frame }
}

for (const phase of ['model', 'refresh'] as const)
  test(`waiting refreshes unseen results completed during ${phase}, without polling or leaking subscriptions`, async () => {
    const f = runFixture()
    let revision = 0
    let calls = 0
    let listeners = 0
    let wake: (() => void) | undefined
    const waitingAgain = Promise.withResolvers<void>()
    f.frame.project = async () => ({ body: JSON.stringify({ revision }), images: [] })
    f.options.frames.needsRefresh = async (request) => {
      const observed = JSON.parse(
        request.materials.find((item) => item.origin === 'runtime-view')!.text
      ).revision
      if (phase === 'refresh' && calls === 1) {
        // 在快照核对已经读到旧值、但核对尚未返回的窗口完成。
        expect(listeners).toBe(1)
        revision++
        wake!()
        return false
      }
      return observed !== revision
    }
    f.options.model.stream = async function* (request) {
      calls++
      const observed = JSON.parse(
        request.materials.find((item) => item.origin === 'runtime-view')!.text
      ).revision
      expect(observed).toBe(calls === 1 ? 0 : 1)
      if (phase === 'model' && calls === 1) revision++
      yield { type: 'text', text: 'Waiting for the remaining service.' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push: () => [],
      finish: () => ({ message: 'waiting', done: false, events: [] }),
    })
    f.options.execution.pending = () => true
    f.options.execution.wait = async (signal) => {
      signal.throwIfAborted()
      listeners++
      let abort!: () => void
      try {
        await new Promise<void>((resolve, reject) => {
          wake = resolve
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (calls === 2) waitingAgain.resolve()
        })
      } finally {
        signal.removeEventListener('abort', abort)
        listeners--
      }
    }
    const service = createActRunService(f.options)
    const events: Array<{ type: string; status?: string }> = []
    const running = (async () => {
      for await (const event of service.submit('work')) events.push(event)
    })()
    try {
      await Promise.race([
        waitingAgain.promise,
        running.then(() => {
          throw new Error('run ended before the unseen result was delivered')
        }),
      ])
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(calls).toBe(2)
      expect(listeners).toBe(1)
    } finally {
      service.cancel()
      await running
      await service.close()
    }
    expect(listeners).toBe(0)
    expect(events.at(-1)?.status).toBe('cancelled')
  })

test('a text-only waiting response refreshes a completed result even when no execution remains', async () => {
  const f = runFixture()
  let revision = 0
  let calls = 0
  f.frame.project = async () => ({ body: JSON.stringify({ revision }), images: [] })
  f.options.frames.needsRefresh = async (request) =>
    JSON.parse(request.materials.find((item) => item.origin === 'runtime-view')!.text).revision !==
    revision
  f.options.model.stream = async function* (request) {
    calls++
    expect(
      JSON.parse(request.materials.find((item) => item.origin === 'runtime-view')!.text).revision
    ).toBe(calls - 1)
    revision = 1
    yield { type: 'text', text: 'waiting' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.protocol.open = () => ({
    instructions: 'fixture',
    reset() {},
    push: () => [],
    finish: () => ({ message: 'waiting', done: false, events: [] }),
  })
  const service = createActRunService(f.options)
  try {
    for await (const _event of service.submit('work')) {
      /* exhaust the run */
    }
    expect(calls).toBe(2)
    expect((await service.inspect()).status).toBe('waiting')
  } finally {
    await service.close()
  }
})

test.each([false, true])(
  'refreshing an obsolete frame preserves wait failures, during cleanup=%s',
  async (duringCleanup) => {
    const f = runFixture()
    const failure = new AppError('INVARIANT', 'execution persistence failed')
    f.options.execution.pending = () => true
    f.options.execution.wait = async (signal) => {
      if (duringCleanup)
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(failure), { once: true })
        )
      else throw failure
    }
    f.options.frames.needsRefresh = async () => {
      await Promise.resolve()
      return true
    }
    const service = createActRunService(f.options)
    const events: Array<{ type: string; status?: string; message?: string }> = []
    try {
      for await (const event of service.submit('work')) events.push(event)
      expect(events.at(-1)?.status).toBe('failed')
      expect(
        events.some((event) => event.type === 'error' && event.message?.includes(failure.message))
      ).toBe(true)
      expect((await f.view.inspect())?.usage.mainCalls).toBe(1)
    } finally {
      await service.close()
    }
  }
)

test('new guidance does not hide a simultaneous execution wait failure', async () => {
  const f = runFixture()
  const failure = new AppError('INVARIANT', 'execution persistence failed during guidance')
  f.options.execution.pending = () => true
  f.options.execution.wait = async (signal) =>
    new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(failure), { once: true })
    )
  const service = createActRunService(f.options)
  const events: Array<{ type: string; status?: string; message?: string }> = []
  try {
    for await (const event of service.submit('work')) {
      events.push(event)
      if (event.type === 'state' && event.status === 'waiting') await service.steer('new direction')
    }
    expect(events.at(-1)?.status).toBe('failed')
    expect(
      events.some((event) => event.type === 'error' && event.message?.includes(failure.message))
    ).toBe(true)
    expect((await f.view.inspect())?.usage.mainCalls).toBe(1)
  } finally {
    await service.close()
  }
})

test('INV-41 a delayed usage receipt settles its original cancelled task without reviving it', async () => {
  const f = runFixture()
  const entered = Promise.withResolvers<void>()
  const usageReady = Promise.withResolvers<void>()
  f.options.model.stream = async function* () {
    entered.resolve()
    await usageReady.promise
    yield { type: 'usage', inputTokens: 25, outputTokens: 5 }
    yield { type: 'text', text: 'must not execute after cancellation' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const cancel = new AbortController()
  const events = []
  const running = (async () => {
    for await (const event of service.submit('work', cancel.signal)) events.push(event)
  })()
  await entered.promise
  cancel.abort()
  await running
  expect((await f.view.inspect())!.usage.unmeasuredCalls).toBe(1)
  usageReady.resolve()
  for (let attempt = 0; attempt < 30 && (await f.view.inspect())!.usage.unmeasuredCalls; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const state = (await f.view.inspect())!
  expect(state.status).toBe('cancelled')
  expect(state.usage.inputTokens).toBe(25)
  expect(state.usage.outputTokens).toBe(5)
  expect(state.usage.budgetTokens).toBe(30)
  expect(state.usage.unmeasuredCalls).toBe(0)
  expect(events.some((event) => event.type === 'accepted')).toBe(false)
  await service.close()
})

test('INV-41 a dispatch-aware driver cannot return unregistered output or usage to the main loop', async () => {
  const f = runFixture()
  f.options.model = { ...f.options.model, dispatchAware: true }
  f.options.model.stream = async function* () {
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 }
    yield { type: 'text', text: 'must not be accepted' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events = []
  for await (const event of service.submit('work')) events.push(event)
  const state = (await f.view.inspect())!
  expect(state.status).toBe('failed')
  expect(state.usage.mainCalls).toBe(0)
  expect(state.usage.inputTokens).toBe(0)
  expect(events.some((event) => event.type === 'accepted')).toBe(false)
  await service.close()
})

test('INV-45 invalid usage is rejected before accounting, including simultaneous cancellation', async () => {
  for (const cancelOnRead of [false, true]) {
    const f = runFixture()
    const cancel = new AbortController()
    let measured = 0
    f.options.model.stream = async function* () {
      if (cancelOnRead) cancel.abort()
      yield { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 11 }
    }
    const request: ModelTurnRequest = {
      instructions: 'fixture',
      materials: [],
      response: { type: 'text' },
      mode: 'work',
      outputTokens: 100,
    }
    const iterator = boundedModelStream(
      f.options.model,
      request,
      cancel.signal,
      undefined,
      async () => {
        measured++
      }
    )[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(measured).toBe(0)
    await iterator.return?.()
  }
})

test('INV-45 cache context preserves unknown fields and clears measurements after a request without cache usage', async () => {
  const f = runFixture()
  const requests: ModelTurnRequest[] = []
  const measurements = [{ cacheReadTokens: 60 }, {}, { cacheWriteTokens: 0 }, undefined, {}]
  f.options.limits = { ...f.options.limits, turns: 6 }
  f.options.model.stream = async function* (request) {
    const usage = measurements[requests.length]
    requests.push(request)
    if (usage) yield { type: 'usage', inputTokens: 100, outputTokens: 1, ...usage }
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
      return requests.length >= measurements.length
        ? { message: 'done', done: true, events: [] }
        : {
            message: 'work',
            done: false,
            submission: { code: `work-${requests.length}` },
            events: [],
          }
    },
  })
  const service = createActRunService(f.options)
  try {
    const events = []
    for await (const event of service.submit('complete the steps')) events.push(event)
    expect(requests.map((request) => request.contextStatus?.cache)).toEqual([
      undefined,
      { readTokens: 60 },
      undefined,
      { writeTokens: 0 },
      undefined,
    ])
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  } finally {
    await service.close()
  }
})

test('INV-49 accepted request prefixes survive sequential submissions only while logical history still matches', async () => {
  const f = runFixture()
  const requests: ModelTurnRequest[] = []
  let logical: ModelHistoryMessage[] = [{ role: 'user', content: 'original task' }]
  const observations = ['A', 'A', 'B', 'A']
  let revision = 0
  f.frame.delta = (body) => `current state ${body}`
  f.frame.project = async () => ({
    body: JSON.stringify({ revision }),
    dynamic: {
      id: `observation-${revision}`,
      text: `current-perception-${observations[revision]}`,
    },
    history: structuredClone(logical),
    images: [],
  })
  f.options.model.stream = async function* (request) {
    requests.push(request)
    yield { type: 'text', text: `answer-${revision}` }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.protocol.open = () => ({
    instructions: `current-protocol-${revision}`,
    reset() {},
    push() {
      return []
    },
    finish: () => ({ message: 'done', done: true, events: [] }),
  })
  const service = createActRunService(f.options)
  const withoutMarks = (messages: readonly ModelHistoryMessage[]) =>
    messages.map(({ cacheBreakpoint: _mark, ...message }) => message)
  try {
    for (const prompt of ['first', 'follow-up', 'changed observation', 'corrected history']) {
      const events = []
      for await (const event of service.submit(prompt)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      revision++
      logical =
        revision < 3
          ? [
              ...logical,
              { role: 'assistant', content: `answer-${revision - 1}` },
              { role: 'user', content: `input-${revision}` },
            ]
          : [{ role: 'user', content: 'revised task after compaction' }]
    }
    for (const index of [1, 2]) {
      const previous = modelRequestEncoder.layout(requests[index - 1]!)
      const followup = modelRequestEncoder.layout(requests[index]!)
      expect(withoutMarks(followup.messages.slice(0, previous.retainablePrefixLength))).toEqual(
        withoutMarks(previous.messages.slice(0, previous.retainablePrefixLength))
      )
    }
    for (const [index, request] of requests.entries()) {
      expect(request.dynamic?.text).toBe(`current-perception-${observations[index]}`)
      expect(request.protocol).toContain(`current-protocol-${index}`)
      expect(JSON.stringify(request.history)).not.toContain('current-perception-')
      expect(JSON.stringify(request.history)).not.toContain('current-protocol-')
      const layout = modelRequestEncoder.layout(request)
      const prefix = JSON.stringify(layout.messages.slice(0, layout.retainablePrefixLength))
      expect(prefix).not.toContain('current-perception-')
      expect(prefix).not.toContain('current-protocol-')
      const tail = JSON.stringify(layout.messages.slice(layout.retainablePrefixLength))
      expect(tail).toContain(request.dynamic!.text)
      expect(tail).toContain(`current-protocol-${index}`)
    }
    expect(requests[1]!.compiledPrompt).toContain('revision')
    expect(requests[3]!.history).toEqual([
      { role: 'user', content: 'revised task after compaction' },
    ])
    expect(new Set(requests.map((request) => request.cacheKey)).size).toBe(1)
  } finally {
    await service.close()
  }
})

test('INV-40 accepted provider usage drives growth while calibrated admission remains independent', async () => {
  const f = runFixture()
  const requests: ModelTurnRequest[] = []
  f.frame.project = async () => ({
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
    f.frame.project = async () => ({
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
  f.frame.project = async (maxChars) => {
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

test.each(['ready', 'not-ready', 'execution-failed', 'completion-blocked', 'pending'] as const)(
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
      return mode === 'completion-blocked'
        ? { completed: false, reason: 'NEEDS_INPUT', recovery: 'input' }
        : { completed: true, reason: 'COMPLETED' }
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
      expect(calls).toBe(mode === 'ready' || mode === 'completion-blocked' ? 1 : 2)
      expect(readyChecks).toBe(mode === 'execution-failed' ? 0 : 1)
      expect(checks).toBe(1)
      expect(events.at(-1)).toMatchObject({
        type: 'state',
        status: mode === 'completion-blocked' ? 'waiting' : 'completed',
      })
      const records = (await f.store.load('fault'))!.records
      expect(records.filter((record) => record.title === 'model-tool-exchange')).toHaveLength(1)
      const exchange = records.find((record) => record.title === 'model-tool-exchange')!
      expect(JSON.parse((await f.store.get('fault', exchange.objectId))!).delivery).toBe('history')
      expect(records.filter((record) => record.title === 'execution-completion')).toHaveLength(
        mode === 'execution-failed' || mode === 'not-ready' ? 0 : 1
      )
    } finally {
      await service.close()
    }
  }
)

test('dynamic native exchanges stage the original persisted receipt and remain outside retained prefixes', async () => {
  const f = runFixture()
  const requests: ModelTurnRequest[] = []
  const staged: string[] = []
  const receipt = { status: 'registered', sourceRef: 'original-observation-source' }
  let pending: ModelTurnRequest['dynamic']
  let calls = 0
  let consumed = 0
  let readyChecks = 0
  f.frame.delta = (body) => body
  f.frame.project = async () => ({ body: '{}', images: [], dynamic: pending })
  f.options.frames.deliveryReady = () => {
    readyChecks++
    return true
  }
  f.options.frames.stageDynamicExchange = async (ref) => {
    const record = (await f.store.load('fault'))!.records.find((item) => item.ref.id === ref.id)!
    const stored = JSON.parse((await f.store.get('fault', record.objectId))!)
    expect(stored.delivery).toBe('dynamic')
    expect(stored.results).toEqual([
      { id: 'read-state', name: 'fixture-observer', output: receipt },
    ])
    staged.push(ref.id)
    pending = {
      id: ref.id,
      text: 'CURRENT_ONLY observation',
      exchanges: [{ exchange: modelRequestEncoder.toolExchange(stored) }],
    }
  }
  f.options.frames.acknowledge = async (request) => {
    if (pending && request.dynamic?.id === pending.id) {
      consumed++
      pending = undefined
    }
  }
  f.options.protocol.open = () => ({
    instructions: 'native fixture',
    response: {
      type: 'tools',
      tools: [{ name: 'fixture-observer', description: 'fixture', schema: { type: 'object' } }],
    },
    reset() {},
    push() {
      return []
    },
    acceptTool() {
      return []
    },
    finish() {
      if (calls === 2) throw new AppError('SCRIPT_PROTOCOL', 'retry the same pending observation')
      return calls === 1
        ? { message: '', done: true, submission: {}, events: [] }
        : { message: 'done', done: true, events: [] }
    },
  })
  f.options.model.stream = async function* (request) {
    requests.push(request)
    calls++
    if (calls === 1)
      yield { type: 'tool-call', value: { id: 'read-state', name: 'fixture-observer', input: {} } }
    else yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.execution.invoke = async () => ({
    succeeded: true,
    delivery: 'dynamic',
    results: [{ id: 'read-state', name: 'fixture-observer', output: receipt }],
  })
  const service = createActRunService(f.options)
  try {
    for (const input of ['observe once', 'continue without another observation']) {
      const events = []
      for await (const event of service.submit(input)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
    }
    expect(requests).toHaveLength(4)
    expect(staged).toHaveLength(1)
    expect(consumed).toBe(1)
    expect(readyChecks).toBe(0)
    expect(requests[0]!.dynamic).toBeUndefined()
    expect(requests[1]!.dynamic?.id).toBe(staged[0])
    expect(requests[2]!.dynamic).toEqual(requests[1]!.dynamic)
    expect(requests[3]!.dynamic).toBeUndefined()
    expect(requestChars(requests[1]!)).toBeGreaterThan(
      requestChars({
        ...requests[1]!,
        dynamic: { ...requests[1]!.dynamic!, exchanges: [] },
      })
    )
    for (const request of requests) {
      const layout = modelRequestEncoder.layout(request)
      const stable = JSON.stringify(layout.messages.slice(0, layout.retainablePrefixLength))
      expect(stable).not.toContain('fixture-observer')
      expect(stable).not.toContain('original-observation-source')
      expect(stable).not.toContain('CURRENT_ONLY')
      if (request.dynamic) {
        const tail = JSON.stringify(layout.messages.slice(layout.retainablePrefixLength))
        expect(tail).toContain('original-observation-source')
        expect(tail).toContain('CURRENT_ONLY')
      }
    }
    const records = (await f.store.load('fault'))!.records
    expect(records.filter((record) => record.title === 'model-tool-exchange')).toHaveLength(1)
  } finally {
    await service.close()
  }
})

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
    f.frame.project = async (maxChars) => ({
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

test('INV-53 a fitting current projection preserves the history before overflow folding', async () => {
  const f = runFixture()
  const original = 'Original evidence remains in chronological history. '.repeat(80)
  const history: ModelHistoryMessage[] = [{ role: 'user', content: original }]
  const sent: ModelTurnRequest[] = []
  let folds = 0
  let acknowledged = 0
  f.options.frames.policy = { windowTokens: 3000 }
  f.frame.project = async (maxChars) => ({
    body: JSON.stringify({ required: 'Keep original evidence', optional: 'x'.repeat(maxChars) }),
    history,
    images: [],
    segment: { id: 'original', index: 1, revision: 0, volumes: 0, turns: 4 },
  })
  f.options.frames.fold = async () => {
    folds++
    return false
  }
  f.options.frames.acknowledge = async () => {
    acknowledged++
  }
  f.options.model.estimate = async (request) => ({
    tokens: Math.ceil(
      (original.length + JSON.parse(request.materials[0]!.text).optional.length) / 4
    ),
    precision: 'exact',
    basis: 'Fixed required history and separately adjustable current evidence',
  })
  f.options.model.stream = async function* (request) {
    sent.push(request)
    yield { type: 'text', text: 'complete' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  try {
    const events = []
    for await (const event of service.submit('Use original evidence')) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
    expect(folds).toBe(0)
    expect(sent).toHaveLength(1)
    expect(acknowledged).toBe(1)
    expect(sent[0]!.history).toEqual(history)
    expect(sent[0]!.contextStatus!.inputTokens).toBeLessThanOrEqual(3000)
    const projected = JSON.parse(sent[0]!.materials[0]!.text)
    expect(projected.required).toBe('Keep original evidence')
    expect(projected.optional.length).toBeGreaterThan(1000)
    expect(projected.optional.length).toBeLessThan(10000)
  } finally {
    await service.close()
  }
})

test.each([
  'linear',
  'stepped',
  'mandatory-overflow',
  'status-overflow',
  'status-floor-overflow',
  'cancel',
] as const)(
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
    f.frame.project = async (maxChars) => {
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
            : (mode === 'status-floor-overflow' ? 2500 : 400) +
              Math.ceil(chars / 3) +
              (mode === 'stepped' && chars > 5000 ? 3000 : 0) +
              (mode === 'status-overflow' && request.contextStatus ? 1400 : 0) +
              (mode === 'status-floor-overflow' && request.contextStatus ? 250 : 0),
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
        if (mode === 'status-floor-overflow') expect(payload.evidence.length).toBeLessThan(1000)
        else if (mode !== 'status-overflow') expect(payload.evidence.length).toBeGreaterThan(4000)
        expect(finalizing).toBe(false)
        expect(maintained).toBe(0)
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      }
    } finally {
      await service.close()
    }
  }
)

test.each(['default', 0, 0.125, 1] as const)(
  'INV-48 retained frame budget bounds repeated state while preserving logical facts: %s',
  async (configuredRatio) => {
    const ratio = configuredRatio === 'default' ? 1 : configuredRatio
    const f = runFixture()
    const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'original task' }]
    const evidence = 'source evidence '.repeat(40)
    const requests: ModelTurnRequest[] = []
    let turn = 0
    let acknowledged = 0
    f.options.limits = { ...f.options.limits, turns: 10 }
    f.options.model = {
      ...f.options.model,
      limits: { contextTokens: 20000, inputTokens: 18000, outputTokens: 100 },
    }
    Object.assign(f.frame, {
      async project() {
        return { body: JSON.stringify({ evidence, turn }), images: [], history: [...logical] }
      },

      delta: (body) => body,

      async reconcile(body, history, previous) {
        const covered =
          previous && history.some((entry) => JSON.stringify(entry).includes(evidence))
        return { body, prompt: `${covered ? 'delta' : 'full'} ${body}` }
      },
    })
    f.options.frames = {
      ...f.options.frames,

      policy: configuredRatio === 'default' ? undefined : { retainedFrameRatio: configuredRatio },

      async acknowledge() {
        acknowledged++
      },
    }

    f.options.model.estimate = async (request) => ({
      tokens:
        100 +
        modelRequestEncoder
          .messages(request)
          .reduce((sum, message) => sum + JSON.stringify(message.content).length, 0),
      precision: 'exact',
      basis: 'deterministic textual cost including current protocol',
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
      finish: () =>
        turn >= 6
          ? { message: 'done', done: true, events: [] }
          : { message: 'work', done: false, submission: {}, events: [] },
    })
    f.options.execution.invoke = async () => {
      logical.push({ role: 'assistant', content: `accepted ${turn}` })
      logical.push({ role: 'user', content: `result ${turn++}` })
    }
    const service = createActRunService(f.options)
    try {
      const events = []
      for await (const event of service.submit('work')) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      expect(requests).toHaveLength(7)
      expect(acknowledged).toBe(7)
      let retained = 0
      let rebuilt = 0
      for (const [index, request] of requests.entries()) {
        const priorFrames = (request.history ?? []).filter(
          (message) =>
            typeof message.content === 'string' && /^(full|delta) /u.test(message.content)
        )
        const marginal =
          (await f.options.model.estimate(request)).tokens -
          (
            await f.options.model.estimate({
              ...request,
              history: request.history?.filter((message) => !priorFrames.includes(message)),
            })
          ).tokens
        expect(marginal).toBeLessThanOrEqual(18000 * ratio)
        expect(
          request.history
            ?.filter((message) => !priorFrames.includes(message))
            .map(({ cacheBreakpoint: _mark, ...message }) => message)
        ).toEqual(logical.slice(0, 1 + index * 2))
        if (priorFrames.length) {
          retained++
          const layout = modelRequestEncoder.layout(requests[index - 1]!)
          const previous = layout.messages.slice(0, layout.retainablePrefixLength)
          expect(
            modelRequestEncoder
              .messages(request)
              .slice(0, previous.length)
              .map(({ role, content }) => ({ role, content }))
          ).toEqual(previous.map(({ role, content }) => ({ role, content })))
        } else if (index) rebuilt++
        expect(request.compiledPrompt).toContain(evidence)
        expect(request.compiledPrompt).toContain(priorFrames.length ? 'delta' : 'full')
      }
      if (ratio === 0) expect(rebuilt).toBe(6)
      else if (ratio === 1) expect(retained).toBe(6)
      else {
        expect(retained).toBeGreaterThan(0)
        expect(rebuilt).toBeGreaterThan(0)
        const state = await f.store.load('fault')
        const audits = await Promise.all(
          state!.records
            .filter((record) => record.title === 'model-request')
            .map(async (record) => JSON.parse((await f.store.get('fault', record.objectId))!))
        )
        expect(audits).toHaveLength(7)
        expect(
          audits.some(({ retention }) => retention.rebuiltFromTokens > retention.limitTokens)
        ).toBe(true)
        expect(
          audits.every(({ retention }) => retention.historyTokens <= retention.limitTokens)
        ).toBe(true)
      }
    } finally {
      await service.close()
    }
  }
)

test.each(['effective', 'weak', 'repeated', 'unavailable', 'failed', 'noop', 'cancel'] as const)(
  'INV-48 cache-first capacity recovery measures benefit and escalates across submits: %s',
  async (mode) => {
    const f = runFixture()
    const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'original task' }]
    const requests: ModelTurnRequest[] = []
    const controller = new AbortController()
    let turn = 0
    let organized = false
    let pressure = 0
    let acknowledged = 0
    const cost = mode === 'weak' || mode === 'cancel' ? 2500 : 2000
    f.options.model.limits = { contextTokens: 12000, inputTokens: 10000, outputTokens: 100 }
    Object.assign(f.frame, {
      project: async () => ({
        body: JSON.stringify({ evidence: 'exact protected source', turn, organized }),
        images: [],
        history: [...logical],
        segment: { id: 'same-work-set', index: 1, revision: 1, turns: turn + 1, faults: 0 },
      }),

      delta: (body) => body,

      reconcile: async (body, _history, previous) => ({
        body,
        prompt: `${previous ? 'delta' : 'full'} ${body}`,
      }),
    })
    f.options.frames = {
      ...f.options.frames,

      policy: { windowTokens: 10000 },

      acknowledge: async () => {
        acknowledged++
      },
    }

    f.options.model.estimate = async (request) => {
      const states = (request.history ?? []).filter(
        (m) => typeof m.content === 'string' && /^(full|delta) /u.test(m.content)
      ).length
      if (mode === 'cancel' && turn === 4 && states === 0) controller.abort()
      const base = organized ? 500 : turn >= 6 && mode !== 'effective' ? 4500 : 1000
      return {
        tokens: base + states * cost,
        precision: 'exact',
        basis: 'deterministic retained-layout growth',
      }
    }
    if (mode !== 'unavailable')
      f.options.frames.maintain = async ({ reason }) => {
        if (reason !== 'pressure') return false
        pressure++
        if (mode === 'failed') throw Error('maintenance unavailable')
        if (mode === 'noop') return true
        organized = true
        logical.splice(0, logical.length, {
          role: 'user',
          content: 'original task; preserved summary and original result refs',
        })
        return true
      }
    f.options.model.stream = async function* (request) {
      requests.push(request)
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    const service = createActRunService(f.options)
    try {
      const count = mode === 'weak' || mode === 'cancel' ? 5 : mode === 'effective' ? 9 : 12
      for (; turn < count; turn++) {
        const events = []
        for await (const event of service.submit('continue', controller.signal)) events.push(event)
        if (mode === 'cancel' && turn === 4) {
          expect(events.at(-1)).toMatchObject({ type: 'state', status: 'cancelled' })
          break
        }
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
        logical.push({ role: 'assistant', content: `accepted ${turn}` })
        logical.push({ role: 'user', content: `result ${turn}` })
      }
      expect(acknowledged).toBe(requests.length)
      expect(requests.every((r) => r.compiledPrompt?.includes('exact protected source'))).toBe(true)
      expect(pressure).toBe(['effective', 'unavailable', 'cancel'].includes(mode) ? 0 : 1)
      if (mode === 'cancel') expect(requests).toHaveLength(4)
      const snapshot = await f.store.load('fault')
      const audits = await Promise.all(
        snapshot!.records
          .filter((r) => r.title === 'model-request')
          .map(async (r) => JSON.parse((await f.store.get('fault', r.objectId))!))
      )
      const rebuilds = audits.filter((a) => a.retention.rebuild)
      if (mode === 'effective') {
        expect(rebuilds).toHaveLength(1)
        expect(rebuilds[0].retention.rebuild).toMatchObject({
          beforeTokens: 11000,
          afterTokens: 1000,
          repeated: false,
        })
        expect(rebuilds[0].retention.rebuild.runwayTurns).toBeGreaterThanOrEqual(4)
      }
      if (mode === 'repeated') expect(organized).toBe(true)
      if (['unavailable', 'failed', 'noop'].includes(mode)) {
        expect(rebuilds.some((a) => a.retention.rebuild.repeated)).toBe(true)
        expect(requests).toHaveLength(count)
      }
    } finally {
      await service.close()
    }
  }
)

test('INV-48 visual turns preserve an accepted text prefix without accumulating screenshots', async () => {
  const f = runFixture()
  const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'original task' }]
  const requests: ModelTurnRequest[] = []
  let turn = 0
  Object.assign(f.frame, {
    project: async () => ({
      body: JSON.stringify({ turn, stable: 'persistent text evidence' }),
      images: turn
        ? [
            {
              type: 'image-data' as const,
              mediaType: 'image/png',
              data: 'aGVsbG8=',
              origin: 'capability' as const,
              label: `screenshot ${turn}`,
            },
          ]
        : [],
      history: [...logical],
    }),

    delta: (body) => body,
  })
  f.options.frames = {
    ...f.options.frames,
  }

  f.options.model.stream = async function* (request) {
    requests.push(request)
    yield { type: 'text', text: 'accepted' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.protocol.open = () => ({
    instructions: 'fixture',
    reset() {},
    push: () => [],
    finish: () =>
      turn >= 3
        ? { message: 'done', done: true, events: [] }
        : { message: 'work', done: false, submission: {}, events: [] },
  })
  f.options.execution.invoke = async () => {
    logical.push({ role: 'assistant', content: `accepted ${turn}` })
    logical.push({ role: 'user', content: `result ${turn++}` })
  }
  const service = createActRunService(f.options)
  try {
    const events = []
    for await (const event of service.submit('work')) events.push(event)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
    expect(requests).toHaveLength(4)
    const prefix = modelRequestEncoder
      .messages(requests[0]!)
      .map(({ role, content }) => ({ role, content }))
    for (const request of requests.slice(1)) {
      const messages = modelRequestEncoder.messages(request)
      expect(
        messages.slice(0, prefix.length).map(({ role, content }) => ({ role, content }))
      ).toEqual(prefix)
      expect(
        messages
          .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
          .filter((part) => part.type === 'image')
      ).toHaveLength(1)
    }
  } finally {
    await service.close()
  }
})

test.each(
  [false, true].flatMap((textBaseline) =>
    ['expire', 'rewrite', 'budget'].map((reason) => ({ textBaseline, reason }))
  )
)(
  'INV-48 live image prefixes respect projection, history and budget: %j',
  async ({ textBaseline, reason }) => {
    const f = runFixture()
    f.options.limits = { ...f.options.limits, turns: 8 }
    const logical: ModelHistoryMessage[] = [{ role: 'user', content: 'original task' }]
    const requests: ModelTurnRequest[] = []
    const screenshot = (label: string) => ({
      type: 'image-data' as const,
      mediaType: 'image/png',
      data: 'aGVsbG8=',
      origin: 'capability' as const,
      label,
    })
    const a = screenshot('A')
    const b = screenshot('B')
    const remaining = reason === 'expire' ? [b] : [a, b]
    const frames = [textBaseline ? [] : [a], [a], [a, b], [a, b], remaining, remaining, []]
    let turn = 0
    if (reason === 'budget')
      f.options.model.estimate = async (request) => ({
        tokens:
          turn === 4 &&
          request.history?.some(
            (message) =>
              typeof message.content !== 'string' &&
              message.content.some((part) => part.type === 'image')
          )
            ? 10_000
            : 1,
        precision: 'exact',
        basis: 'fixture',
      })
    Object.assign(f.frame, {
      project: async () => ({
        body: JSON.stringify({ turn }),
        images: structuredClone(frames[turn]!),
        history: [...logical],
      }),

      delta: (body, previous) => `delta ${JSON.parse(previous).turn} -> ${JSON.parse(body).turn}`,
    })
    f.options.frames = {
      ...f.options.frames,
    }

    f.options.model.stream = async function* (request) {
      requests.push(request)
      yield { type: 'text', text: 'accepted' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push: () => [],
      finish: () => ({
        message: 'work',
        done: turn === frames.length - 1,
        submission: {},
        events: [],
      }),
    })
    f.options.execution.invoke = async () => {
      logical.push({ role: 'assistant', content: `accepted ${turn}` })
      logical.push({ role: 'user', content: `result ${turn++}` })
      if (reason === 'rewrite' && turn === 4) logical[0] = { role: 'user', content: 'revised task' }
    }
    const service = createActRunService(f.options)
    const unmark = (request: ModelTurnRequest) =>
      modelRequestEncoder.messages(request).map(({ cacheBreakpoint: _mark, ...message }) => message)
    try {
      const events = []
      for await (const event of service.submit('work')) events.push(event)
      expect(events.filter((event) => event.type === 'error')).toEqual([])
      expect(requests).toHaveLength(frames.length)
      for (const [index, request] of requests.entries()) {
        const messages = unmark(request)
        const imageParts = messages
          .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
          .filter((part) => part.type === 'image')
        expect(imageParts).toHaveLength(frames[index]!.length)
        const labels = messages
          .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
          .filter(
            (part) => part.type === 'text' && part.text.startsWith('{"origin":"capability-image"')
          )
          .map((part) => (part.type === 'text' ? JSON.parse(part.text).label : ''))
        expect(labels).toEqual(frames[index]!.map((image) => image.label))
        if ([1, 2, 3, 5].includes(index)) {
          const previous = unmark(requests[index - 1]!)
          expect(messages.slice(0, previous.length)).toEqual(previous)
          expect(JSON.stringify(messages.at(-1)!.content)).toContain(
            `delta ${index - 1} -> ${index}`
          )
        }
        if ([4, 6].includes(index)) {
          const previous = unmark(requests[index - 1]!)
          expect(messages.slice(0, previous.length)).not.toEqual(previous)
        }
      }
      expect(requests[3]!.images).toHaveLength(0)
      expect(requests[5]!.images).toHaveLength(0)
    } finally {
      await service.close()
    }
  }
)

test('INV-48 image reuse requires the complete attachment identity and multiplicity', () => {
  const a = {
    type: 'image-data' as const,
    data: 'aGVsbG8=',
    mediaType: 'image/png',
    origin: 'capability' as const,
    label: 'A',
  }
  expect(remainingFrameImages([a, a], [a])).toEqual([a])
  expect(remainingFrameImages([a], [a, a])).toBeUndefined()
  expect(remainingFrameImages([], [a])).toBeUndefined()
  for (const change of [
    { data: 'd29ybGQ=' },
    { mediaType: 'image/jpeg' },
    { origin: 'user' as const },
    { label: 'B' },
  ])
    expect(remainingFrameImages([{ ...a, ...change }], [a])).toBeUndefined()
  expect(remainingFrameImages([a], [])).toEqual([a])
})

test('INV-48 cancellation during local frame accounting cannot dispatch or acknowledge another request', async () => {
  const f = runFixture()
  const cancel = new AbortController()
  let calls = 0
  let acknowledgements = 0
  let executed = 0
  Object.assign(f.frame, {
    project: async () => ({ body: '{}', images: [], history: [] }),

    delta: () => 'delta',
  })
  f.options.frames = {
    ...f.options.frames,

    acknowledge: async () => {
      acknowledgements++
    },
  }

  f.options.model.estimate = async (request) => {
    if (executed && !request.history?.length) {
      cancel.abort()
      return new Promise(() => {})
    }
    return { tokens: 100, precision: 'exact', basis: 'fixture' }
  }
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
    finish: () => ({ message: 'work', done: false, submission: {}, events: [] }),
  })
  f.options.execution.invoke = async () => {
    executed++
  }
  const service = createActRunService(f.options)
  try {
    const events = []
    for await (const event of service.submit('work', cancel.signal)) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'cancelled' })
    expect(calls).toBe(1)
    expect(acknowledgements).toBe(1)
    expect(executed).toBe(1)
  } finally {
    await service.close()
  }
})

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
  Object.assign(f.frame, {
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
  })
  f.options.frames = {
    ...f.options.frames,
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
    Object.assign(f.frame, {
      async project() {
        return {
          body: JSON.stringify({ turn }),
          dynamic: { id: 'unreconciled', text: 'discarded projection' },
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
        return {
          body: resolved,
          prompt: `actual ${resolved}`,
          dynamic: { id: `observation-${turn}`, text: `current-perception-${turn}` },
        }
      },
    })
    f.options.frames = {
      ...f.options.frames,

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
      expect(last.dynamic).toEqual({ id: 'observation-1', text: 'current-perception-1' })
      expect(JSON.stringify(last.history)).not.toContain('current-perception-')
      expect(JSON.stringify(last.history)).not.toContain('synthetic protocol rejection')
      if (repair) {
        expect(requests[1]!.compiledPrompt).toBe(requests[0]!.compiledPrompt)
        expect(requests[1]!.dynamic).toEqual(requests[0]!.dynamic)
        expect(requests[1]!.protocol).toContain('synthetic protocol rejection')
      }
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

test('INV-42 fitting requests expose repeated material gaps to the main model without allocating paid maintenance', async () => {
  const f = runFixture()
  const reasons: string[] = []
  const overloads: Array<string | undefined> = []
  f.frame.project = async () => ({
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
  expect(overloads.at(-1)).toContain('按需读取大段原文')
  expect(overloads.at(-1)).not.toContain('observe')
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
      requestId: expect.any(String),
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
    requestId: expect.any(String),
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

test('interaction views preserve pending identity while retaining opaque detail', async () => {
  const f = runFixture()
  const finish = Promise.withResolvers<void>()
  const preview = Promise.withResolvers<void>()
  const interacting = Promise.withResolvers<{ id: string; runId: string }>()
  const open = f.options.protocol.open
  f.options.protocol.open = () => ({
    ...open(),
    push: (text) => [{ type: 'text', text }],
  })
  f.options.model.stream = async function* () {
    yield { type: 'text', text: 'preview' }
    await finish.promise
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const running = (async () => {
    for await (const event of service.submit('interaction')) {
      if (event.type === 'text') preview.resolve()
      if (event.type === 'interaction') {
        interacting.resolve({ id: event.request.id, runId: event.request.runId })
        Object.assign(event.request, { id: 'event-mutation', runId: 'foreign-run' })
      }
    }
  })()
  let answer: Promise<unknown> | undefined
  try {
    await preview.promise
    const detail = { render: () => 'opaque host value' }
    answer = service.request(
      'input',
      'Confirm the current run',
      new AbortController().signal,
      detail
    )
    void answer.catch(() => {})
    const identity = await interacting.promise
    const state = await service.inspect()
    expect(state.pending[0]).toMatchObject(identity)
    expect(state.pending[0]!.detail).toBe(detail)
    Object.assign(state.pending[0]!, { id: 'snapshot-mutation', runId: 'foreign-run' })
    await service.answer({ ...identity, value: 'accepted' })
    expect(await answer).toBe('accepted')
    expect((await service.inspect()).pending).toEqual([])
    expect(
      (await service.events()).find((item) => item.event.type === 'interaction')?.event
    ).toMatchObject({
      type: 'interaction',
      request: identity,
    })
  } finally {
    service.cancel()
    finish.resolve()
    await Promise.allSettled([running, answer])
    await service.close()
  }
})

test('interaction allocation cannot outlive its cancelled run or attach to the next run', async () => {
  const f = runFixture()
  const finish = Promise.withResolvers<void>()
  const allocation = Promise.withResolvers<string>()
  const allocating = Promise.withResolvers<void>()
  const allocate = f.store.allocateReferenceId.bind(f.store)
  const delayedId = await allocate('fault')
  const open = f.options.protocol.open
  f.options.protocol.open = () => ({
    ...open(),
    push: (text) => [{ type: 'text', text }],
  })
  f.options.model.stream = async function* () {
    yield { type: 'text', text: 'preview' }
    await finish.promise
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  const events: Array<{ type: string; runId: string }> = []
  const consume = async (
    input: string,
    started: ReturnType<typeof Promise.withResolvers<string>>
  ) => {
    for await (const event of service.submit(input)) {
      events.push(event)
      if (event.type === 'text') started.resolve(event.runId)
    }
  }
  let running: Promise<void> | undefined
  try {
    const first = Promise.withResolvers<string>()
    running = consume('first run', first)
    const firstRunId = await first.promise
    let delayNext = true
    f.store.allocateReferenceId = (sessionId) => {
      if (delayNext) {
        delayNext = false
        allocating.resolve()
        return allocation.promise
      }
      return allocate(sessionId)
    }
    const rejected = service.request('input', 'old question', new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error
    )
    await allocating.promise
    service.cancel()
    await running

    const second = Promise.withResolvers<string>()
    running = consume('second run', second)
    expect(await second.promise).not.toBe(firstRunId)
    allocation.resolve(delayedId)
    finish.resolve()
    await running
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    expect(events.some((event) => event.type === 'interaction')).toBe(false)
    expect((await service.inspect()).pending).toEqual([])
  } finally {
    allocation.resolve(delayedId)
    finish.resolve()
    service.cancel()
    await running
    await service.close()
  }
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

test.each(['cancel', 'cancelParent', 'close'] as const)(
  'supervisor cancellation drains the real child and preserves original cleanup failures (%s)',
  async (mode) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const cancelFailure = new AppError('UNAVAILABLE', 'cancel transport failed')
    const finalFailure = new AppError('UNAVAILABLE', `${mode} finalization failed`)
    let childClosed = false
    const supervisor = createAgentSupervisor({
      storage: storage(),
      concurrency: 1,
      maxChildren: 1,
      ...(mode === 'cancelParent'
        ? {
            deliver: async () => {
              throw finalFailure
            },
          }
        : {}),
      async open() {
        return {
          ...child(),
          async *submit(_input, signal) {
            entered.resolve()
            yield { type: 'state', runId: 'cancel-fault', status: 'thinking' }
            await release.promise
            yield {
              type: 'state',
              runId: 'cancel-fault',
              status: signal?.aborted ? 'cancelled' : 'completed',
            }
          },
          cancel() {
            cancelled.resolve()
            throw cancelFailure
          },
          async close() {
            childClosed = true
            if (mode === 'close') throw finalFailure
          },
        }
      },
    })
    try {
      const job = await supervisor.start(
        'p',
        { task: 'keep the child owner until actual settlement', profile: 'read' },
        new AbortController().signal
      )
      await entered.promise
      const stopping =
        mode === 'cancel'
          ? supervisor.cancel('p', job.id)
          : mode === 'cancelParent'
            ? supervisor.cancelParent('p')
            : supervisor.close()
      let settled = false
      const outcome = stopping.then(
        () => {
          settled = true
          return { error: undefined as unknown }
        },
        (error: unknown) => {
          settled = true
          return { error }
        }
      )
      await cancelled.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(childClosed).toBe(false)
      expect(supervisor.pending('p')).toBe(true)
      release.resolve()
      const { error } = await outcome
      expect(childClosed).toBe(true)
      if (mode === 'cancel') {
        expect(error).toBe(cancelFailure)
        await expect(supervisor.wait('p', job.id, new AbortController().signal)).rejects.toBe(
          cancelFailure
        )
      } else {
        expect(error).toMatchObject({ code: 'UNAVAILABLE' })
        const errors = (error as { errors: readonly unknown[] }).errors
        expect(errors).toHaveLength(2)
        expect(errors[0]).toBe(cancelFailure)
        expect(errors[1]).toBe(finalFailure)
      }
    } finally {
      release.resolve()
      await Promise.allSettled([supervisor.close()])
    }
  }
)

test('supervisor cancellation waits for parent admissions and permits a later explicit start', async () => {
  const store = storage()
  const put = store.put
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let first = true
  store.put = async (id, body) => {
    if (first) {
      first = false
      entered.resolve()
      await release.promise
    }
    return put(id, body)
  }
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 2,
    async open() {
      return child(true)
    },
  })
  const signal = new AbortController().signal
  const starting = supervisor.start(
    'p',
    { task: 'accepted before parent cancellation', profile: 'read' },
    signal
  )
  try {
    await entered.promise
    let settled = false
    const cancelled = supervisor.cancelParent('p').then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release.resolve()
    const job = await starting
    await cancelled
    expect(supervisor.pending('p')).toBe(false)
    expect((await supervisor.status('p', job.id)).status).toBe('cancelled')
    const next = await supervisor.start(
      'p',
      { task: 'new explicit dispatch', profile: 'read' },
      signal
    )
    expect((await supervisor.cancel('p', next.id)).status).toBe('cancelled')
  } finally {
    release.resolve()
    await starting
    await supervisor.close()
  }
})

test('INV-37 steering preserves the current response while slow input persistence queues the next turn', async () => {
  const f = runFixture()
  let release!: () => void
  let received!: () => void
  let calls = 0
  let executed = 0
  let rejected = 0
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
  f.options.model.stream = async function* (_request, signal) {
    calls++
    if (calls === 1) {
      yield { type: 'text', text: 'old' }
      await arrived
      expect(signal.aborted).toBe(false)
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
    if (event.type === 'rejected') rejected++
    if (event.type === 'text' && !steering) {
      steering = service.steer('new direction')
      await arrived
      setTimeout(release, 15)
    }
  }
  await steering
  expect(rejected).toBe(0)
  expect(calls).toBe(2)
  expect(executed).toBe(1)
  expect((await f.view.inspect())?.goals.length).toBe(2)
  await service.close()
})

for (const slowPersistence of [false, true])
  test(`INV-37 steering wakes passive execution wait before background completion, slow persistence=${slowPersistence}`, async () => {
    const f = runFixture()
    const waiting = Promise.withResolvers<void>()
    const nextTurn = Promise.withResolvers<void>()
    const writing = Promise.withResolvers<void>()
    const persisted = Promise.withResolvers<void>()
    let calls = 0
    let stopped = 0
    let waitAborted = false
    const ingest = f.context.ingest.bind(f.context)
    f.context.ingest = async (input, signal) => {
      if (input.text === 'new direction' && slowPersistence) {
        writing.resolve()
        await persisted.promise
      }
      return ingest(input, signal)
    }
    f.options.model.stream = async function* () {
      calls++
      if (calls === 2) nextTurn.resolve()
      yield { type: 'text', text: calls === 1 ? 'Waiting for the running job.' : 'done' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return { message: 'progress', done: calls > 1, events: [] }
      },
    })
    f.options.execution = {
      pending: () => calls === 1,
      async wait(signal) {
        waiting.resolve()
        signal.throwIfAborted()
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              waitAborted = true
              reject(signal.reason)
            },
            { once: true }
          )
        )
      },
      async invoke() {},
      async stop() {
        stopped++
      },
    }
    const service = createActRunService(f.options)
    const events: Array<{ type: string; status?: string }> = []
    const running = (async () => {
      for await (const event of service.submit('original')) events.push(event)
    })()
    let resumed = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await waiting.promise
      const steering = service.steer('new direction')
      if (slowPersistence) {
        await writing.promise
        await Promise.resolve()
        expect(calls).toBe(1)
        expect(stopped).toBe(0)
        persisted.resolve()
      }
      await steering
      resumed = await Promise.race([
        nextTurn.promise.then(() => true),
        new Promise<false>((resolve) => (deadline = setTimeout(() => resolve(false), 300))),
      ])
      if (resumed) await running
    } finally {
      clearTimeout(deadline)
      persisted.resolve()
      service.cancel()
      await running
      await service.close()
    }
    expect(resumed).toBe(true)
    expect(waitAborted).toBe(true)
    expect(calls).toBe(2)
    expect((await f.view.inspect())?.goals.length).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  })

for (const slowPersistence of [false, true])
  test(`INV-37 steering yields foreground invocation without aborting execution, slow persistence=${slowPersistence}`, async () => {
    const f = runFixture()
    const entered = Promise.withResolvers<void>()
    const writing = Promise.withResolvers<void>()
    const persisted = Promise.withResolvers<void>()
    const resumed = Promise.withResolvers<void>()
    let calls = 0
    let invoked = 0
    let waitingCancelled = false
    let executionSignal: AbortSignal | undefined
    const ingest = f.context.ingest.bind(f.context)
    f.context.ingest = async (input, signal) => {
      if (input.text === 'new direction' && slowPersistence) {
        writing.resolve()
        await persisted.promise
      }
      return ingest(input, signal)
    }
    f.options.model.stream = async function* () {
      if (++calls === 2) {
        expect(executionSignal?.aborted).toBe(false)
        resumed.resolve()
      }
      yield { type: 'text', text: calls === 1 ? 'execute' : 'done' }
      yield { type: 'finish', reason: 'stop' }
    }
    f.options.protocol.open = () => ({
      instructions: 'fixture',
      reset() {},
      push() {
        return []
      },
      finish() {
        return {
          message: 'progress',
          done: calls > 1,
          events: [],
          ...(calls === 1 ? { submission: {} } : {}),
        }
      },
    })
    f.options.execution = {
      pending: () => false,
      async wait() {},
      async stop() {},
      async invoke(_input, signal, _turnId, _calls, waitSignal = signal) {
        invoked++
        executionSignal = signal
        entered.resolve()
        let wake!: () => void
        let cancel!: () => void
        try {
          await new Promise<void>((resolve, reject) => {
            wake = () => {
              waitingCancelled = true
              resolve()
            }
            cancel = () => reject(signal.reason)
            waitSignal.addEventListener('abort', wake, { once: true })
            signal.addEventListener('abort', cancel, { once: true })
            if (waitSignal.aborted) wake()
            signal.throwIfAborted()
          })
        } finally {
          waitSignal.removeEventListener('abort', wake)
          signal.removeEventListener('abort', cancel)
        }
        return true
      },
    }
    const service = createActRunService(f.options)
    const events: Array<{ type: string; status?: string }> = []
    const running = (async () => {
      for await (const event of service.submit('original')) events.push(event)
    })()
    let woke = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await entered.promise
      const steering = service.steer('new direction')
      if (slowPersistence) {
        await writing.promise
        await Promise.resolve()
        expect(calls).toBe(1)
        expect(executionSignal?.aborted).toBe(false)
        persisted.resolve()
      }
      await steering
      woke = await Promise.race([
        resumed.promise.then(() => true),
        new Promise<false>((resolve) => (deadline = setTimeout(() => resolve(false), 300))),
      ])
      if (woke) await running
    } finally {
      clearTimeout(deadline)
      persisted.resolve()
      service.cancel()
      await running
      await service.close()
    }
    expect(woke).toBe(true)
    expect(waitingCancelled).toBe(true)
    expect(invoked).toBe(1)
    expect(calls).toBe(2)
    expect((await f.view.inspect())?.goals.length).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
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
  expect(error).toBeInstanceOf(AppError)
  expect(error).toMatchObject({ code: 'UNAVAILABLE' })
  expect((error as { errors: readonly unknown[] }).errors).toHaveLength(2)
  expect((error as AppError).cause).toBeUndefined()
  expect(release).toBe(1)
  expect((await f.view.inspect())?.lease).toBeNull()
  await service.close()
})

test('steering during completion invalidates the old decision and delivers the new goal', async () => {
  const f = runFixture()
  let entered!: () => void
  let release!: () => void
  let checks = 0
  const checking = new Promise<void>((r) => (entered = r))
  const gate = new Promise<void>((r) => (release = r))
  const complete = f.view.complete.bind(f.view)
  f.view.complete = async (...args) => {
    if (++checks === 1) {
      entered()
      await gate
    }
    return complete(...args)
  }
  const service = createActRunService(f.options)
  const events = []
  const running = (async () => {
    for await (const event of service.submit('first')) events.push(event)
  })()
  await checking
  await service.steer('new goal during completion')
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

const fixtureStores = new Set<ContextStorage>()
afterEach(async () => {
  for (const store of fixtureStores) await store.close()
  fixtureStores.clear()
})

function storage(): ContextStorage {
  const store = localContextStorage({ path: ':memory:' })
  // 故障注入会先保存 put 再覆盖；固定实例接收者。
  store.put = store.put.bind(store)
  fixtureStores.add(store)
  return store
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

test('INV-31 child handles and host callbacks cannot rewrite supervisor ownership', async () => {
  const store = storage()
  const signal = new AbortController().signal
  let deliveries = 0
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 1,
    maxChildren: 1,
    async open(job) {
      Object.assign(job, {
        id: 'open-mutation',
        parentSessionId: 'foreign-open',
        sessionId: 'foreign-open',
      })
      Object.assign(job.collaboration!, { plannedWrites: ['open-mutation'] })
      return child(true)
    },
    async deliver(job, payload) {
      deliveries++
      const producer = job.sessionId
      const original = { ...payload }
      Object.assign(job, {
        id: 'delivery-mutation',
        parentSessionId: 'foreign-delivery',
        sessionId: 'foreign-delivery',
      })
      Object.assign(job.collaboration!, { plannedWrites: ['delivery-mutation'] })
      Object.assign(payload, { sessionId: 'foreign-payload', id: 'payload-mutation' })
      return {
        ref: { sessionId: 'p', id: `delivery-${deliveries}` },
        schemaVersion: 1,
        kind: 'agent',
        sessionId: producer,
        status: 'partial',
        payload: original,
        artifacts: [],
        omittedScripts: 0,
      }
    },
  })
  try {
    const started = await supervisor.start(
      'p',
      {
        task: 'first phase',
        profile: 'read',
        collaboration: { root: 'C:/Repo', plannedWrites: ['src'] },
      },
      signal
    )
    const id = started.id
    const sessionId = started.sessionId
    for (const phase of ['start', 'resume']) {
      const handle =
        phase === 'start'
          ? started
          : await supervisor.resume('p', id, { input: 'second phase' }, signal)
      expect(handle.parentSessionId).toBe('p')
      Object.assign(handle, {
        id: 'handle-mutation',
        parentSessionId: 'foreign-handle',
        sessionId: 'foreign-handle',
      })
      Object.assign(handle.collaboration!, { plannedWrites: ['handle-mutation'] })
      expect(await supervisor.status('p', id)).toMatchObject({
        id,
        sessionId,
        parentSessionId: 'p',
        collaboration: { plannedWrites: ['src'] },
      })
      expect(await supervisor.cancel('p', id)).toMatchObject({
        id,
        sessionId,
        parentSessionId: 'p',
        status: 'cancelled',
        result: { sessionId: 'p' },
      })
    }
    expect(deliveries).toBe(2)
    expect(supervisor.pending('p')).toBe(false)
    for (const foreign of ['foreign-open', 'foreign-delivery', 'foreign-payload', 'foreign-handle'])
      expect(await store.load(foreign)).toBeNull()
  } finally {
    await supervisor.close()
  }
})

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

test('child stop diagnostics remain visible after event eviction and reopen, and recovered errors clear', async () => {
  const error = { type: 'error' as const, runId: 'child', message: 'configured budget exhausted' }
  const accepted = {
    type: 'accepted' as const,
    runId: 'child',
    turnId: 'recovered',
    text: 'continued',
    ref: { sessionId: 'child', id: 'accepted' },
  }
  const completion = {
    type: 'completion' as const,
    runId: 'child',
    completed: false,
    reason: 'required input is unavailable',
  }
  for (const scenario of [
    { events: [error], terminal: 'waiting' as const, diagnostic: error.message },
    {
      events: [
        { type: 'stalled' as const, runId: 'child', repeatedSteps: 4, message: 'no progress' },
      ],
      terminal: 'waiting' as const,
      diagnostic: 'no progress',
    },
    { events: [completion], terminal: 'failed' as const, diagnostic: completion.reason },
    {
      events: [
        error,
        ...Array.from({ length: 100 }, () => ({
          type: 'state' as const,
          runId: 'child',
          status: 'thinking' as const,
        })),
      ],
      terminal: 'waiting' as const,
      diagnostic: error.message,
    },
    { events: [error, accepted], terminal: 'waiting' as const, diagnostic: undefined },
    {
      events: [completion, { ...completion, completed: true }],
      terminal: 'waiting' as const,
      diagnostic: undefined,
    },
    { events: [error], terminal: 'completed' as const, diagnostic: undefined },
  ]) {
    const store = storage()
    const signal = new AbortController().signal
    const options = {
      storage: store,
      concurrency: 1,
      maxChildren: 1,
      async open() {
        return {
          ...child(),
          async *submit() {
            yield* scenario.events
            yield { type: 'state' as const, runId: 'child', status: scenario.terminal }
          },
        }
      },
    }
    const supervisor = createAgentSupervisor(options)
    const started = await supervisor.start('p', { task: 'work', profile: 'read' }, signal)
    const job = await supervisor.wait('p', started.id, signal)
    expect(job.error).toBe(scenario.diagnostic)
    expect(job.status).toBe(scenario.terminal === 'waiting' ? 'interrupted' : scenario.terminal)
    await supervisor.close()
    const reopened = createAgentSupervisor(options)
    expect((await reopened.status('p', started.id)).error).toBe(scenario.diagnostic)
    await reopened.close()
  }
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
test('INV-31 equal short child ids keep independent parent lifecycles and failure accounts', async () => {
  const store = storage()
  const references = new Map<string, number>()
  store.allocateReferenceId = async (sessionId) => {
    const next = (references.get(sessionId) ?? 0) + 1
    references.set(sessionId, next)
    return next.toString(16).padStart(8, '0')
  }
  const finishes = new Map<string, () => void>()
  const failures = new Map([
    ['fail-a', new AppError('UNAVAILABLE', 'parent a cleanup failed')],
    ['fail-b', new AppError('UNAVAILABLE', 'parent b cleanup failed')],
  ])
  const supervisor = createAgentSupervisor({
    storage: store,
    concurrency: 2,
    maxChildren: 2,
    async open(job) {
      let finish!: () => void
      const ending = new Promise<void>((resolve) => {
        finish = resolve
      })
      finishes.set(job.parentSessionId, finish)
      return {
        ...child(),
        async *submit(_input, signal) {
          yield { type: 'state', runId: job.sessionId, status: 'thinking' }
          await ending
          yield {
            type: 'state',
            runId: job.sessionId,
            status: signal?.aborted ? 'cancelled' : 'completed',
          }
        },
        cancel: finish,
        async close() {
          const failure = failures.get(job.profile)
          if (failure) throw failure
        },
      }
    },
  })
  const signal = new AbortController().signal
  try {
    const a = await supervisor.start('a', { task: 'first', profile: 'read' }, signal)
    const b = await supervisor.start('b', { task: 'second', profile: 'fail-b' }, signal)
    expect(a.id).toBe('00000001')
    expect(b.id).toBe(a.id)
    expect(a.sessionId).not.toBe(b.sessionId)
    finishes.get('a')!()
    expect((await supervisor.wait('a', a.id, signal)).status).toBe('completed')
    expect((await supervisor.status('b', b.id)).status).toBe('running')
    expect((await supervisor.status('a', a.id)).status).toBe('completed')
    await supervisor.resume('a', a.id, { input: 'fail independently', profile: 'fail-a' }, signal)
    finishes.get('a')!()
    await expect(supervisor.wait('a', a.id, signal)).rejects.toBe(failures.get('fail-a'))
    expect((await supervisor.status('b', b.id)).status).toBe('running')
    finishes.get('b')!()
    await expect(supervisor.wait('b', b.id, signal)).rejects.toBe(failures.get('fail-b'))
    await expect(supervisor.wait('a', a.id, signal)).rejects.toBe(failures.get('fail-a'))
    // 清掉 a 的失败账不能同时清掉同短 id 的 b；随后两者各自恢复。
    for (const [parent, job] of [
      ['a', a],
      ['b', b],
    ] as const) {
      await supervisor.resume(parent, job.id, { input: 'recover', profile: 'read' }, signal)
      finishes.get(parent)!()
      expect((await supervisor.wait(parent, job.id, signal)).status).toBe('completed')
      if (parent === 'a')
        await expect(supervisor.wait('b', b.id, signal)).rejects.toBe(failures.get('fail-b'))
    }
  } finally {
    for (const finish of finishes.values()) finish()
    await supervisor.close()
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

test('child guidance waits for an admitted run and reaches that same child exactly once', async () => {
  const opening = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  const received: unknown[] = []
  let admitted = false
  let opened = 0
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 1,
    maxChildren: 1,
    async open() {
      opened++
      await opening.promise
      return {
        ...child(),
        async *submit(_input, signal) {
          const abort = () => delivered.resolve()
          signal!.addEventListener('abort', abort, { once: true })
          try {
            admitted = true
            yield { type: 'state' as const, runId: 'child', status: 'thinking' as const }
            await delivered.promise
            yield {
              type: 'state' as const,
              runId: 'child',
              status: signal!.aborted ? ('cancelled' as const) : ('completed' as const),
            }
          } finally {
            signal!.removeEventListener('abort', abort)
          }
        },
        async steer(input) {
          expect(admitted).toBe(true)
          received.push(input)
          delivered.resolve()
        },
      }
    },
  })
  try {
    const started = await supervisor.start(
      'p',
      { task: 'initial', profile: 'read' },
      new AbortController().signal
    )
    let settled = false
    const sending = supervisor
      .send('p', started.id, {
        text: 'additional constraint',
        origin: { kind: 'parent', sessionId: 'forged' },
      })
      .then(
        () => {
          settled = true
          return null
        },
        (error) => {
          settled = true
          return error
        }
      )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    opening.resolve()
    expect(await sending).toBeNull()
    expect((await supervisor.wait('p', started.id, new AbortController().signal)).status).toBe(
      'completed'
    )
    expect(received).toEqual([
      { text: 'additional constraint', origin: { kind: 'parent', sessionId: 'p' } },
    ])
    expect(opened).toBe(1)
  } finally {
    opening.resolve()
    delivered.resolve()
    await supervisor.close()
  }
})

test('child guidance cancellation during startup leaves the child running and delivers no stale input', async () => {
  const opening = Promise.withResolvers<void>()
  const admitted = Promise.withResolvers<void>()
  const received: unknown[] = []
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 1,
    maxChildren: 1,
    async open() {
      await opening.promise
      return {
        ...child(true),
        async *submit(input, signal) {
          for await (const event of child(true).submit(input, signal)) {
            admitted.resolve()
            yield event
          }
        },
        async steer(input) {
          received.push(input)
        },
      }
    },
  })
  try {
    const started = await supervisor.start(
      'p',
      { task: 'work', profile: 'read' },
      new AbortController().signal
    )
    const caller = new AbortController()
    const reason = new AppError('CANCELLED', 'guidance caller cancelled')
    const sending = supervisor
      .send('p', started.id, 'stale input', caller.signal)
      .catch((error) => error)
    caller.abort(reason)
    expect(await sending).toBe(reason)
    opening.resolve()
    await admitted.promise
    expect((await supervisor.status('p', started.id)).status).toBe('running')
    expect(received).toEqual([])
  } finally {
    opening.resolve()
    await supervisor.close()
  }
})

test('child guidance reports startup failure and points completed jobs to explicit resume', async () => {
  const opening = Promise.withResolvers<void>()
  let opened = 0
  const sessions: string[] = []
  const supervisor = createAgentSupervisor({
    storage: storage(),
    concurrency: 1,
    maxChildren: 1,
    async open(job) {
      sessions.push(job.sessionId)
      if (++opened === 1) {
        await opening.promise
        throw new AppError('UNAVAILABLE', 'fixture startup failure')
      }
      return child()
    },
  })
  const signal = new AbortController().signal
  try {
    const started = await supervisor.start('p', { task: 'work', profile: 'read' }, signal)
    const sending = supervisor.send('p', started.id, 'follow up').catch((error) => error)
    opening.resolve()
    const error = await sending
    expect(error.code).toBe('UNAVAILABLE')
    expect(error.message).toContain('failed')
    expect(error.message).toContain('resume')
    expect((await supervisor.wait('p', started.id, signal)).status).toBe('failed')
    await supervisor.resume('p', started.id, { input: 'retry explicitly' }, signal)
    expect((await supervisor.wait('p', started.id, signal)).status).toBe('completed')
    const completedError = await supervisor.send('p', started.id, 'more').catch((error) => error)
    expect(completedError.message).toContain('completed')
    expect(completedError.message).toContain('resume')
    expect(opened).toBe(2)
    expect(sessions).toEqual([started.sessionId, started.sessionId])
  } finally {
    opening.resolve()
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

test('INV-39 an explicit new task excludes retained earlier input across a later reopen', async () => {
  const f = runFixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  f.options.frames.prepare = () => gate
  const service = createActRunService(f.options)
  const old = []
  for await (const event of service.submit({ text: 'old goal', inputId: 'same-host-id' })) {
    old.push(event)
    if (event.type === 'input') {
      service.cancel()
      release()
    }
  }
  const oldInput = old.find((event) => event.type === 'input')!
  expect(old.some((event) => event.type === 'turn')).toBe(false)
  expect(old.find((event) => event.type === 'input-retained')).toMatchObject({
    ref: oldInput.ref,
  })
  const oldTask = await f.view.inspect()
  f.options.frames.prepare = async () => {}
  const fresh = []
  for await (const event of service.submit({
    text: 'independent goal',
    task: 'new',
    inputId: 'same-host-id',
  }))
    fresh.push(event)
  const freshInput = fresh.find((event) => event.type === 'input')!
  expect((await f.view.inspect())!.id).not.toBe(oldTask!.id)
  expect((await f.view.inspect())!.goals).toEqual([freshInput.ref])
  expect(fresh.filter((event) => event.type === 'input-applied')).toEqual([
    expect.objectContaining({ ref: freshInput.ref }),
  ])
  await service.close()

  const reopened = createActRunService(f.options)
  const continued = []
  for await (const event of reopened.submit('continue independent goal')) continued.push(event)
  expect((await f.view.inspect())!.goals).not.toContainEqual(oldInput.ref)
  expect(
    continued.some((event) => event.type === 'input-applied' && event.ref.id === oldInput.ref.id)
  ).toBe(false)
  const durable = (await reopened.events()).map((item) => item.event)
  expect(durable).toContainEqual(oldInput)
  expect(
    durable.some((event) => event.type === 'input-applied' && event.ref.id === oldInput.ref.id)
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
  await service.steer({
    text: 'queued direction',
    inputId: 'host-guide',
    origin: { kind: 'parent', sessionId: 'parent-session' },
  })
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
  const accepted = events.find((event) => event.type === 'input' && event.inputId === 'host-guide')!
  expect(accepted).toMatchObject({
    text: 'queued direction',
    origin: { kind: 'parent', sessionId: 'parent-session' },
  })
  expect(durable).toContainEqual(accepted)
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
  let finishFirst!: () => void
  const firstFinished = new Promise<void>((resolve) => (finishFirst = resolve))
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
      await firstFinished
      expect(signal.aborted).toBe(false)
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
  finishFirst()
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
  const { budgetRequestId: previousBudget, ...previousRequest } = JSON.parse(history[1])
  const { budgetRequestId: retriedBudget, ...retriedRequest } = JSON.parse(history[2])
  expect(retriedRequest).toEqual(previousRequest)
  expect(retriedBudget).not.toBe(previousBudget)
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
  Object.assign(f.frame, {
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
  })
  f.options.frames = {
    ...f.options.frames,
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
    Object.assign(f.frame, {
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
    })
    f.options.frames = {
      ...f.options.frames,

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
        if (mode === 'forecast') {
          expect(requests[1]!.contextStatus?.runway?.turns).toBe(1)
          expect(requests[1]!.contextStatus?.automaticHistory).toBe(true)
          expect(JSON.stringify(second)).not.toContain('remainingTokens')
          expect(JSON.stringify(second)).not.toContain('growthPerTurn')
        }
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

test.each(['fits', 'overflow', 'window', 'provider-reject', 'timeout', 'abort'] as const)(
  'INV-50 protocol repair preserves calibrated admission and execution boundaries: %s',
  async (mode) => {
    const f = runFixture()
    const controller = new AbortController()
    let calls = 0
    let executed = 0
    let folded = false
    let folds = 0
    let abortTimer: Optional<ReturnType<typeof setTimeout>>
    const sent: ModelTurnRequest[] = []
    f.options.limits = { ...f.options.limits, timeoutMs: mode === 'timeout' ? 100 : 2000 }
    if (mode === 'window') f.options.frames.policy = { windowTokens: 2000 }
    f.options.model.estimate = async (request) => {
      const repair = request.protocol?.includes('本帧上次响应未通过校验')
      if (repair && (mode === 'timeout' || mode === 'abort')) {
        if (mode === 'abort') abortTimer = setTimeout(() => controller.abort(), 20)
        return new Promise(() => {})
      }
      const repairTokens = mode === 'overflow' ? 120000 : mode === 'window' ? 30000 : 12020
      return {
        tokens: folded || executed === 0 ? 1000 : repair ? repairTokens : 12000,
        precision: 'estimate',
        basis: 'synthetic repair estimate',
      }
    }
    f.options.model.stream = async function* (request) {
      calls++
      sent.push(request)
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
      expect(
        JSON.stringify(sent.map((request) => modelRequestEncoder.messages(request)))
      ).not.toContain('unaccepted response')
      expect(requests[1].requestAudit.inputTokens).toBe(Math.ceil(12000 * ((100 / 1000) * 1.1)))
      expect(responses[1].status).toBe('rejected')
      if (mode !== 'provider-reject')
        expect(responses[1].usage).toEqual({ inputTokens: 1000, outputTokens: 1 })
      if (mode === 'fits') {
        expect(calls).toBe(3)
        // Both provider usages count, including the protocol-rejected response.
        // The learned growth is 900 / 11000 with a separately rounded fixed reserve.
        const slope = (1000 - 100) / (12000 - 1000)
        const overhead = Math.ceil((100 - slope * 1000) * 1.1)
        expect(requests[2].requestAudit.inputTokens).toBe(Math.ceil(12020 * slope * 1.1 + overhead))
        expect(sent[2]!.protocol).toContain('synthetic invalid intent')
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
      } else if (mode === 'overflow' || mode === 'window') {
        expect(calls).toBe(2)
        expect(events.at(-1)).toMatchObject({ type: 'state', status: 'context_blocked' })
      } else if (mode === 'provider-reject') {
        expect(calls).toBe(3)
        expect(folds).toBe(1)
        expect(requests[2].requestAudit.basis).not.toContain('校准')
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

test('INV-37 steering during acknowledge preserves accepted tools', async () => {
  const f = runFixture()
  let calls = 0
  let executed = 0
  const service = createActRunService(f.options)
  f.options.model.stream = async function* () {
    calls++
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  f.options.protocol.open = () => ({
    instructions: 'fixture',
    reset() {},
    push: () => [],
    finish: () =>
      calls === 1
        ? { message: 'stale', done: false, submission: { code: 'stale' }, events: [] }
        : { message: 'done', done: true, events: [] },
  })
  f.options.frames.acknowledge = async () => {
    if (calls === 1) await service.steer('new direction')
  }
  f.options.execution.invoke = async () => {
    executed++
  }
  const events = []
  for await (const event of service.submit('original')) events.push(event)
  expect(calls).toBe(2)
  expect(executed).toBe(1)
  expect(events.at(-1)).toMatchObject({ type: 'state', status: 'completed' })
  await service.close()
})

test('child handoff keeps the latest nonempty answer and terminal state without replaying progress', async () => {
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
          for (let index = 0; index < 100; index++) {
            yield { type: 'state' as const, runId: 'child', status: 'thinking' as const }
            yield {
              type: 'accepted' as const,
              runId: 'child',
              turnId: String(index),
              text: '',
              ref: { sessionId: 'child', id: String(index) },
            }
          }
          yield {
            type: 'accepted' as const,
            runId: 'child',
            turnId: 'progress',
            text: 'still checking',
            ref: { sessionId: 'child', id: 'progress' },
          }
          yield {
            type: 'accepted' as const,
            runId: 'child',
            turnId: 'final',
            text: 'Checks failed; changes need review.',
            ref: { sessionId: 'child', id: 'final' },
          }
          yield { type: 'state' as const, runId: 'child', status: 'completed' as const }
        },
      }
    },
  })
  try {
    const started = await supervisor.start('p', { task: 'handoff', profile: 'read' }, signal)
    const job = await supervisor.wait('p', started.id, signal)
    const context = createContextRuntime({ sessionId: 'p', storage: store })
    const record = await context.read(job.result!, { limit: 1 })
    const raw = (await store.get('p', record.record.objectId))!
    const result = JSON.parse(raw)
    expect(result.events.map((event: ActRunEvent) => event.type)).toEqual(['accepted', 'state'])
    expect(result.events[0].text).toBe('Checks failed; changes need review.')
    expect(result.events[0].ref.id).toBe('final')
    expect(result.events[1].status).toBe('completed')
    expect(result.omittedEvents).toBe(201)
    expect(raw).not.toContain('still checking')
    expect(raw.length).toBeLessThan(1500)
    expect(result.eventSource.sessionId).toBe(job.sessionId)
  } finally {
    await supervisor.close()
  }
})

test('frame cycle tries local budgets but publishes only its selected final body', async () => {
  const f = runFixture()
  const budgets: number[] = []
  const published: string[] = []
  let preparations = 0
  let calls = 0
  f.options.frames.beginFrame = async () => {
    preparations++
    return {
      retainFrames: false,
      project: async (maxChars) => {
        budgets.push(maxChars)
        return { body: maxChars > 1000 ? 'full' : 'compact', images: [] }
      },
      reconcile: async (body) => ({ body, prompt: body }),
      publish: async (body) => {
        published.push(body)
      },
    }
  }
  f.frame.project = async () => {
    throw Error('legacy projection must not run')
  }
  f.options.model.estimate = async (request) => ({
    tokens: request.materials[0]?.text === 'compact' ? 1000 : request.contextStatus ? 9100 : 8990,
    precision: 'exact',
    basis: 'final status boundary',
  })
  f.options.model.stream = async function* (request) {
    calls++
    expect(published).toEqual([request.materials[0]!.text])
    yield { type: 'text', text: 'done' }
    yield { type: 'finish', reason: 'stop' }
  }
  const service = createActRunService(f.options)
  try {
    for await (const _event of service.submit('work')) {
      /* drain */
    }
    expect(preparations).toBe(1)
    expect(budgets.length).toBeGreaterThan(1)
    expect(published).toEqual(['compact'])
    expect(calls).toBe(1)
  } finally {
    await service.close()
  }
})
