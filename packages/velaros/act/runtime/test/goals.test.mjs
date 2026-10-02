import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { createRuntime } from '../../../dist/act/runtime/index.js'

import { done, frameText, marker, turn } from './support/model-turn.mjs'

const limits = { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 }
const estimate = async () => ({ tokens: 1000, precision: 'exact' })
/** 最终答复带完成依据：有进行中的目标时由 Runtime 据此结束目标。 */
async function* doneWith(request, reason, message = '') {
  yield {
    type: 'text',
    text: `${message}${message ? '\n' : ''}${marker(request)} done(${JSON.stringify(reason)})`,
  }
  yield { type: 'finish', reason: 'stop' }
}
const runtimeGoal = (request) =>
  JSON.parse(request.materials.find((m) => m.origin === 'runtime-view').text).partitions.runtime
    .goal

async function verificationFixture(t, verify, stream, modelOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'goal-verification-'))
  const path = join(dataDir, 'context.sqlite')
  const storage = localContextStorage({ path })
  const runtime = await createRuntime({
    storage,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false, completion: { verify: (...args) => verify(session, ...args) } },
    model: {
      id: 'goal-verification',
      limits,
      estimate,
      ...modelOptions,
      stream: (request, signal) => stream(session, request, signal),
    },
  })
  const session = await runtime.openSession('goal')
  await session.context.ingest({ text: '推进指定目标并核查产物' })
  const goal = await session.updateGoal({ baseRevision: 0, objective: '检查指定产物' })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, session, storage, path, goal }
}

const checkReport = (status) => ({
  scope: '指定产物能否打开',
  checkedAt: new Date().toISOString(),
  checks: [
    {
      label: '打开产物',
      status,
      artifact: { identity: 'result.docx', revision: status === 'passed' ? 'v2' : 'v1' },
    },
  ],
})

async function fixture(t, model) {
  const dataDir = await mkdtemp(join(tmpdir(), 'session-goal-'))
  const options = {
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  }
  const runtime = await createRuntime({ ...options, model })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const session = await runtime.openSession('goal')
  await session.context.ingest({ text: '用户明确要求推进目标' })
  return { runtime, session, options }
}

test('INV-48 goal CAS, pause, removal tombstones and restart share the same immutable session store', async (t) => {
  const { runtime, session, options } = await fixture(t)
  assert.equal(await session.getGoal(), null)
  const first = await session.updateGoal({ baseRevision: 0, objective: '完成目标' })
  assert.equal(first.status, 'active')
  await assert.rejects(session.updateGoal({ baseRevision: 0, status: 'paused' }), {
    code: 'GOAL_CONFLICT',
  })
  const race = await Promise.allSettled([
    session.updateGoal({ baseRevision: 1, status: 'paused' }),
    session.updateGoal({ baseRevision: 1, status: 'blocked', reason: '外部服务不可用' }),
  ])
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'GOAL_CONFLICT')
  let current = await session.getGoal()
  current = await session.controlGoal({ baseRevision: current.revision, action: 'pause' })
  current = await session.updateGoal({ baseRevision: current.revision, reason: '补充进度' })
  assert.equal(current.status, 'paused')
  await assert.rejects(
    session.updateGoal({ baseRevision: current.revision, objective: '覆盖暂停目标' }),
    { code: 'GOAL_INPUT' }
  )
  await runtime.close()
  const reopened = await createRuntime(options)
  try {
    const next = await reopened.openSession('goal')
    assert.deepEqual(await next.getGoal(), current)
    const removed = await next.controlGoal({ baseRevision: current.revision, action: 'remove' })
    assert.equal(removed.status, 'removed')
    await assert.rejects(next.controlGoal({ baseRevision: current.revision, action: 'resume' }), {
      code: 'GOAL_CONFLICT',
    })
    const fresh = await next.updateGoal({ baseRevision: removed.revision, objective: '新的目标' })
    assert.notEqual(fresh.id, first.id)
    assert.equal(fresh.revision, removed.revision + 1)
    await assert.rejects(next.updateGoal({ baseRevision: fresh.revision, status: 'complete' }), {
      code: 'GOAL_INPUT',
    })
  } finally {
    await reopened.close()
  }
  await assert.rejects(session.getGoal())
})

