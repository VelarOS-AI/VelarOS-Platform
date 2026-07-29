import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

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
})
