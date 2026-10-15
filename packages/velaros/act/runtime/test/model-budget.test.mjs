import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'

import { BudgetedModelDriver } from '../../../dist/act/runtime/impl/BudgetedModelDriver.js'
import { ModelToolActivation } from '../../../dist/act/runtime/impl/ModelToolActivation.js'
import { ModelToolRuntime } from '../../../dist/act/runtime/impl/ModelToolRuntime.js'
import { readModelBudgetSettlement } from '../../../dist/act/runtime/utils/model-budget.js'

const signal = () => new AbortController().signal
const collect = async (driver, request = { outputTokens: 10 }, cancellation = signal()) => {
  const events = []
  for await (const event of driver.stream(request, cancellation)) events.push(event)
  return events
}
const driver = (stream, estimate = 60) => ({
  id: 'accounting-control',
  limits: { contextTokens: 1000, inputTokens: 900, outputTokens: 100 },
  estimate: async () => ({ tokens: estimate, precision: 'exact', basis: 'control' }),
  stream,
})

async function fixture(t, limits = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  const views = new Map()
  const scopes = []
  for (const sessionId of ['root', 'child']) {
    const context = createContextRuntime({ sessionId, storage })
    const goal = await context.append({ kind: 'user', body: `Work in ${sessionId}` })
    const view = createContextView({
      sessionId,
      storage,
      context,
      sources: [],
      limits: { modelTokens: 100, ...limits },
    })
    await view.begin(goal.ref)
    views.set(sessionId, view)
  }
  const tools = new ModelToolRuntime({
    storage,
    view: (id) => views.get(id),
    deadline: () => undefined,
    policy: { concurrency: 1 },
  })
  tools.root('root')
  const agent = await tools.begin('child', 'root', 'agent', 10000, signal())
  scopes.push(agent)
  const nested = await tools.begin('review', 'child', 'verification', 10000, signal())
  scopes.push(nested)
  t.after(async () => {
    for (const scope of scopes.reverse()) await scope.close()
    for (const view of views.values()) await view.end()
    storage.close()
  })
  return { storage, views, tools, agent, nested }
}

test('real model wrapper settles the same request on every ancestor without retaining known estimate padding', async (t) => {
  const f = await fixture(t)
  const model = new BudgetedModelDriver({
    model: driver(async function* () {
      yield { type: 'usage', inputTokens: 20, outputTokens: 5 }
      yield { type: 'finish', reason: 'stop' }
    }),
    parent: f.nested.budget,
    signal: signal(),
  })
  await collect(model, { outputTokens: 10, budgetRequestId: 'first' })
  await collect(model, { outputTokens: 10, budgetRequestId: 'second' })
  await model.close()
  for (const view of f.views.values()) {
    const state = await view.inspect()
    assert.equal(state.usage.budgetTokens, 50)
    assert.equal(state.usage.contextCalls, 2)
    assert.equal(state.usage.unmeasuredCalls, 0)
    assert.deepEqual(Object.keys(state.modelBudget.requests), ['first', 'second'])
  }
})

test('a cancelled queue wait refunds all reservations and never calls the model', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  const running = collect(
    f.tools.model(
      'root',
      driver(async function* () {
        entered.resolve()
        await finish.promise
        yield { type: 'finish', reason: 'stop' }
      })
    )
  )
  await entered.promise
  const cancel = new AbortController()
  let calls = 0
  const model = new BudgetedModelDriver({
    model: f.tools.model(
      'review',
      driver(async function* () {
        calls++
        yield { type: 'finish', reason: 'stop' }
      })
    ),
    parent: f.nested.budget,
    signal: signal(),
  })
  try {
    const pending = collect(model, { outputTokens: 10 }, cancel.signal)
    const rejection = assert.rejects(pending, { name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await f.views.get('root').inspect()).usage.contextCalls, 1)
    cancel.abort()
    await rejection
    await model.close()
    assert.equal(calls, 0)
    for (const view of f.views.values()) {
      assert.equal((await view.inspect()).usage.contextCalls, 0)
      assert.equal((await view.inspect()).usage.budgetTokens, 0)
    }
  } finally {
    finish.resolve()
    await running
  }
})

