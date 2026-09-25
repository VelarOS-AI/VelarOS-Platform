import { expect, test } from 'bun:test'

import type { ContextState } from '@velaros-ai/context'
import type { ContextStorage } from '@velaros-ai/context'
import { createContextRuntime, createContextView } from '@velaros-ai/context'

import type { ActChildSession } from '../src/contract/requires.js'
import type { ActRunServiceOptions } from '../src/contract/requires.js'
import { createAgentSupervisor } from '../src/index.js'
import { createActRunService } from '../src/index.js'
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

test('INV-42 persistent faults in a segment run pressure maintenance once and ask the model to tighten its working set', async () => {
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
  // 同一段只整理一次，之后照常给出收紧建议
  expect(reasons.filter((reason) => reason === 'pressure')).toEqual(['pressure'])
  expect(overloads.at(-1)).toMatch(/3 次读回/)
  await service.close()
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

test('INV-38 child delivery bounds embedded history and preserves the needs-reconcile state', async () => {
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
          yield { type: 'state', runId: 'child', status: 'needs_reconcile' }
        },
      }
    },
  })
  const started = await supervisor.start('p', { task: 'many turns', profile: 'read' }, signal)
  const job = await supervisor.wait('p', started.id, signal)
  expect(job.status).toBe('needs_reconcile')
  const context = createContextRuntime({ sessionId: 'p', storage: store })
  const record = await context.read(job.result!, { limit: 1 })
  const raw = (await store.get('p', record.record.objectId))!
  const result = JSON.parse(raw)
  expect(raw.length).toBeLessThan(130000)
  expect(result.omittedEvents).toBeGreaterThan(970)
  expect(result.events.length + result.omittedEvents).toBe(1001)
  expect(result.events.at(-1).status).toBe('needs_reconcile')
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
