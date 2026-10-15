import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createContextRuntime, createContextView } from '../dist/index.js'
import { localContextStorage } from '../dist/node.js'

async function fixture(t, limits = {}) {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  const context = createContextRuntime({ sessionId: 'budget', storage })
  const options = {
    sessionId: 'budget',
    context,
    storage,
    sources: [],
    limits: { modelTokens: 100, ...limits },
  }
  const view = createContextView(options)
  const goal = await context.append({ kind: 'user', body: 'Complete the task.' })
  await view.begin(goal.ref)
  const taskId = (await view.inspect()).id
  const identity = (requestId) => ({ taskId, requestId })
  const reserve = async (id, tokens, role = 'main') => {
    const request = identity(id)
    await view.reserveModel(role, tokens, request)
    return request
  }
  const measured = async (id, tokens, input, output = 0) => {
    const request = await reserve(id, tokens)
    await view.dispatchModel(request)
    await view.recordUsage(input, output, request)
    return request
  }
  return { view, context, storage, options, goal, identity, reserve, measured }
}

test('INV-19 known usage replaces only its own reservation, including explicit zero', async (t) => {
  for (const input of [25, 0]) {
    const f = await fixture(t)
    await f.measured('first', 70, input)
    await f.reserve('next', 40)
    const usage = (await f.view.inspect()).usage
    assert.equal(usage.budgetTokens, input + 40)
    assert.equal(usage.mainCalls, 2)
    assert.equal(usage.unmeasuredCalls, 1)
    assert.equal(usage.reservedTokens, 110)
  }
})

test('missing usage keeps the complete reservation after dispatch', async (t) => {
  const f = await fixture(t)
  const request = await f.reserve('unknown', 70)
  await f.view.dispatchModel(request)
  await assert.rejects(f.reserve('next', 40), { code: 'MODEL_BUDGET' })
  await assert.rejects(f.view.releaseModel('main', 70, request), {
    code: 'MODEL_REQUEST_DISPATCHED',
  })
  assert.equal((await f.view.inspect()).usage.budgetTokens, 70)
})

test('actual usage and other unknown reservations add together', async (t) => {
  const f = await fixture(t)
  await f.measured('over-estimate', 30, 60)
  await f.reserve('unknown', 30, 'context')
  await assert.rejects(f.reserve('next', 40), { code: 'MODEL_BUDGET' })
  assert.equal((await f.view.inspect()).usage.budgetTokens, 90)
})

test('usage above the total limit is retained and prevents later dispatch', async (t) => {
  const f = await fixture(t)
  await f.measured('large', 30, 120, 5)
  assert.equal((await f.view.inspect()).usage.budgetTokens, 125)
  await assert.rejects(f.reserve('next', 1), { code: 'MODEL_BUDGET' })
})

test('unstarted reservations release once without releasing a different request', async (t) => {
  const f = await fixture(t, { modelCalls: 1 })
  const request = await f.reserve('cancelled', 70)
  await f.view.releaseModel('main', 70, request)
  await f.view.releaseModel('main', 70, request)
  await f.reserve('replacement', 100)
  const usage = (await f.view.inspect()).usage
  assert.equal(usage.mainCalls, 1)
  assert.equal(usage.budgetTokens, 100)
  await assert.rejects(f.view.dispatchModel(request), { code: 'MODEL_REQUEST_RELEASED' })
})

test('parallel admission uses one CAS budget and duplicate identities charge once', async (t) => {
  const f = await fixture(t)
  const attempts = await Promise.allSettled([f.reserve('a', 70), f.reserve('b', 70)])
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1)
  const request = attempts.find((x) => x.status === 'fulfilled').value
  await Promise.all([
    f.view.reserveModel('main', 70, request),
    f.view.reserveModel('main', 70, request),
  ])
  assert.equal((await f.view.inspect()).usage.mainCalls, 1)
  await assert.rejects(f.view.reserveModel('context', 70, request), {
    code: 'MODEL_REQUEST_CONFLICT',
  })
  await assert.rejects(f.view.reserveModel('main', 69, request), { code: 'MODEL_REQUEST_CONFLICT' })
})

