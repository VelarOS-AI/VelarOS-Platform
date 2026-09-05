import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import {
  parseGuidanceRelayPlan,
  resolveMainAgentGuidanceDelivery,
  resolveMainAgentGuidanceMessage,
} from '../src/execution/GuidanceRelayPlanner'
import { ExecutionStore } from '../src/execution/Store'
import { SubAgentGuidanceRelayRegistry } from '../src/execution/SubAgentGuidanceRelayRegistry'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import { ExecutionService } from '../src/kernel/execution/ExecutionService'
import type { ExecutionGuidanceRelayPlan } from '../src/kernel/execution/host-ports'
import type { ManagedExecutionController } from '../src/kernel/execution/ManagedExecutionRunner'

const originalMessage: ModelMessage = { role: 'user', content: '顺便把 README 也更新一下' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createServiceHarness() {
  const planned = deferred<ExecutionGuidanceRelayPlan>()
  const registry = new SubAgentGuidanceRelayRegistry()
  const service = new ExecutionService(
    { getExecutionResourceId: () => null, getActiveResourceId: () => null },
    { beginExecutionSession: () => () => undefined },
    {
      authGate: { assertAuthenticated: () => undefined },
      executionRecordsPath: { getExecutionRecordsPath: () => { throw new Error('in-memory test') } },
      store: new ExecutionStore(),
      guidanceRelayRegistry: registry,
      guidanceRelayService: { planRelay: () => planned.promise },
    }
  )
  const start = async () => {
    const ready = deferred<ManagedExecutionController>()
    const finish = deferred<void>()
    const completed = service.runManagedExecution({
      sourceSessionId: 'guidance-lifecycle-session',
      messages: [originalMessage],
      events: ExecutionEventBus.noop(),
      run: async (controller) => {
        ready.resolve(controller)
        await finish.promise
      },
    })
    const controller = await ready.promise
    const worker = registry.registerWorker({
      executionId: controller.execution.id,
      threadId: 'worker', title: 'worker', description: null,
      prompt: 'update README', agentName: 'worker', subagentType: 'default',
    })
    return { controller, worker, completed, finish: () => finish.resolve() }
  }
  const resolveRelay = async () => {
    planned.resolve({
      mainAgentMessage: 'an auxiliary rewrite',
      relays: [{ threadId: 'worker', message: 'relay update' }],
    })
    await planned.promise
  }
  return { service, start, planned, resolveRelay }
}

void describe('ExecutionService guidance lifecycle', () => {
  void test('accepts the original message and preempts immediately while relay planning remains pending', async () => {
    const harness = createServiceHarness()
    const run = await harness.start()
    let accepted = false
    let resolved = false
    const unsubscribe = run.controller.runtimeInput.onInputAccepted(() => { accepted = true })
    const delivery = harness.service.provideGuidanceForSourceSession({
      sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
    }).then(() => { resolved = true })
    try {
      await Promise.resolve()
      assert.equal(accepted, true)
      assert.equal(resolved, true)
      assert.deepEqual(run.controller.runtimeInput.take(), originalMessage)
      await harness.resolveRelay()
      assert.equal(run.worker.consumeRelayedGuidance(), 'relay update')
      assert.equal(run.controller.runtimeInput.take(), null)
    } finally {
      unsubscribe()
      await harness.resolveRelay()
      await delivery
      await run.controller.runtimeInput.take()
      run.finish()
      await run.completed
    }
  })

  void test('drops a late relay after the execution finishes', async () => {
    const harness = createServiceHarness()
    const run = await harness.start()
    await harness.service.provideGuidanceForSourceSession({
      sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
    })
    assert.deepEqual(run.controller.runtimeInput.take(), originalMessage)
    run.finish()
    assert.equal((await run.completed).status, 'completed')
    await harness.resolveRelay()
    assert.equal(run.worker.consumeRelayedGuidance(), null)
    assert.equal(run.controller.runtimeInput.take(), null)
  })

  void test('drops a late relay when another execution owns the same session', async () => {
    const harness = createServiceHarness()
    const first = await harness.start()
    await harness.service.provideGuidanceForSourceSession({
      sessionId: first.controller.execution.sourceSessionId, message: originalMessage,
    })
    assert.deepEqual(first.controller.runtimeInput.take(), originalMessage)
    const replacement = await harness.start()
    try {
      await harness.resolveRelay()
      assert.equal(first.worker.consumeRelayedGuidance(), null)
      assert.equal(replacement.worker.consumeRelayedGuidance(), null)
      assert.equal(replacement.controller.runtimeInput.take(), null)
    } finally {
      first.finish()
      replacement.finish()
      await Promise.all([first.completed, replacement.completed])
    }
  })

  void test('terminal status blocks relay and guidance even before the session guard is released', async () => {
    const harness = createServiceHarness()
    const run = await harness.start()
    try {
      await harness.service.provideGuidanceForSourceSession({
        sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
      })
      assert.deepEqual(run.controller.runtimeInput.take(), originalMessage)
      harness.service.completeExecution(run.controller.execution.id)
      await harness.resolveRelay()
      assert.equal(run.worker.consumeRelayedGuidance(), null)
      await assert.rejects(harness.service.provideGuidanceForSourceSession({
        sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
      }), /没有正在运行/u)
      assert.equal(run.controller.runtimeInput.take(), null)
    } finally {
      run.finish()
      await run.completed
    }
  })

  void test('planner failure does not duplicate an already accepted main-agent message', async () => {
    const harness = createServiceHarness()
    const run = await harness.start()
    try {
      await harness.service.provideGuidanceForSourceSession({
        sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
      })
      harness.planned.reject(new Error('planner offline'))
      await harness.planned.promise.catch(() => undefined)
      assert.deepEqual(run.controller.runtimeInput.take(), originalMessage)
      assert.equal(run.controller.runtimeInput.take(), null)
    } finally {
      run.finish()
      await run.completed
    }
  })

  void test('invalidated authorization prevents a pending relay from reaching workers', async () => {
    const harness = createServiceHarness()
    const run = await harness.start()
    let current = true
    try {
      await harness.service.provideGuidanceForSourceSession({
        sessionId: run.controller.execution.sourceSessionId, message: originalMessage,
      }, { assertCurrent: () => { if (!current) throw new AppError('AUTH', 'revoked') } })
      assert.deepEqual(run.controller.runtimeInput.take(), originalMessage)
      current = false
      await harness.resolveRelay()
      assert.equal(run.worker.consumeRelayedGuidance(), null)
    } finally {
      run.finish()
      await run.completed
    }
  })
})

void describe('sub-agent guidance relay is a pure increment', () => {
  void test('a plan with relays and no mainAgent field still reaches the main agent', () => {
    // 回归：这是最常见的一条路径。旧实现要求遗留布尔 `notifyMainAgent` 为真才回消息，而提示词
    // 只教 mainAgent.mode，模型永远不会填它 → 主控恒收不到用户这句话。
    const plan = parseGuidanceRelayPlan({
      understanding: '用户想让 README 一起更新',
      relays: [{ threadId: 'thread-1', message: '记得同步 README' }],
    })

    assert.ok(resolveMainAgentGuidanceMessage(plan))
  })

  void test('the removed notifyMainAgent boolean can no longer suppress delivery', () => {
    const plan = parseGuidanceRelayPlan({
      understanding: '用户想让 README 一起更新',
      relays: [{ threadId: 'thread-1', message: '记得同步 README' }],
      notifyMainAgent: false,
    })

    assert.ok(resolveMainAgentGuidanceMessage(plan))
  })

  void test('mainAgent.mode "none" drops only the rewrite, never the user message', () => {
    const plan = parseGuidanceRelayPlan({
      understanding: '这句只与子任务有关',
      relays: [{ threadId: 'thread-1', message: '换个搜索词' }],
      mainAgent: { mode: 'none' },
    })

    const rewrite = resolveMainAgentGuidanceMessage(plan)
    assert.equal(rewrite, null)

    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: rewrite,
      originalMessage,
    })
    assert.equal(delivery.kind, 'verbatim')
    assert.deepEqual(delivery.message, originalMessage)
  })

  void test('a blank understanding still delivers the raw user message', () => {
    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: '   ',
      originalMessage,
    })

    assert.equal(delivery.kind, 'verbatim')
    assert.deepEqual(delivery.message, originalMessage)
  })

  void test('a planned rewrite replaces the raw message rather than adding a second one', () => {
    const delivery = resolveMainAgentGuidanceDelivery({
      plannedMainAgentMessage: '[主控补充] 用户想让 README 一起更新',
      originalMessage,
    })

    assert.equal(delivery.kind, 'planned-rewrite')
    assert.deepEqual(delivery.message, {
      role: 'user',
      content: '[主控补充] 用户想让 README 一起更新',
    })
  })
})
