import { expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { InvocationJournal, OperationDefinition } from '../src/contract/requires.js'
import { createOperationRuntime } from '../src/impl/runtime/OperationRuntime.js'
import type { InvocationRecord } from '../src/types/operations.js'
import { KernelTuning } from '../src/utils/tuning.js'

function fixture(run: OperationDefinition['run']) {
  const records = new Map<string, InvocationRecord>()
  const journal: InvocationJournal = {
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
    read: async (_sessionId, id) => records.get(id) ?? null,
  }
  const runtime = createOperationRuntime({
    journal,
    modules: [
      {
        binding: {
          moduleId: 'test:diagnostic',
          instanceId: 'd',
          generation: 1,
          schemaRevision: '1',
        },
        summary: 'diagnostic fixture',
        operations: {
          run: {
            summary: 'run',
            input: { type: 'null' },
            output: { type: 'null' },
            effects: 'write',
            run,
          },
        },
      },
    ],
  })
  const call = {
    id: 'call',
    sessionId: 's',
    executionId: 'e',
    binding: runtime.bind('s', 'test:diagnostic'),
    operation: 'run',
    input: null,
  }
  return { runtime, call }
}

test('INV-25 diagnostic is immutable, bounded and replayed without changing success or repeating effects', async () => {
  let effects = 0
  const diagnostic = { code: 'DOMAIN_LOG', message: 'observed'.repeat(1000) }
  const original = diagnostic.message
  const { runtime, call } = fixture((_input, context) => {
    effects++
    context.recordEffect('committed')
    context.recordDiagnostic?.(diagnostic)
    diagnostic.message = 'mutated'
    return null
  })
  try {
    const result = await runtime.invoke(call)
    expect(result.outcome).toBe('succeeded')
    expect(result.effect).toBe('committed')
    expect(result.value).toBeNull()
    expect(result.diagnostic).toEqual({
      code: 'DOMAIN_LOG',
      message: original.slice(0, KernelTuning.operationDiagnosticMessageChars),
      truncated: true,
    })
    expect(Object.isFrozen(result.diagnostic)).toBe(true)
    expect(await runtime.invoke(call)).toEqual(result)
    expect(effects).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('INV-25 diagnostics survive a later handler or output-validation failure with the real effect', async () => {
  for (const failure of ['throw', 'schema']) {
    const { runtime, call } = fixture((_input, context) => {
      context.recordDiagnostic?.({ code: 'DOMAIN_LOG', message: 'before failure' })
      context.recordEffect('partial')
      if (failure === 'throw') throw new AppError('UNAVAILABLE', 'handler failed')
      return 123
    })
    try {
      const result = await runtime.invoke(call)
      expect(result.outcome).toBe('failed')
      expect(result.effect).toBe('partial')
      expect(result.error?.code).toBe(failure === 'throw' ? 'UNAVAILABLE' : 'OUTPUT_SCHEMA')
      expect(result.diagnostic).toEqual({ code: 'DOMAIN_LOG', message: 'before failure' })
    } finally {
      await runtime.dispose()
    }
  }
})
