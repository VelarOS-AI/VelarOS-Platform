import { expect, test } from 'bun:test'

import type {
  InvocationJournal,
  OperationDefinition,
  OperationRuntimeOptions,
} from '../src/contract/requires.js'
import { createOperationRuntime } from '../src/impl/runtime/OperationRuntime.js'
import type { InvocationRecord, OperationSurface } from '../src/types/operations.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fixture(
  operation: Partial<OperationDefinition> = {},
  beforeDispatch?: OperationRuntimeOptions['beforeDispatch'],
  surface?: OperationSurface
) {
  const records = new Map<string, InvocationRecord>()
  const journal: InvocationJournal = {
    recordReconciliation: async () => {},
    claim: async (prepared) => {
      const prior = records.get(prepared.id)
      if (prior) return prior
      records.set(prepared.id, { phase: 'reserved', prepared })
      return null
    },
    prepare: async (prepared) => {
      records.set(prepared.id, { phase: 'prepared', prepared })
    },
    settle: async (receipt) => {
      records.set(receipt.invocation.id, {
        phase: 'settled',
        prepared: receipt.invocation,
        receipt,
      })
    },
    read: async (_session, id) => records.get(id) ?? null,
  }
  let disposed = false
  const runtime = createOperationRuntime({
    journal,
    beforeDispatch,
    modules: [
      {
        binding: {
          moduleId: 'test:lifecycle',
          instanceId: 'one',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'fixture',
        surface,
        operations: {
          run: {
            summary: 'run',
            input: { type: 'null' },
            output: { type: 'null' },
            effects: 'write',
            run: () => null,
            ...operation,
          },
        },
        dispose: () => {
          disposed = true
        },
      },
    ],
  })
  const call = {
    id: 'call',
    sessionId: 's',
    executionId: 'e',
    binding: runtime.bind('s', 'test:lifecycle'),
    operation: 'run',
    input: null,
  }
  return { runtime, records, call, journal, disposed: () => disposed }
}

for (const phase of ['prepare', 'beforeDispatch', 'handler'] as const)
  test(`INV-26 ${phase} ignores abort: caller stops, physical work remains pending, close is bounded`, async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let runs = 0
    const hold = async () => {
      entered.resolve()
      await release.promise
      return null
    }
    const f = fixture(
      {
        ...(phase === 'prepare' ? { prepare: hold } : {}),
        run: async (_input, context) => {
          runs++
          if (phase === 'handler') await hold()
          context.recordEffect('committed')
          return null
        },
      },
      phase === 'beforeDispatch'
        ? async () => {
            await hold()
          }
        : undefined
    )
    const controller = new AbortController()
    let state = 'pending'
    const observed = f.runtime.invoke(f.call, controller.signal).then(
      () => {
        state = 'resolved'
      },
      () => {
        state = 'rejected'
      }
    )
    try {
      await entered.promise
      controller.abort()
      await tick()
      expect(state).toBe('rejected')
      expect(f.records.get('call')?.phase).toBe(phase === 'handler' ? 'prepared' : 'reserved')
      expect(f.runtime.pending()).toMatchObject([{ id: 'call', phase, cancelRequested: true }])
      await expect(f.runtime.dispose({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
      expect(f.disposed()).toBe(false)
      await expect(f.runtime.invoke({ ...f.call, id: 'new' })).rejects.toMatchObject({
        code: 'CLOSED',
      })
    } finally {
      release.resolve()
      await observed
      await f.runtime.dispose()
    }
    expect(f.runtime.pending()).toEqual([])
    expect(f.disposed()).toBe(true)
    const receipt = f.records.get('call')?.receipt
    expect(receipt?.effect).toBe(phase === 'handler' ? 'committed' : 'none')
    expect(Boolean(receipt?.lifecycle?.startedAt)).toBe(phase === 'handler')
    expect(receipt?.lifecycle?.reservedAt).toBeTruthy()
    expect(receipt?.lifecycle?.settledAt).toBeTruthy()
    expect(runs).toBe(phase === 'handler' ? 1 : 0)
  })

test('INV-27 modes in generated and mounted contracts must agree as sets', async () => {
  const descriptor = {
    summary: 'run',
    input: { type: 'null' },
    output: { type: 'null' },
    effects: 'write',
    hasInput: true,
  } as const
  const surface: OperationSurface = {
    specifier: 'test:lifecycle',
    namespace: 'test',
    methods: ['run'],
    declarations: '',
    template: '',
    revision: '1',
    operations: { run: { ...descriptor, allowedModes: ['execute'] } },
  }
  for (const allowedModes of [undefined, ['observe'], ['execute', 'observe']] as const)
    expect(() => fixture({ allowedModes }, undefined, surface)).toThrow(
      '生成合同与运行时操作不一致'
    )
  for (const allowedModes of [[], ['execute', 'execute'], ['invalid']] as const)
    expect(() =>
      fixture({ allowedModes: allowedModes as OperationDefinition['allowedModes'] })
    ).toThrow()
  const same = fixture({ allowedModes: ['observe', 'execute'] }, undefined, {
    ...surface,
    operations: { run: { ...descriptor, allowedModes: ['execute', 'observe'] } },
  })
  await same.runtime.dispose()
  const implicit = fixture({}, undefined, {
    ...surface,
    operations: { run: { ...descriptor, allowedModes: ['execute', 'observe'] } },
  })
  await implicit.runtime.dispose()
})

test('INV-26 cancellation alone preserves late partial/committed failure and idempotent replay', async () => {
  for (const effect of ['partial', 'committed'] as const) {
    const entered = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    const f = fixture({
      run: async (_input, context) => {
        calls++
        entered.resolve()
        await release.promise
        context.recordEffect(effect)
        throw new Error('late failure')
      },
    })
    const controller = new AbortController()
    const result = f.runtime.invoke(f.call, controller.signal).catch(() => null)
    await entered.promise
    controller.abort()
    await result
    expect(f.records.get('call')?.receipt).toBeUndefined()
    release.resolve()
    while (f.runtime.pending().length) await tick()
    const receipt = f.records.get('call')!.receipt!
    expect(receipt.effect).toBe(effect)
    expect(receipt.lifecycle?.startedAt).toBeTruthy()
    expect(await f.runtime.invoke(f.call)).toEqual(receipt)
    expect(calls).toBe(1)
    await f.runtime.dispose()
  }
})

test('INV-26 reconciliation also retains resources until a noncooperative read stops', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const f = fixture({
    run: () => {
      throw new Error('unknown write')
    },
    reconcile: async () => {
      entered.resolve()
      await release.promise
      return null
    },
  })
  await f.runtime.invoke(f.call)
  const controller = new AbortController()
  const result = f.runtime.reconcile('s', 'call', controller.signal).catch(() => null)
  await entered.promise
  controller.abort()
  await result
  expect(f.runtime.pending()).toMatchObject([{ phase: 'reconcile', cancelRequested: true }])
  await expect(f.runtime.dispose({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  expect(f.disposed()).toBe(false)
  release.resolve()
  await f.runtime.dispose()
  expect(f.disposed()).toBe(true)
})

test('INV-26 synchronous prepare and authorization failures never dispatch and retain no-effect receipts', async () => {
  for (const phase of ['prepare', 'beforeDispatch'] as const) {
    let runs = 0
    const fail = () => {
      throw new Error('sync refusal')
    }
    const f = fixture(
      {
        ...(phase === 'prepare' ? { prepare: fail } : {}),
        run: () => {
          runs++
          return null
        },
      },
      phase === 'beforeDispatch' ? fail : undefined
    )
    const receipt = await f.runtime.invoke(f.call)
    expect(receipt.effect).toBe('none')
    expect(receipt.outcome).toBe('failed')
    expect(receipt.lifecycle?.startedAt).toBeUndefined()
    expect(runs).toBe(0)
    await f.runtime.dispose()
  }
})

test('INV-26 a late journal failure stays prepared and is reported by close after resources settle', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  const f = fixture({
    run: async (_input, context) => {
      entered.resolve()
      await release.promise
      context.recordEffect('committed')
      return null
    },
  })
  f.journal.settle = async () => {
    throw new Error('settlement storage unavailable')
  }
  const controller = new AbortController()
  const observed = f.runtime.invoke(f.call, controller.signal).catch(() => null)
  await entered.promise
  controller.abort()
  await observed
  const closing = f.runtime.dispose()
  release.resolve()
  await expect(closing).rejects.toThrow('回执持久化失败')
  expect(f.records.get('call')?.phase).toBe('prepared')
  expect(f.records.get('call')?.receipt).toBeUndefined()
  expect(f.runtime.pending()).toEqual([])
  expect(f.disposed()).toBe(true)
})
