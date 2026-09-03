import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import type { AgentRuntimeInputPort } from '../src/agent/RuntimeInputPort'
import { runSoloBackgroundCompletionGate } from '../src/agent/SoloBackgroundCompletionGate'
import { KernelBackgroundJobManager } from '../src/kernel/background-jobs'

const log = { info: () => undefined }

function createRuntimeInputHarness(): {
  port: AgentRuntimeInputPort
  accept(): void
  takeOrSealCalls(): number
  disposed(): boolean
} {
  let listener: (() => void) | null = null
  let sealCalls = 0
  let wasDisposed = false
  return {
    port: {
      take: () => null,
      takeOrSeal: () => {
        sealCalls += 1
        return { status: 'sealed' }
      },
      onInputAccepted: (next) => {
        listener = next
        return () => {
          wasDisposed = true
          listener = null
        }
      },
    },
    accept: () => listener?.(),
    takeOrSealCalls: () => sealCalls,
    disposed: () => wasDisposed,
  }
}

function baseInput(history: ModelMessage[] = []) {
  return {
    turn: 1,
    history,
    executionAbortSignal: new AbortController().signal,
    emitWaitingPhase: () => undefined,
    log,
  }
}

void describe('solo background completion boundary', () => {
  void test('injects already-arrived terminal context before attempting a wait', async () => {
    const history: ModelMessage[] = []
    let waits = 0
    const result = await runSoloBackgroundCompletionGate({
      ...baseInput(history),
      consumeTurnContextNote: () => '子 Agent A 已完成；请读取 job A。',
      awaitPendingBackgroundJobs: async () => {
        waits += 1
        return true
      },
    })

    assert.deepEqual(result, { status: 'continue', reason: 'late-context' })
    assert.equal(waits, 0)
    assert.deepEqual(history, [
      { role: 'user', content: '子 Agent A 已完成；请读取 job A。' },
    ])
  })

  void test('post-wait drain closes completion-before-wait race even when wait reports no running jobs', async () => {
    const history: ModelMessage[] = []
    let note: string | null = null
    const result = await runSoloBackgroundCompletionGate({
      ...baseInput(history),
      consumeTurnContextNote: () => {
        const current = note
        note = null
        return current
      },
      awaitPendingBackgroundJobs: async () => {
        // 模拟：第一次 drain 后任务完成，manager 调用时已看不到 running。
        note = '子 Agent race 已完成；请读取 job race。'
        return false
      },
    })

    assert.deepEqual(result, { status: 'continue', reason: 'late-context' })
    assert.equal(history.at(-1)?.content, '子 Agent race 已完成；请读取 job race。')
  })

  void test('one terminal job wakes the loop without waiting for every background job', async () => {
    let waitingPhases = 0
    const result = await runSoloBackgroundCompletionGate({
      ...baseInput(),
      awaitPendingBackgroundJobs: async (input) => {
        input?.onWaiting?.()
        return true
      },
      emitWaitingPhase: () => {
        waitingPhases += 1
      },
    })

    assert.deepEqual(result, { status: 'continue', reason: 'background-terminal' })
    assert.equal(waitingPhases, 1)
  })

  void test('registers wait-any synchronously before an already queued completion microtask runs', async () => {
    const manager = new KernelBackgroundJobManager()
    manager.start({ id: 'job-a', sessionId: 'session-1', kind: 'sub-agent', label: 'A' })
    manager.start({ id: 'job-b', sessionId: 'session-1', kind: 'sub-agent', label: 'B' })
    queueMicrotask(() => manager.complete('job-a', { result: 'A done' }))

    const gate = runSoloBackgroundCompletionGate({
      ...baseInput(),
      awaitPendingBackgroundJobs: async (input) =>
        !!(await manager.waitForNextTerminalForSession('session-1', {
          signal: input?.signal,
          onWaiting: input?.onWaiting,
        })),
    })
    const outcome = await Promise.race([
      gate,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    // 若 wait 被推迟一个 microtask，它只会选中 B，本断言将超时。
    assert.notEqual(outcome, 'timeout')
    assert.deepEqual(outcome, { status: 'continue', reason: 'background-terminal' })
    assert.deepEqual(manager.runningForSession('session-1').map((job) => job.id), ['job-b'])
    manager.cancelSession('session-1')
  })

  void test('runtime input interrupts a legacy non-cancellable wait without sealing the input lane', async () => {
    const runtimeInput = createRuntimeInputHarness()
    const result = await runSoloBackgroundCompletionGate({
      ...baseInput(),
      runtimeInput: runtimeInput.port,
      // 旧宿主零参回调：忽略 signal，且自身永不 settle。外层 race 仍必须可唤醒。
      awaitPendingBackgroundJobs: async () => {
        runtimeInput.accept()
        return new Promise<boolean>(() => undefined)
      },
    })

    assert.deepEqual(result, { status: 'interrupted' })
    assert.equal(runtimeInput.takeOrSealCalls(), 0)
    assert.equal(runtimeInput.disposed(), true)
  })

  void test('execution abort interrupts the park rather than reporting ready/completed', async () => {
    const controller = new AbortController()
    const result = await runSoloBackgroundCompletionGate({
      ...baseInput(),
      executionAbortSignal: controller.signal,
      awaitPendingBackgroundJobs: async () => {
        controller.abort('stop')
        return new Promise<boolean>(() => undefined)
      },
    })

    assert.deepEqual(result, { status: 'interrupted' })
  })
})
