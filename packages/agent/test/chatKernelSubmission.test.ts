import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  ChatKernelSessionBridge,
  type KernelChatExecutionService,
} from '../src/kernel/bridge/ChatKernelSessionBridge'
import {
  InMemoryKernelSessionInputStore,
  type KernelSessionInputStore,
} from '../src/kernel/session-lane'
import type { ChatSendRequest } from '../src/protocol'

function gate(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function request(id: string): ChatSendRequest {
  return {
    sessionId: 'session',
    messages: [{ role: 'user', messageId: id, textBlocks: [id], toolCalls: [] }],
  }
}

function createBridge(
  run: (payload: ChatSendRequest) => Promise<void>,
  inputStore?: KernelSessionInputStore,
  abort: () => boolean = () => true,
  guidance: () => Promise<void> = async () => undefined
): ChatKernelSessionBridge<null> {
  const service: KernelChatExecutionService = {
    abortSourceSession: abort,
    provideGuidanceForSourceSession: guidance,
    provideInputForSourceSession() {},
    resolveConfirmationForSourceSession() {},
    hasPendingInteractionForSourceSession: () => false,
    getPendingInteractionForSourceSession: () => null,
    isRunningForSourceSession: () => false,
  }
  return new ChatKernelSessionBridge({
    executionService: service,
    executionCoordinator: { run: (_target, payload) => run(payload) },
    inputStore,
  })
}

describe('kernel chat submission receipts', () => {
  test('confirms the host receipt before execution, including input-free continuations', async () => {
    for (const payload of [request('with-input'), { sessionId: 'session', messages: [] }]) {
      const order: string[] = []
      const bridge = createBridge(async () => { order.push('run') })
      const receipt = bridge.submit(null, payload, () => { order.push('accepted') })
      await receipt.completed
      assert.deepEqual(order, ['accepted', 'run'])
    }
  })

  test('failed admission leaves the host receipt unconsumed', async () => {
    const memory = new InMemoryKernelSessionInputStore()
    memory.admit = async () => { throw new Error('admission failed') }
    let consumed = false
    const bridge = createBridge(async () => assert.fail('unadmitted input ran'), memory)
    const receipt = bridge.submit(null, request('rejected-context'), () => { consumed = true })
    await assert.rejects(receipt.accepted, /admission failed/u)
    await assert.rejects(receipt.completed, /admission failed/u)
    assert.equal(consumed, false)
  })

  test('cancellation during admission does not consume a late host receipt', async () => {
    const memory = new InMemoryKernelSessionInputStore()
    const admit = memory.admit.bind(memory)
    const pending = gate()
    memory.admit = async (input) => {
      await pending.promise
      return admit(input)
    }
    let consumed = false
    const bridge = createBridge(async () => assert.fail('cancelled input ran'), memory)
    const receipt = bridge.submit(null, request('cancelled-context'), () => { consumed = true })
    await bridge.cancel('session')
    pending.resolve()
    await assert.rejects(receipt.accepted, /cancelled/u)
    await assert.rejects(receipt.completed, /cancelled/u)
    await Promise.resolve()
    assert.equal(consumed, false)
  })

  test('host receipt failure prevents execution and rejects both promises', async () => {
    for (const payload of [request('with-input'), { sessionId: 'session', messages: [] }]) {
      const bridge = createBridge(async () => assert.fail('unconfirmed input ran'))
      const receipt = bridge.submit(null, payload, () => { throw new Error('receipt failed') })
      await assert.rejects(receipt.accepted, /receipt failed/u)
      await assert.rejects(receipt.completed, /receipt failed/u)
    }
  })

  test('out-of-order admission can be cancelled without waiting for the blocked first input', async () => {
    const memory = new InMemoryKernelSessionInputStore()
    const admit = memory.admit.bind(memory)
    const releaseFirst = gate()
    memory.admit = async (input) => {
      if (input.id === 'blocked-first') await releaseFirst.promise
      return admit(input)
    }
    let consumed = 0
    const bridge = createBridge(async () => assert.fail('cancelled input ran'), memory)
    const first = bridge.submit(null, request('blocked-first'), () => { consumed += 1 })
    const second = bridge.submit(null, request('admitted-second'), () => { consumed += 1 })
    await second.accepted
    try {
      await bridge.cancel('session')
      await assert.rejects(first.accepted, /cancelled/u)
      await assert.rejects(first.completed, /cancelled/u)
      await assert.rejects(second.completed, /cancelled/u)
      assert.equal(consumed, 1)
    } finally {
      releaseFirst.resolve()
    }
    await Promise.resolve()
    assert.equal(consumed, 1)
  })

  test('accepts before completion and keeps per-input completion across coalesced wakes and guidance', async () => {
    const firstRun = gate()
    const secondRun = gate()
    const thirdRun = gate()
    const started = [gate(), gate(), gate()]
    const runs: string[] = []
    let steers = 0
    const bridge = createBridge(
      async (payload) => {
        runs.push(payload.messages[0]!.messageId!)
        const index = runs.length - 1
        started[index]!.resolve()
        await [firstRun, secondRun, thirdRun][index]!.promise
      },
      undefined,
      () => true,
      async () => {
        steers += 1
      }
    )
    const first = bridge.submit(null, request('one'))
    await first.accepted
    await started[0]!.promise
    const second = bridge.submit(null, request('two'))
    const third = bridge.submit(null, request('three'))
    await Promise.all([second.accepted, third.accepted])
    let secondCompleted = false
    void second.completed.then(() => {
      secondCompleted = true
    })
    await bridge.provideGuidance(
      { sessionId: 'session', message: request('steer').messages[0]! },
      { role: 'user', content: 'steer' }
    )
    assert.equal(steers, 1)
    assert.equal(secondCompleted, false)
    firstRun.resolve()
    await first.completed
    await started[1]!.promise
    assert.deepEqual(runs, ['one', 'two'])
    assert.equal(secondCompleted, false)
    secondRun.resolve()
    await second.completed
    await started[2]!.promise
    thirdRun.resolve()
    await third.completed
    assert.deepEqual(runs, ['one', 'two', 'three'])
  })

  test('send remains admission-only while submit reports execution failure', async () => {
    const finish = gate()
    const started = gate()
    const bridge = createBridge(async () => {
      started.resolve()
      await finish.promise
      throw new Error('run failed')
    })
    const receipt = bridge.submit(null, request('failure'))
    await receipt.accepted
    await started.promise
    finish.resolve()
    await assert.rejects(receipt.completed, /run failed/u)
    const secondFinish = gate()
    const second = createBridge(async () => secondFinish.promise)
    await second.send(null, request('legacy'))
    secondFinish.resolve()
  })

  test('queued cancellation rejects its completion and drains the active run before returning', async () => {
    const active = gate()
    const started = gate()
    const runs: string[] = []
    const bridge = createBridge(
      async (payload) => {
        runs.push(payload.messages[0]!.messageId!)
        started.resolve()
        await active.promise
      },
      undefined,
      () => {
        active.resolve()
        return true
      }
    )
    const first = bridge.submit(null, request('active'))
    await first.accepted
    await started.promise
    const queued = bridge.submit(null, request('cancelled'))
    await queued.accepted
    await bridge.cancel('session')
    await first.completed
    await assert.rejects(queued.completed, /cancelled/u)
    assert.deepEqual(runs, ['active'])
  })

  test('cancellation waits for real execution cleanup and returns pending input identities', async () => {
    const entered = gate()
    const cleanup = gate()
    let requested = false
    const bridge = createBridge(async () => { entered.resolve(); await cleanup.promise }, undefined, () => { requested = true; return true })
    const first = bridge.submit(null, request('active'))
    await entered.promise
    const pending = bridge.submit(null, request('retained'))
    await pending.accepted
    let settled = false
    const cancelling = bridge.cancel('session').then((receipt) => { settled = true; return receipt })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    assert.equal(requested, true)
    assert.equal(settled, false)
    cleanup.resolve()
    const receipt = await cancelling
    await first.completed
    await assert.rejects(pending.completed, /cancelled/u)
    assert.deepEqual(receipt.retainedInputIds, ['retained'])
  })

  test('rejects both receipts on failed admission without executing the request', async () => {
    const memory = new InMemoryKernelSessionInputStore()
    const inputStore: KernelSessionInputStore = {
      admit: async () => {
        throw new Error('admission failed')
      },
      list: (id) => memory.list(id),
      countPending: (id) => memory.countPending(id),
      promoteSteers: (id, options) => memory.promoteSteers(id, options),
      promoteNextQueued: (id) => memory.promoteNextQueued(id),
      cancel: (id, inputId) => memory.cancel(id, inputId),
      dropSession: (id) => memory.dropSession(id),
    }
    const bridge = createBridge(async () => assert.fail('unadmitted input ran'), inputStore)
    const receipt = bridge.submit(null, request('rejected'))
    await assert.rejects(receipt.accepted, /admission failed/u)
    await assert.rejects(receipt.completed, /admission failed/u)
  })

  test('cancel during input preparation prevents the host from starting', async () => {
    const memory = new InMemoryKernelSessionInputStore()
    const preparing = gate()
    const release = gate()
    const inputStore: KernelSessionInputStore = {
      admit: (input) => memory.admit(input),
      list: (id) => memory.list(id),
      countPending: (id) => memory.countPending(id),
      promoteSteers: async (id, options) => {
        preparing.resolve()
        await release.promise
        return memory.promoteSteers(id, options)
      },
      promoteNextQueued: (id) => memory.promoteNextQueued(id),
      cancel: (id, inputId) => memory.cancel(id, inputId),
      dropSession: (id) => memory.dropSession(id),
    }
    const bridge = createBridge(async () => assert.fail('cancelled preparation ran'), inputStore)
    const receipt = bridge.submit(null, request('preparing'))
    await receipt.accepted
    await preparing.promise
    const cancelling = bridge.cancel('session')
    release.resolve()
    await cancelling
    await assert.rejects(receipt.completed, /cancelled before starting/u)
  })
})