test('out of order and duplicate settlements preserve request identity', async (t) => {
  const f = await fixture(t)
  const a = await f.reserve('a', 40)
  const b = await f.reserve('b', 50, 'context')
  await f.view.dispatchModel(a)
  await f.view.dispatchModel(b)
  await f.view.recordUsage(10, 2, b)
  await Promise.all([f.view.recordUsage(20, 3, a), f.view.recordUsage(20, 3, a)])
  await f.view.dispatchModel(a)
  const usage = (await f.view.inspect()).usage
  assert.equal(usage.budgetTokens, 35)
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.outputTokens, 5)
  assert.equal(usage.unmeasuredCalls, 0)
  await assert.rejects(f.view.recordUsage(21, 3, a), { code: 'MODEL_REQUEST_CONFLICT' })
})

test('late usage survives closing and reopening the view but cannot charge a new task', async (t) => {
  const f = await fixture(t)
  const request = await f.reserve('late', 70)
  await f.view.dispatchModel(request)
  await f.view.end('cancelled')
  const reopened = createContextView(f.options)
  await reopened.recordUsage(12, 3, request)
  assert.equal((await reopened.inspect()).usage.budgetTokens, 15)
  const next = await f.context.append({ kind: 'user', body: 'Start a different task.' })
  await reopened.begin(next.ref, undefined, 'new')
  await assert.rejects(reopened.recordUsage(12, 3, request), { code: 'MODEL_REQUEST_TASK' })
  assert.equal((await reopened.inspect()).usage.mainCalls, 0)
})

test('reopening retains unknown requests and permits their later settlement', async (t) => {
  const f = await fixture(t)
  const request = await f.reserve('persisted', 80)
  await f.view.dispatchModel(request)
  await f.view.end()
  const reopened = createContextView(f.options)
  await reopened.begin(f.goal.ref)
  await assert.rejects(reopened.reserveModel('main', 30, f.identity('next')), {
    code: 'MODEL_BUDGET',
  })
  await reopened.recordUsage(10, 0, request)
  await reopened.reserveModel('main', 90, f.identity('next'))
  assert.equal((await reopened.inspect()).usage.budgetTokens, 100)
})

test('settlement adjusts the original hourly bucket, never the current request bucket', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const f = await fixture(t, { modelTokens: 1000, modelTokensPerHour: 100 })
  const a = await f.reserve('previous', 70)
  await f.view.dispatchModel(a)
  t.mock.timers.tick(3_600_000)
  await f.reserve('current', 30)
  await f.view.recordUsage(20, 0, a)
  const usage = (await f.view.inspect()).usage
  assert.deepEqual(usage.hourly, { start: 3_600_000, tokens: 30, previous: 20 })
  await f.reserve('next', 50)
})

test('old hourly settlement and release do not refund unrelated current reservations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 })
  const f = await fixture(t, { modelTokens: 1000, modelTokensPerHour: 100 })
  const a = await f.reserve('old', 40)
  const b = await f.reserve('old-unsent', 30)
  await f.view.dispatchModel(a)
  t.mock.timers.tick(7_200_000)
  await f.reserve('current', 80)
  await f.view.recordUsage(20, 0, a)
  await f.view.releaseModel('main', 30, b)
  assert.deepEqual((await f.view.inspect()).usage.hourly, {
    start: 7_200_000,
    tokens: 80,
    previous: 0,
  })
})