test('dispatch preparation failure refunds partial ancestor registration before the provider begins', async (t) => {
  const f = await fixture(t)
  const child = f.views.get('child')
  const dispatch = child.dispatchModel.bind(child)
  child.dispatchModel = async () => {
    throw Error('injected durable dispatch failure')
  }
  let calls = 0
  const model = new BudgetedModelDriver({
    model: driver(async function* () {
      calls++
      yield { type: 'finish', reason: 'stop' }
    }),
    parent: f.nested.budget,
    signal: signal(),
  })
  await assert.rejects(collect(model), /injected durable dispatch failure/)
  child.dispatchModel = dispatch
  await model.close()
  assert.equal(calls, 0)
  for (const view of f.views.values()) assert.equal((await view.inspect()).usage.budgetTokens, 0)
})

test('driver preparation can fail without a charge; an entered driver with no usage remains unknown', async (t) => {
  const f = await fixture(t)
  const preparation = new BudgetedModelDriver({
    model: {
      // eslint-disable-next-line require-yield -- 准备失败控制必须在任何模型增量之前抛错。
      ...driver(async function* () {
        throw Error('prepare failed')
      }),
      dispatchAware: true,
    },
    parent: f.agent.budget,
    signal: signal(),
  })
  await assert.rejects(collect(preparation), /prepare failed/)
  await preparation.close()
  assert.equal((await f.views.get('root').inspect()).usage.budgetTokens, 0)
  const dispatched = new BudgetedModelDriver({
    // eslint-disable-next-line require-yield -- 断流控制故意不提供供应商用量或响应。
    model: driver(async function* () {
      throw Error('stream interrupted')
    }),
    parent: f.agent.budget,
    signal: signal(),
  })
  await assert.rejects(collect(dispatched), /stream interrupted/)
  await dispatched.close()
  assert.equal((await f.views.get('root').inspect()).usage.budgetTokens, 70)
  assert.equal((await f.views.get('root').inspect()).usage.unmeasuredCalls, 1)
})

test('retrying a partial ancestor usage settlement never charges successful ancestors twice', async (t) => {
  const f = await fixture(t)
  await f.nested.budget.reserveModel('context', 70, 'shared')
  await f.nested.budget.dispatchModel('shared')
  const child = f.views.get('child')
  const record = child.recordUsage.bind(child)
  child.recordUsage = async () => {
    throw Error('injected durable usage failure')
  }
  await assert.rejects(f.nested.budget.recordUsage(20, 5, 'shared'), /durable usage failure/)
  assert.equal((await f.views.get('root').inspect()).usage.budgetTokens, 25)
  assert.equal((await child.inspect()).usage.budgetTokens, 70)
  child.recordUsage = record
  await f.nested.budget.recordUsage(20, 5, 'shared')
  await f.nested.budget.recordUsage(20, 5, 'shared')
  for (const view of f.views.values()) {
    const { usage } = await view.inspect()
    assert.equal(usage.inputTokens, 20)
    assert.equal(usage.outputTokens, 5)
    assert.equal(usage.contextCalls, 1)
    assert.equal(usage.budgetTokens, 25)
  }
})

test('closing during unresponsive driver preparation refunds now and prevents late dispatch', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers()
  const resume = Promise.withResolvers()
  let calls = 0
  const model = new BudgetedModelDriver({
    model: {
      ...driver(async function* (_request, _signal, beforeDispatch) {
        entered.resolve()
        await resume.promise
        await beforeDispatch()
        calls++
        yield { type: 'finish', reason: 'stop' }
      }),
      dispatchAware: true,
    },
    parent: f.nested.budget,
    signal: signal(),
  })
  const pending = collect(model)
  const rejection = assert.rejects(pending, { name: 'AbortError' })
  await entered.promise
  try {
    await Promise.race([
      model.close(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(Error('close waited for unresponsive preparation')), 500)
      ),
    ])
    for (const view of f.views.values()) assert.equal((await view.inspect()).usage.budgetTokens, 0)
  } finally {
    resume.resolve()
    await rejection
  }
  assert.equal(calls, 0)
})