test('active goal prevents premature done; model operation explicitly completes the same goal', async (t) => {
  const frames = []
  const model = {
    id: 'goal-test',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact' }),
    async *stream(request) {
      frames.push(request)
      if (frames.length === 2) {
        yield turn(request, {
          execute: {
            source: `import {goal} from 'velaros:system';const current=await goal.get();if(!current)throw new Error('missing');await goal.update({baseRevision:current.revision,status:'complete',reason:'已执行测试并确认结果'});`,
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    },
  }
  const { session } = await fixture(t, model)
  await session.updateGoal({ baseRevision: 0, objective: '需要明确验收的目标' })
  const events = []
  for await (const event of session.submit('继续')) events.push(event)
  assert.equal(frames.length, 3, JSON.stringify(events))
  assert.equal((await session.getGoal()).status, 'complete')
  const projected = JSON.parse(frames[0].materials.find((m) => m.origin === 'runtime-view').text)
  assert.equal(projected.partitions.runtime.goal.objective, '需要明确验收的目标')
  assert(!events.some((e) => e.type === 'error'), JSON.stringify(events))
})

test('done with a completion reason ends the active goal in the same reply', async (t) => {
  const frames = []
  const model = {
    id: 'goal-claim-test',
    limits,
    estimate,
    async *stream(request) {
      frames.push(request)
      yield* doneWith(request, '已按问题给出答复', '答复正文')
    },
  }
  const { session } = await fixture(t, model)
  await session.updateGoal({ baseRevision: 0, objective: '回答一个简单问题' })
  const events = await Array.fromAsync(session.submit('一个简单问题'))
  assert.equal(frames.length, 1, JSON.stringify(events))
  assert(frameText(frames[0]).includes('done("完成依据")'), 'the frame protocol offers the claim')
  const goal = await session.getGoal()
  assert.equal(goal.status, 'complete')
  assert.equal(goal.reason, '已按问题给出答复')
  assert(!events.some((e) => e.type === 'error'), JSON.stringify(events))
})

test('a goal passed with submit is set before the first frame, clipped to the objective limit', async (t) => {
  const frames = []
  const model = {
    id: 'goal-seed-test',
    limits,
    estimate,
    async *stream(request) {
      frames.push(request)
      yield* doneWith(request, '已完成')
    },
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'session-goal-seed-'))
  const runtime = await createRuntime({
    dataDir,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    model,
  })
  t.after(async () => {
    await runtime.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const session = await runtime.openSession('seed')
  const objective = `新的目标${'。'.repeat(9000)}`
  await Array.fromAsync(session.submit(objective, undefined, { goal: objective }))
  assert.equal(frames.length, 1)
  const first = runtimeGoal(frames[0])
  assert.equal(first.status, 'active')
  assert.equal(first.objective, objective.slice(0, 8000))
  assert.equal((await session.getGoal()).status, 'complete')
})

test('a goal passed with submit keeps a paused goal and replaces a finished one', async (t) => {
  const frames = []
  const model = {
    id: 'goal-seed-keep-test',
    limits,
    estimate,
    async *stream(request) {
      frames.push(request)
      yield* runtimeGoal(request)?.status === 'active' ? doneWith(request, '已完成') : done(request)
    },
  }
  const { session } = await fixture(t, model)
  await session.updateGoal({ baseRevision: 0, objective: '原来的目标' })
  await session.controlGoal({ baseRevision: 1, action: 'pause' })
  await Array.fromAsync(session.submit('新的问题', undefined, { goal: '新的问题' }))
  assert.equal(runtimeGoal(frames[0]).objective, '原来的目标')
  assert.equal((await session.getGoal()).status, 'paused')
  await session.controlGoal({ baseRevision: 2, action: 'complete' })
  await Array.fromAsync(session.submit('下一个目标', undefined, { goal: '下一个目标' }))
  assert.equal(runtimeGoal(frames[1]).objective, '下一个目标')
  assert.equal((await session.getGoal()).status, 'complete')
})

test('paused goals survive normal submissions and cancellation never completes an active goal', async (t) => {
  let entered
  const ready = new Promise((resolve) => (entered = resolve))
  const model = {
    id: 'goal-stop-test',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact' }),
    async *stream(request, signal) {
      const goal = JSON.parse(request.materials.find((m) => m.origin === 'runtime-view').text)
        .partitions.runtime.goal
      if (goal.status === 'paused') yield* done(request)
      else {
        entered()
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        signal.throwIfAborted()
      }
    },
  }
  const { session } = await fixture(t, model)
  await session.updateGoal({ baseRevision: 0, objective: '暂停后保留' })
  await session.controlGoal({ baseRevision: 1, action: 'pause' })
  await Array.fromAsync(session.submit('普通问题'))
  assert.equal((await session.getGoal()).status, 'paused')
  await session.controlGoal({ baseRevision: 2, action: 'resume' })
  const running = Array.fromAsync(session.submit('继续'))
  await ready
  session.cancel()
  await running
  assert.equal((await session.getGoal()).status, 'active')
  const removed = await session.execute({
    source: `import {goal} from 'velaros:system';await goal.update({baseRevision:3,status:'removed'});`,
  })
  assert.match(removed.result.failed.message, /status 只能是/)
  assert.equal((await session.getGoal()).status, 'active')
})

test('INV-78 automatic done waits for domain verification and publishes goal, task and reports in the same CAS', async (t) => {
  let checks = 0
  const f = await verificationFixture(
    t,
    async (session) => {
      assert.equal((await session.getGoal()).status, 'active')
      const verified = ++checks === 2
      return {
        verified,
        reason: verified ? '产物能打开' : '产物损坏',
        report: checkReport(verified ? 'passed' : 'failed'),
      }
    },
    async function* (_session, request) {
      yield* doneWith(request, '产物已完成')
    }
  )
  const atomic = f.storage.compareAndSwapMetadata.bind(f.storage)
  let completedTransactions = 0
  f.storage.compareAndSwapMetadata = async (id, version, next, append) => {
    if (
      append?.some((record) => record.title === 'session:goal') &&
      next.task?.status === 'completed'
    ) {
      completedTransactions++
      assert(append.some((record) => record.title.startsWith('task:completion:')))
      assert.equal((await f.session.getGoal()).status, 'active')
      assert.notEqual((await f.storage.loadMetadata(id)).task.status, 'completed')
    }
    return atomic(id, version, next, append)
  }
  const events = await Array.fromAsync(f.session.submit('完成并核查'))
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(checks, 2)
  assert.equal(completedTransactions, 1)
  assert.equal((await f.session.getGoal()).status, 'complete')
  const state = await f.storage.load('goal')
  const records = state.records.filter((record) => record.title.startsWith('task:completion:'))
  assert.equal(records.length, 2)
  const first = JSON.parse(await f.storage.get('goal', records[0].objectId))
  const second = JSON.parse(await f.storage.get('goal', records[1].objectId))
  assert.equal(first.result.completed, false)
  assert.equal(second.result.verified, true)
  assert.deepEqual(first.binding, { kind: 'goal', id: f.goal.id, revision: f.goal.revision })
  assert.deepEqual(second.binding, first.binding)
  assert.equal(state.task.completionRef.id, records[1].ref.id)
  await f.runtime.close()
  const reopened = await createRuntime({
    storage: localContextStorage({ path: f.path }),
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
  })
  try {
    const session = await reopened.openSession('goal')
    const task = await session.view.inspect()
    assert.equal((await session.getGoal()).status, 'complete')
    assert.deepEqual(JSON.parse((await session.context.read(task.completionRef)).text), second)
  } finally {
    await reopened.close()
  }
})

test('INV-78 cancelled or rejected verification leaves the automatic done goal active', async (t) => {
  for (const cancel of [false, true]) {
    const f = await verificationFixture(
      t,
      async (session) => {
        assert.equal((await session.getGoal()).status, 'active')
        if (cancel) session.cancel()
        return { verified: false, reason: '打开失败', report: checkReport('failed') }
      },
      async function* (_session, request) {
        yield* doneWith(request, '请求收尾')
      }
    )
    const events = await Array.fromAsync(f.session.submit('检查后收尾'))
    assert.equal(events.at(-1).status, cancel ? 'cancelled' : 'failed')
    assert.equal((await f.session.getGoal()).status, 'active')
    assert.notEqual((await f.session.view.inspect()).status, 'completed')
  }
})

test('INV-78 a goal replaced between verification and completion CAS cannot inherit the old proof', async (t) => {
  let modelCalls = 0
  let checks = 0
  const f = await verificationFixture(
    t,
    async () => {
      checks++
      return { verified: true, reason: '旧产物已核查', report: checkReport('passed') }
    },
    async function* (session, request) {
      if (++modelCalls === 2) session.cancel()
      yield* doneWith(request, '旧目标已完成')
    }
  )
  const atomic = f.storage.compareAndSwapMetadata.bind(f.storage)
  let changed = false
  f.storage.compareAndSwapMetadata = async (id, version, next, append) => {
    if (
      !changed &&
      next.task?.status === 'completed' &&
      append?.some((record) => record.title === 'session:goal')
    ) {
      changed = true
      const old = await f.session.getGoal()
      await f.session.controlGoal({ baseRevision: old.revision, action: 'cancel' })
      const cancelled = await f.session.getGoal()
      await f.session.updateGoal({ baseRevision: cancelled.revision, objective: '新目标' })
    }
    return atomic(id, version, next, append)
  }
  const events = await Array.fromAsync(f.session.submit('核查旧产物'))
  assert.equal(
    events.find((event) => event.type === 'verification').reason.startsWith('GOAL_CHANGED'),
    true
  )
  assert.equal(checks, 1)
  assert.equal((await f.session.getGoal()).objective, '新目标')
  assert.equal((await f.session.getGoal()).status, 'active')
  const state = await f.storage.load('goal')
  assert.notEqual(state.task.status, 'completed')
  assert.equal(
    state.records.some((record) => record.title.startsWith('task:completion:')),
    false
  )
})

test('INV-78 a legal large failed report can recover within a small model window without duplicating raw checks in recovery instructions', async (t) => {
  let checks = 0
  const requests = []
  const report = {
    scope: 's'.repeat(1900),
    checkedAt: new Date().toISOString(),
    checks: Array.from({ length: 4 }, (_, index) => ({
      label: `${index}${'x'.repeat(999)}`,
      status: 'failed',
      artifact: {
        identity: 'a'.repeat(1900),
        revision: 'v'.repeat(900),
        contentHash: 'h'.repeat(900),
      },
    })),
  }
  const f = await verificationFixture(
    t,
    async () => {
      const verified = ++checks > 1
      return {
        verified,
        reason: verified ? '产物已修复' : '修复指定产物',
        report: verified ? checkReport('passed') : report,
      }
    },
    async function* (_session, request) {
      requests.push(request)
      yield* doneWith(request, '产物已完成')
    },
    {
      limits: { contextTokens: 7500, inputTokens: 6500, outputTokens: 512 },
      estimate: async (request) => ({
        tokens: Math.ceil(JSON.stringify(modelRequestEncoder.messages(request)).length / 4),
        precision: 'exact',
        basis: 'deterministic-character-window',
      }),
    }
  )
  const events = await Array.fromAsync(f.session.submit('核查并修复指定产物'))
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(requests.length, 2)
  assert.equal(checks, 2)
  const recovery = requests[1].compiledPrompt.match(/上次完成检查尚未通过：([^。]+)。/)[1]
  const feedback = JSON.parse(recovery)
  assert.equal(feedback.reportAvailable, true)
  assert.equal(Object.hasOwn(feedback, 'report'), false)
  assert.equal(recovery.includes(report.checks[0].artifact.identity), false)
  const state = await f.storage.load('goal')
  const failed = state.records.find((record) => record.title.startsWith('task:completion:'))
  assert.deepEqual(JSON.parse(await f.storage.get('goal', failed.objectId)).result.report, report)
  assert.deepEqual(events.find((event) => event.type === 'verification').report, report)
})

test('INV-78 authorization reset removes old domain report projections while preserving immutable audit facts', async (t) => {
  let checks = 0
  let calls = 0
  const frames = []
  const report = {
    scope: 'PRE_RESET_REPORT_MARKER',
    checkedAt: new Date().toISOString(),
    checks: [{ label: 'old private diagnostic', status: 'failed' }],
  }
  const f = await verificationFixture(
    t,
    async () =>
      ++checks === 1
        ? { verified: false, reason: 'repair previous result', report }
        : { verified: true, reason: 'new result checked' },
    async function* (session, request) {
      frames.push(JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text))
      if (++calls === 2) {
        await session.context.append({ kind: 'audit', title: 'search:history-reset', body: '{}' })
        yield turn(request, { execute: { source: 'export const tick = 1;' } })
        yield { type: 'finish', reason: 'stop' }
      } else yield* doneWith(request, '按当前授权事实收尾')
    }
  )
  const events = await Array.fromAsync(f.session.submit('按当前授权检查产物'))
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(frames.length, 3)
  assert.equal(frames[1].partitions.runtime.verification.scope, report.scope)
  assert.equal(frames[2].partitions.task.goals.length, 0)
  assert.equal(frames[2].partitions.runtime.verification, undefined)
  assert.equal(JSON.stringify(frames[2]).includes(report.scope), false)
  const state = await f.storage.load('goal')
  const original = state.records.find((record) => record.title.startsWith('task:completion:'))
  assert.deepEqual(JSON.parse(await f.storage.get('goal', original.objectId)).result.report, report)
})
