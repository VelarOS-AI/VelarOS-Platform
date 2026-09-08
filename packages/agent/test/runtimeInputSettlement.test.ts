import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { createAgentRuntimeInputInterruptScope } from '../src/agent/RuntimeInputPort'
import { consumeSoloRuntimeGuidance } from '../src/agent/SoloRuntimeGuidance'
import { ExecutionGuidanceQueue } from '../src/execution/GuidanceQueue'

function userMessage(content: string): ModelMessage {
  return { role: 'user', content }
}

void describe('runtime input settlement', () => {
  void test('drains accepted guidance FIFO exactly once before sealing', async () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:fifo'
    const first = userMessage('first')
    const second = userMessage('second')
    const history: ModelMessage[] = []
    const runtimeInput = queue.port(executionId)

    assert.deepEqual(queue.enqueue(executionId, first), { status: 'accepted' })
    assert.deepEqual(queue.enqueue(executionId, second), { status: 'accepted' })

    assert.deepEqual(
      await consumeSoloRuntimeGuidance({
        turn: 1,
        phase: 'before-complete',
        history,
        runtimeInput,
        log: { info: () => undefined, warn: () => undefined },
      }),
      { consumed: true, reason: 'user-guidance' },
    )
    assert.deepEqual(
      await consumeSoloRuntimeGuidance({
        turn: 2,
        phase: 'turn-start',
        history,
        runtimeInput,
        log: { info: () => undefined, warn: () => undefined },
      }),
      { consumed: true, reason: 'user-guidance' },
    )
    assert.deepEqual(
      await consumeSoloRuntimeGuidance({
        turn: 2,
        phase: 'before-complete',
        history,
        runtimeInput,
        log: { info: () => undefined, warn: () => undefined },
      }),
      { consumed: false, reason: 'none' },
    )

    assert.deepEqual(history, [first, second])
    assert.deepEqual(queue.finalize(executionId), { status: 'sealed' })
  })

  void test('accept-before-seal is consumed and seal-before-enqueue is structured closed', () => {
    const acceptedQueue = new ExecutionGuidanceQueue()
    const acceptedId = 'execution:accepted-before-seal'
    const acceptedMessage = userMessage('accepted')
    acceptedQueue.port(acceptedId)

    assert.deepEqual(acceptedQueue.enqueue(acceptedId, acceptedMessage), {
      status: 'accepted',
    })
    assert.deepEqual(acceptedQueue.port(acceptedId).takeOrSeal(), {
      status: 'input',
      message: acceptedMessage,
    })
    assert.deepEqual(acceptedQueue.port(acceptedId).takeOrSeal(), {
      status: 'sealed',
    })

    const sealedQueue = new ExecutionGuidanceQueue()
    const sealedId = 'execution:sealed-before-enqueue'
    assert.deepEqual(sealedQueue.port(sealedId).takeOrSeal(), {
      status: 'sealed',
    })
    assert.deepEqual(sealedQueue.enqueue(sealedId, userMessage('too late')), {
      status: 'closed',
      reason: 'execution-settled',
    })
  })

  void test('finalization exposes accepted pending input instead of clearing it', () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:pending'
    queue.port(executionId)

    assert.deepEqual(queue.enqueue(executionId, userMessage('must settle')), {
      status: 'accepted',
    })
    assert.deepEqual(queue.finalize(executionId), {
      status: 'pending',
      pendingCount: 1,
    })
    assert.deepEqual(queue.enqueue(executionId, userMessage('too late')), {
      status: 'closed',
      reason: 'execution-settled',
    })
    assert.deepEqual(queue.clear(executionId), {
      status: 'retained',
      pendingCount: 1,
    })
    assert.equal(queue.consume(executionId)?.role, 'user')
    assert.deepEqual(queue.finalize(executionId), { status: 'sealed' })
    assert.deepEqual(queue.clear(executionId), { status: 'cleared' })
  })

  void test('adoption receipts fire on consumption and cancellation retains only unconsumed identities', async () => {
    const queue = new ExecutionGuidanceQueue()
    const port = queue.port('execution')
    const adopted: string[] = []
    for (const inputId of ['first', 'second']) {
      queue.enqueue('execution', userMessage(inputId), { inputId, sourceSessionId: 'session', onConsumed: () => { adopted.push(inputId) } })
    }
    assert.deepEqual(adopted, [])
    assert.deepEqual(queue.takeRetainedInputIds('session'), [])
    const history: ModelMessage[] = []
    await consumeSoloRuntimeGuidance({ turn: 1, phase: 'turn-start', history, runtimeInput: port, log: { info() {}, warn() {} } })
    assert.deepEqual(history, [userMessage('first')])
    assert.deepEqual(adopted, ['first'])
    queue.finalize('execution')
    queue.clear('execution')
    assert.deepEqual(queue.takeRetainedInputIds('unrelated'), [])
    assert.deepEqual(queue.takeRetainedInputIds('session'), ['second'])
    assert.deepEqual(queue.takeRetainedInputIds('session'), [])
    assert.deepEqual(adopted, ['first'])
  })

  void test('rejects invalid input without opening an accepted lane', () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:invalid'

    assert.deepEqual(
      queue.enqueue(executionId, { role: 'assistant', content: 'no' }),
      {
        status: 'invalid',
        reason: 'empty-or-non-user-message',
      }
    )
    assert.deepEqual(queue.port(executionId).takeOrSeal(), { status: 'sealed' })
  })

  void test('newly accepted guidance interrupts an active provider-turn scope', () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:interrupt-active-turn'
    const interrupt = createAgentRuntimeInputInterruptScope(queue.port(executionId))

    assert.equal(interrupt.signal.aborted, false)
    assert.deepEqual(queue.enqueue(executionId, userMessage('stop searching')), {
      status: 'accepted',
    })
    assert.equal(interrupt.signal.aborted, true)
    assert.equal(queue.consume(executionId)?.role, 'user')

    interrupt.dispose()
  })

  void test('pending guidance closes the drain-to-request race immediately', () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:interrupt-before-subscribe'
    queue.port(executionId)

    assert.deepEqual(queue.enqueue(executionId, userMessage('use existing evidence')), {
      status: 'accepted',
    })

    const interrupt = createAgentRuntimeInputInterruptScope(queue.port(executionId))
    assert.equal(interrupt.signal.aborted, true)
    interrupt.dispose()
  })

  void test('late producers and retained ports cannot reopen a cleared execution', () => {
    const queue = new ExecutionGuidanceQueue()
    const executionId = 'execution:cleared'
    const port = queue.port(executionId)
    assert.deepEqual(port.takeOrSeal(), { status: 'sealed' })
    assert.deepEqual(queue.clear(executionId), { status: 'cleared' })

    const unsubscribe = port.onInputAccepted(() => assert.fail('closed lane notified'))
    assert.deepEqual(port.takeOrSeal(), { status: 'sealed' })
    assert.deepEqual(queue.finalize(executionId), { status: 'sealed' })
    assert.deepEqual(queue.enqueue(executionId, userMessage('late input')), {
      status: 'closed', reason: 'execution-settled',
    })
    assert.equal(port.take(), null)
    unsubscribe()
  })
})