test('legacy aggregate calls retain conservative accounting alongside identified calls', async (t) => {
  const f = await fixture(t, { modelTokens: 200 })
  await f.view.reserveModel('main', 70)
  await f.view.recordUsage(25, 0)
  await f.measured('identified', 80, 10)
  assert.equal((await f.view.inspect()).usage.budgetTokens, 80)
  await f.view.reserveModel('context', 100)
  assert.equal((await f.view.inspect()).usage.budgetTokens, 180)
  await f.view.releaseModel('context', 100)
  assert.equal((await f.view.inspect()).usage.budgetTokens, 80)
  await f.reserve('next', 120)
  assert.equal((await f.view.inspect()).usage.unmeasuredCalls, 1)
})

test('usage requires a dispatched request and unknown identities cannot alter counters', async (t) => {
  const f = await fixture(t)
  const request = await f.reserve('reserved', 50)
  await assert.rejects(f.view.recordUsage(10, 0, request), { code: 'MODEL_REQUEST_NOT_DISPATCHED' })
  await assert.rejects(f.view.dispatchModel(f.identity('missing')), {
    code: 'MODEL_REQUEST_NOT_FOUND',
  })
  await assert.rejects(f.view.recordUsage(10, 0, f.identity('missing')), {
    code: 'MODEL_REQUEST_NOT_FOUND',
  })
  await assert.rejects(
    f.view.reserveModel('main', 20, { taskId: 'other', requestId: 'different' }),
    { code: 'MODEL_REQUEST_TASK' }
  )
  assert.equal((await f.view.inspect()).usage.budgetTokens, 50)
})

test('finalization holds transfer atomically to a physical request without freeing capacity', async (t) => {
  const f = await fixture(t, { modelCalls: 1 })
  const hold = await f.reserve('finalization-hold', 70, 'context')
  await f.view.transferModelReservation(hold, 'physical')
  await f.view.transferModelReservation(hold, 'physical')
  let state = await f.view.inspect()
  assert.equal(state.usage.contextCalls, 1)
  assert.equal(state.usage.budgetTokens, 70)
  assert.equal(state.usage.hourly.tokens, 70)
  await assert.rejects(f.reserve('other', 1), { code: 'MODEL_BUDGET' })
  await assert.rejects(f.view.transferModelReservation(hold, 'second'), {
    code: 'MODEL_REQUEST_CONFLICT',
  })
  await f.view.dispatchModel(f.identity('physical'))
  await f.view.recordUsage(10, 5, f.identity('physical'))
  state = await f.view.inspect()
  assert.equal(state.usage.contextCalls, 1)
  assert.equal(state.usage.budgetTokens, 15)
  assert.equal(state.usage.hourly.tokens, 15)
  await assert.rejects(f.view.releaseModel('context', 70, hold), {
    code: 'MODEL_REQUEST_DISPATCHED',
  })
})

test('failed preparation refunds a transferred hold exactly once through its original identity', async (t) => {
  const f = await fixture(t)
  const hold = await f.reserve('hold', 70, 'context')
  await f.view.transferModelReservation(hold, 'physical')
  await f.view.releaseModel('context', 70, hold)
  await f.view.releaseModel('context', 70, hold)
  await f.reserve('replacement', 100)
  assert.equal((await f.view.inspect()).usage.budgetTokens, 100)
  await assert.rejects(f.view.dispatchModel(f.identity('physical')), {
    code: 'MODEL_REQUEST_RELEASED',
  })
})

test('unsafe usage totals and corrupt persisted counters never reduce the budget', async (t) => {
  const f = await fixture(t)
  const request = await f.reserve('physical', 70)
  await f.view.dispatchModel(request)
  await assert.rejects(f.view.recordUsage(Number.MAX_SAFE_INTEGER, 1, request), {
    code: 'MODEL_USAGE',
  })
  assert.equal((await f.view.inspect()).usage.budgetTokens, 70)
  const snapshot = await f.storage.load('budget')
  await f.storage.compareAndSwap('budget', snapshot.version, {
    ...snapshot,
    version: snapshot.version + 1,
    task: { ...snapshot.task, usage: { ...snapshot.task.usage, budgetTokens: 0 } },
  })
  await assert.rejects(f.view.inspect(), { code: 'TASK_STATE' })
})
