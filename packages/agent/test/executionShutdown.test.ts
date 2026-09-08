import { describe, expect, spyOn, test } from 'bun:test'

import { ExecutionStore } from '../src/execution/Store'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import { ExecutionService } from '../src/kernel/execution/ExecutionService'
import { AgentModSeamDispatcher } from '../src/mods/AgentModSeams'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness(seams?: AgentModSeamDispatcher) {
  const store = new ExecutionStore()
  const closed = spyOn(store, 'disposeAsync')
  const service = new ExecutionService(
    { getExecutionResourceId: () => null, getActiveResourceId: () => null },
    { beginExecutionSession: () => () => undefined },
    {
      authGate: { assertAuthenticated: () => undefined },
      executionRecordsPath: {
        getExecutionRecordsPath: () => {
          throw new Error('in-memory test')
        },
      },
      store,
      seams,
    }
  )
  return { service, closed }
}

describe('execution shutdown ownership', () => {
  test('cancels active execution and waits for actual cleanup before closing its store', async () => {
    const { service, closed } = harness()
    const cleanup = deferred()
    let signal: AbortSignal | undefined
    const run = service.runManagedExecution({
      sourceSessionId: 'active',
      messages: [],
      events: ExecutionEventBus.noop(),
      run: async ({ abortController }) => {
        signal = abortController.signal
        await cleanup.promise
      },
    })
    const shutdown = service.disposeAsync()
    try {
      await Promise.resolve()
      expect(signal?.aborted).toBe(true)
      expect(closed).not.toHaveBeenCalled()
      expect(service.disposeAsync()).toBe(shutdown)
    } finally {
      cleanup.resolve()
      await run
      await shutdown
    }
    expect(closed).toHaveBeenCalledTimes(1)
    expect((await run).status).toBe('aborted')
    await expect(
      service.runManagedExecution({
        sourceSessionId: 'late',
        messages: [],
        events: ExecutionEventBus.noop(),
        run: async () => {
          throw new Error('must never enter')
        },
      })
    ).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
  })

  test('does not admit a late start hook and waits for its paired end hook', async () => {
    const seams = new AgentModSeamDispatcher()
    const preparing = deferred()
    const ending = deferred()
    const ended = deferred()
    spyOn(seams, 'dispatchSessionLifecycle').mockImplementation(async (event) => {
      if (event.phase === 'start') await preparing.promise
      else {
        ended.resolve()
        await ending.promise
      }
    })
    const { service, closed } = harness(seams)
    let executed = false
    const run = service.runManagedExecution({
      sourceSessionId: 'preparing',
      messages: [],
      events: ExecutionEventBus.noop(),
      run: async () => {
        executed = true
      },
    })
    const outcome = run.then(
      () => null,
      (error: unknown) => error
    )
    const shutdown = service.disposeAsync()
    preparing.resolve()
    await ended.promise
    try {
      expect(executed).toBe(false)
      expect(closed).not.toHaveBeenCalled()
    } finally {
      ending.resolve()
      await outcome
      await shutdown
    }
    expect(await outcome).toMatchObject({ code: 'EXECUTION_ABORTED' })
    expect(closed).toHaveBeenCalledTimes(1)
  })
})
