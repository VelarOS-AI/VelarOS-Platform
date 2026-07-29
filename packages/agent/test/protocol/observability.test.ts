import { describe, expect, test } from 'bun:test'

import {
  CapabilitySpanSchema,
  emptyExecutionSpanMetrics,
  ExecutionSpanCategorySchema,
  ExecutionSpanSchema,
} from '../../src/protocol/observability'

const capabilitySpan = {
  spanId: 'span-1',
  parentSpanId: null,
  runId: null,
  sessionId: 'session-1',
  name: 'operation-observed',
  startedAt: 1,
  endedAt: 2,
  status: 'ok' as const,
  metrics: emptyExecutionSpanMetrics(),
  category: 'capability' as const,
  capabilityId: 'example.capability',
  operationId: 'example.operation',
  metadata: {
    opaqueRef: 'ref-1',
    accepted: true,
  },
}

describe('execution observability protocol', () => {
  test('keeps capability observations product-neutral and opaque', () => {
    expect(CapabilitySpanSchema.parse(capabilitySpan)).toEqual(capabilitySpan)
    expect(ExecutionSpanSchema.parse(capabilitySpan)).toEqual(capabilitySpan)
    expect(ExecutionSpanCategorySchema.options).toContain('capability')
    expect(ExecutionSpanCategorySchema.options).not.toContain('memory')
  })

  test('rejects the retired concrete memory span contract', () => {
    expect(
      ExecutionSpanSchema.safeParse({
        ...capabilitySpan,
        category: 'memory',
        operation: 'recall',
        ref: 'ref-1',
        found: true,
      }).success
    ).toBe(false)
  })
})
