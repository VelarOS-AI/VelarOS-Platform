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

  test('accepts historical model spans and structured failure evidence', () => {
    const baseModelSpan = {
      spanId: 'model-1',
      parentSpanId: 'turn-1',
      runId: 'run-1',
      sessionId: 'session-1',
      name: 'provider-request',
      startedAt: 1,
      endedAt: 2,
      status: 'ok' as const,
      metrics: emptyExecutionSpanMetrics(),
      category: 'model' as const,
      provider: 'airjelly',
      model: 'deepseek/deepseek-v4-pro',
      requestFingerprint: null,
      finishReason: null,
    }
    expect(ExecutionSpanSchema.safeParse(baseModelSpan).success).toBe(true)
    expect(
      ExecutionSpanSchema.safeParse({
        ...baseModelSpan,
        status: 'error',
        errorCode: 'QUOTA_EXCEEDED',
        errorMessage: '模型服务额度已用尽，请补充额度或切换服务商后重试。',
      }).success
    ).toBe(true)
  })
})
