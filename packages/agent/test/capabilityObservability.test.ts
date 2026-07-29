import { describe, expect, test } from 'bun:test'

import {
  ExecutionSpanRecorder,
  projectExecutionSpanDebug,
} from '../src/kernel/observability'
import type { ExecutionSpan } from '../src/protocol'

describe('capability observability', () => {
  test('records and projects opaque capability observations without product semantics', () => {
    const spans: ExecutionSpan[] = []
    let nextId = 0
    const recorder = new ExecutionSpanRecorder({
      emit: (span) => spans.push(span),
      nextSpanId: () => `span-${++nextId}`,
      now: () => 1,
    })

    recorder.record({
      category: 'capability',
      parentSpanId: null,
      runId: null,
      sessionId: 'session-1',
      name: 'operation-observed',
      capabilityId: 'example.capability',
      operationId: 'example.operation',
      metadata: { opaqueRef: 'ref-1', accepted: true },
    })

    expect(projectExecutionSpanDebug(spans).capabilityObservations).toEqual([
      {
        capabilityId: 'example.capability',
        operationId: 'example.operation',
        metadata: { opaqueRef: 'ref-1', accepted: true },
        latencyMs: 0,
        at: 1,
      },
    ])
  })
})
