import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { OperationLimits } from '../src/contract/constants.js'
import type {
  InvocationJournal,
  OperationDefinition,
  OperationRuntimeOptions,
} from '../src/contract/requires.js'
import { createOperationRuntime } from '../src/impl/runtime/OperationRuntime.js'
import type {
  InvocationReceipt,
  InvocationRecord,
  OperationSurface,
} from '../src/types/operations.js'

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
  const writes = { claim: [] as string[], prepare: [] as string[], settle: [] as string[] }
  const journal: InvocationJournal = {
    recordReconciliation: async () => {},
    claim: async (prepared) => {
      writes.claim.push(JSON.stringify(prepared))
      const prior = records.get(prepared.id)
      if (prior) return prior
      records.set(prepared.id, { phase: 'reserved', prepared })
      return null
    },
    prepare: async (prepared) => {
      writes.prepare.push(JSON.stringify(prepared))
      records.set(prepared.id, { phase: 'prepared', prepared })
    },
    settle: async (receipt) => {
      writes.settle.push(JSON.stringify(receipt))
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
  return { runtime, records, writes, call, journal, disposed: () => disposed }
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

test('observe payloads and expanded inputs are bounded before journal writes', async () => {
  const large = 'large-observation-payload:'.padEnd(OperationLimits.observationChars * 2, 'x')
  const prepareFailure = new AppError('PREPARE_FAILED', large)
  const dispatchFailure = new AppError('AUTH_FAILED', large)
  let runs = 0
  const f = fixture(
    {
      effects: 'none',
      input: { type: 'string' },
      output: { type: 'string' },
      prepare: (input) => {
        if (input === 'prepare-error') throw prepareFailure
        return input === 'expand-input' ? large : input
      },
      run: (input, context) => {
        runs++
        if (input === 'large-error') throw new AppError('READ_FAILED', large)
        if (input === 'large-attachment') {
          context.attach({
            type: 'image-data',
            mediaType: 'image/png',
            label: 'large',
            data: 'A'.repeat(8192),
          })
          return 'small'
        }
        return large
      },
    },
    (prepared) => {
      if (prepared.input === 'dispatch-error') throw dispatchFailure
    }
  )
  const invoke = (input: string) =>
    f.runtime.invoke({
      ...f.call,
      id: input,
      executionId: input,
      mode: 'observe',
      input,
    })
  try {
    await expect(invoke(large)).rejects.toMatchObject({ code: 'LIMIT' })
    expect(f.writes).toEqual({ claim: [], prepare: [], settle: [] })
    const expanded = await invoke('expand-input')
    expect(expanded).toMatchObject({ outcome: 'failed', effect: 'none', error: { code: 'LIMIT' } })
    expect(expanded.invocation.input).toBe('expand-input')
    expect(expanded.lifecycle?.startedAt).toBeUndefined()
    expect(f.writes.prepare).toHaveLength(0)
    expect(runs).toBe(0)
    for (const input of ['large-result', 'large-attachment']) {
      const receipt = await invoke(input)
      expect(receipt).toMatchObject({ outcome: 'failed', effect: 'none', error: { code: 'LIMIT' } })
      expect(receipt.lifecycle?.startedAt).toBeTruthy()
      expect(receipt.value).toBeUndefined()
      expect(receipt.attachments).toBeUndefined()
    }
    for (const [input, code, total] of [
      ['large-error', 'READ_FAILED', large.length],
      ['prepare-error', 'PREPARE_FAILED', String(prepareFailure).length],
      ['dispatch-error', 'AUTH_FAILED', String(dispatchFailure).length],
    ] as const) {
      const receipt = await invoke(input)
      expect(receipt.error?.code).toBe(code)
      expect(receipt.error?.message).toContain(`[truncated; totalChars=${total}]`)
      expect(receipt.error!.message.length).toBeLessThan(OperationLimits.observationChars)
    }
    expect(runs).toBe(3)
    expect([...f.writes.claim, ...f.writes.prepare, ...f.writes.settle].join('\n')).not.toContain(
      large
    )
    expect(f.writes.settle.join('\n')).not.toContain('A'.repeat(8192))
  } finally {
    await f.runtime.dispose()
  }
})

test('observe execution budgets charge concurrent settlements before storage awaits and leave exec unchanged', async () => {
  const entered = deferred<void>()
  const finish = deferred<void>()
  const settling = deferred<void>()
  const persist = deferred<void>()
  const receipts: InvocationReceipt[] = []
  let runs = 0
  const f = fixture({
    effects: 'none',
    input: { type: 'string' },
    output: { type: 'string' },
    run: async (input, context) => {
      if (context.invocation.mode !== 'observe') return input
      if (++runs === 3) entered.resolve()
      await finish.promise
      return 'x'.repeat(2000)
    },
  })
  const originalSettle = f.journal.settle
  f.journal.settle = async (receipt) => {
    receipts.push(receipt)
    if (receipts.length === 3) settling.resolve()
    if (receipts.length === 1) {
      await persist.promise
    }
    await originalSettle(receipt)
  }
  const firstCall = { ...f.call, id: 'first', input: 'first', mode: 'observe' as const }
  const first = f.runtime.invoke(firstCall)
  const second = f.runtime.invoke({ ...firstCall, id: 'second', input: 'second' })
  const third = f.runtime.invoke({ ...firstCall, id: 'third', input: 'third' })
  try {
    await entered.promise
    finish.resolve()
    await settling.promise
    expect(receipts.filter((receipt) => receipt.error?.code === 'LIMIT')).toHaveLength(1)
    const claims = f.writes.claim.length
    await expect(f.runtime.invoke({ ...firstCall, id: 'after-limit' })).rejects.toMatchObject({
      code: 'LIMIT',
    })
    expect(f.writes.claim).toHaveLength(claims)
    expect(runs).toBe(3)
    persist.resolve()
    const [original] = await Promise.all([first, second, third])
    expect(await f.runtime.invoke(firstCall)).toEqual(original)
    const businessChars = receipts.reduce((sum, receipt) => {
      const { value, observation, attachments, diagnostic } = receipt
      const body = JSON.stringify({ value, observation, attachments, diagnostic })
      return sum + (body === '{}' ? 0 : body.length)
    }, 0)
    expect(businessChars).toBeLessThanOrEqual(OperationLimits.observationChars)
    expect(
      (await f.runtime.invoke({ ...firstCall, id: 'other-execution', executionId: 'other' })).value
    ).toHaveLength(2000)
    expect(
      (
        await f.runtime.invoke({
          ...firstCall,
          id: 'other-session',
          sessionId: 'other',
          binding: f.runtime.bind('other', 'test:lifecycle'),
        })
      ).value
    ).toHaveLength(2000)
    const large = 'exec-result'.padEnd(OperationLimits.observationChars * 2, 'x')
    expect(
      (await f.runtime.invoke({ ...f.call, id: 'exec', mode: 'execute', input: large })).value
    ).toBe(large)
  } finally {
    finish.resolve()
    persist.resolve()
    await Promise.allSettled([first, second, third])
    await f.runtime.dispose()
  }
})

test('observe budget cleanup waits for physical completion and preserves cancelled effect receipts', async () => {
  const entered = deferred<void>()
  const finish = deferred<void>()
  const large = 'cancelled-observation-error'.padEnd(OperationLimits.observationChars * 2, 'x')
  const f = fixture({
    effects: 'write',
    input: { type: 'string' },
    output: { type: 'string' },
    observe: async (input, context) => {
      if (input === 'hold') {
        entered.resolve()
        await finish.promise
        context.recordEffect('partial')
        throw new AppError('READ_FAILED', large)
      }
      context.recordEffect('none')
      return 'x'.repeat(input === 'prime' ? 3000 : 1500)
    },
  })
  const call = { ...f.call, mode: 'observe' as const }
  const cancel = new AbortController()
  let observed: Promise<unknown> | undefined
  try {
    expect((await f.runtime.invoke({ ...call, id: 'prime', input: 'prime' })).value).toHaveLength(
      3000
    )
    observed = f.runtime
      .invoke({ ...call, id: 'hold', input: 'hold' }, cancel.signal)
      .catch(() => null)
    await entered.promise
    cancel.abort()
    await observed
    f.runtime.release('s', 'test:lifecycle')
    f.runtime.bind('s', 'test:lifecycle')
    expect(f.records.get('hold')?.receipt).toBeUndefined()
    finish.resolve()
    while (f.runtime.pending().length) await tick()
    const receipt = f.records.get('hold')!.receipt!
    expect(receipt).toMatchObject({
      outcome: 'cancelled',
      effect: 'partial',
      retry: 'requires-check',
      error: { code: 'CANCELLED' },
    })
    expect(receipt.error?.message).toContain(`[truncated; totalChars=${large.length}]`)
    expect(
      (await f.runtime.invoke({ ...call, id: 'over-budget', input: 'small' })).error?.code
    ).toBe('LIMIT')
    while (f.runtime.pending().length) await tick()
    f.runtime.release('s', 'test:lifecycle')
    f.runtime.bind('s', 'test:lifecycle')
    expect(
      (await f.runtime.invoke({ ...call, id: 'new-lease', input: 'small' })).value
    ).toHaveLength(1500)
  } finally {
    finish.resolve()
    await observed
    await f.runtime.dispose()
  }
})