test('coordinator replacement replays a persisted partial settlement before allowing another model request', async (t) => {
  const f = await fixture(t)
  await f.nested.budget.reserveModel('context', 70, 'recoverable')
  await f.nested.budget.dispatchModel('recoverable')
  const child = f.views.get('child')
  const record = child.recordUsage.bind(child)
  child.recordUsage = async () => {
    throw Error('temporary child storage failure')
  }
  await assert.rejects(
    f.nested.budget.recordUsage(20, 5, 'recoverable'),
    /temporary child storage failure/
  )
  child.recordUsage = record
  const replacement = new ModelToolRuntime({
    storage: f.storage,
    view: () => {
      throw Error('live child view is not reopened')
    },
    deadline: () => undefined,
  })
  replacement.root('root')
  let calls = 0
  await collect(
    replacement.model(
      'root',
      driver(async function* () {
        for (const view of f.views.values())
          assert.equal((await view.inspect()).usage.budgetTokens, 25)
        calls++
        yield { type: 'finish', reason: 'stop' }
      })
    )
  )
  assert.equal(calls, 1)
  for (const view of f.views.values()) {
    const { usage } = await view.inspect()
    assert.equal(usage.contextCalls, 1)
    assert.equal(usage.inputTokens, 20)
    assert.equal(usage.unmeasuredCalls, 0)
  }
  const snapshot = await f.storage.load('root')
  const receipt = snapshot.records.filter((row) => row.title === 'model-budget:settlement').at(-1)
  assert.equal(JSON.parse(await f.storage.get('root', receipt.objectId)).status, 'settled')
})

test('the prepaid final request uses the same physical identity on every ancestor', async (t) => {
  const f = await fixture(t)
  await f.nested.budget.reserveModel('context', 70, 'final-hold')
  let calls = 0
  const activation = new ModelToolActivation({
    parent: f.nested.budget,
    model: driver(async function* (request) {
      assert.equal(request.budgetRequestId, 'physical-final')
      calls++
      yield { type: 'usage', inputTokens: 20, outputTokens: 5 }
      yield { type: 'finish', reason: 'stop' }
    }),
    profile: {
      modelCalls: 1,
      modelTokens: 100,
      finalizationTokens: 70,
      callTimeoutMs: 1000,
      finalizationMs: 1000,
    },
    finalizationRequestId: 'final-hold',
    deadline: Date.now() + 10000,
  })
  await collect(activation, { outputTokens: 10, budgetRequestId: 'physical-final' })
  await activation.close()
  assert.equal(calls, 1)
  for (const view of f.views.values()) {
    const state = await view.inspect()
    assert.equal(state.usage.budgetTokens, 25)
    assert.equal(state.usage.contextCalls, 1)
    assert.equal(state.modelBudget.requests['final-hold'].status, 'transferred')
    assert.equal(state.modelBudget.requests['physical-final'].status, 'settled')
  }
})

test('a partially transferred final hold is refunded on every ancestor before any provider call', async (t) => {
  const f = await fixture(t)
  await f.nested.budget.reserveModel('context', 70, 'final-hold')
  f.views.get('child').transferModelReservation = async () => {
    throw Error('transfer fixture failure')
  }
  let calls = 0
  const activation = new ModelToolActivation({
    parent: f.nested.budget,
    model: driver(async function* () {
      calls++
      yield { type: 'finish', reason: 'stop' }
    }),
    profile: {
      modelCalls: 1,
      modelTokens: 100,
      finalizationTokens: 70,
      callTimeoutMs: 1000,
      finalizationMs: 1000,
    },
    finalizationRequestId: 'final-hold',
    deadline: Date.now() + 10000,
  })
  await assert.rejects(
    collect(activation, { outputTokens: 10, budgetRequestId: 'physical-final' }),
    /transfer fixture failure/
  )
  await activation.close()
  assert.equal(calls, 0)
  for (const view of f.views.values()) {
    const { usage } = await view.inspect()
    assert.equal(usage.budgetTokens, 0)
    assert.equal(usage.contextCalls, 0)
  }
})

test('pending old-task usage recovers to surviving ancestors without charging a new root task', async (t) => {
  const f = await fixture(t)
  await f.nested.budget.reserveModel('context', 70, 'old-request')
  await f.nested.budget.dispatchModel('old-request')
  const child = f.views.get('child')
  const record = child.recordUsage.bind(child)
  child.recordUsage = async () => {
    throw Error('child fixture failure')
  }
  await assert.rejects(f.nested.budget.recordUsage(20, 5, 'old-request'), /child fixture failure/)
  child.recordUsage = record
  const root = f.views.get('root')
  await root.end()
  const context = createContextRuntime({ sessionId: 'root', storage: f.storage })
  const goal = await context.append({ kind: 'user', body: 'An independent new task' })
  await root.begin(goal.ref, undefined, 'new')
  await collect(
    f.tools.model(
      'root',
      driver(async function* () {
        assert.equal((await root.inspect()).usage.mainCalls, 0)
        assert.equal((await root.inspect()).usage.contextCalls, 0)
        assert.equal((await child.inspect()).usage.budgetTokens, 25)
        yield { type: 'finish', reason: 'stop' }
      })
    )
  )
  const snapshot = await f.storage.load('root')
  const receipt = snapshot.records.filter((row) => row.title === 'model-budget:settlement').at(-1)
  assert.equal(JSON.parse(await f.storage.get('root', receipt.objectId)).status, 'archived')
})

test('settlement decoding rejects coercible status values and invalid ownership without weakening valid receipts', () => {
  const receipt = {
    requestId: 'request',
    rootSessionId: 'root',
    rootTaskId: 'task',
    inputTokens: 0,
    outputTokens: 2,
    targets: [{ sessionId: 'root', taskId: 'task' }],
    status: 'pending',
  }
  for (const status of ['pending', 'settled', 'archived']) {
    const valid = { ...receipt, status }
    assert.deepEqual(readModelBudgetSettlement(valid, 'root'), valid)
  }
  for (const patch of [
    { status: ['pending'] },
    { status: { toString: () => 'settled' } },
    { inputTokens: '0' },
    { outputTokens: Number.NaN },
    { rootSessionId: 'other' },
    { targets: [{ sessionId: 'root', taskId: 'other' }] },
    { targets: [receipt.targets[0], receipt.targets[0]] },
    { targets: [{ sessionId: 'root' }] },
  ])
    assert.throws(() => readModelBudgetSettlement({ ...receipt, ...patch }, 'root'), {
      code: 'TASK_STATE',
    })
})

test('malformed persisted settlement prevents provider dispatch instead of reducing unknown usage', async (t) => {
  const f = await fixture(t)
  const context = createContextRuntime({ sessionId: 'root', storage: f.storage })
  await context.append({
    kind: 'audit',
    title: 'model-budget:settlement',
    body: JSON.stringify({ status: 'pending', requestId: 'bad' }),
  })
  let calls = 0
  await assert.rejects(
    collect(
      f.tools.model(
        'root',
        driver(async function* () {
          calls++
          yield { type: 'finish', reason: 'stop' }
        })
      )
    ),
    { code: 'TASK_STATE' }
  )
  assert.equal(calls, 0)
})

test('invalid provider usage cannot settle an ancestor before the main protocol rejects it', async (t) => {
  const f = await fixture(t)
  const model = new BudgetedModelDriver({
    model: driver(async function* () {
      yield { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 11 }
    }),
    parent: f.nested.budget,
    signal: signal(),
  })
  await assert.rejects(collect(model), { code: 'PROTOCOL' })
  await model.close()
  for (const view of f.views.values()) {
    const { usage } = await view.inspect()
    assert.equal(usage.budgetTokens, 70)
    assert.equal(usage.unmeasuredCalls, 1)
    assert.equal(usage.inputTokens, 0)
  }
})
