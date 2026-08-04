import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { AgentCapabilityEventPublisher } from '../src/kernel/AgentCapabilityEventPublisher'
import {
  AgentCapabilityExecutionEventType,
  createAgentCapabilityExecutionEventEnvelopeV1,
  parseAgentCapabilityExecuteEnvelopeV1,
} from '../src/protocol/agent-capability'

function buildEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: 1,
    execution: {
      id: 'execution-1',
      source: {
        productId: 'velaros.test-host',
        sessionId: 'session-1',
        correlationId: 'correlation-1',
      },
      scopeMetadata: { resourceId: '/project', surface: 'project' },
    },
    messages: [{ role: 'user', content: 'hello' }],
    config: { modelSelection: { provider: 'test', model: 'test-model' } },
    ...overrides,
  }
}

describe('Agent capability wire', () => {
  test('parses and normalizes the public v1 envelope', () => {
    expect(parseAgentCapabilityExecuteEnvelopeV1(buildEnvelope())).toEqual(buildEnvelope())
  })

  test('omits absent optional fields from parsed and emitted wire envelopes', () => {
    const envelope = buildEnvelope() as {
      execution: {
        source: Record<string, unknown>
        scopeMetadata?: Record<string, unknown>
      }
    }
    delete envelope.execution.source.correlationId
    delete envelope.execution.scopeMetadata

    const parsed = parseAgentCapabilityExecuteEnvelopeV1(envelope)
    expect(Object.hasOwn(parsed.execution.source, 'correlationId')).toBe(false)
    expect(Object.hasOwn(parsed.execution, 'scopeMetadata')).toBe(false)

    const event = createAgentCapabilityExecutionEventEnvelopeV1(
      parsed.execution,
      'state',
      { kind: 'done' },
    )
    expect(Object.hasOwn(event, 'sessionCorrelationId')).toBe(false)
  })

  test('rejects unknown keys at every versioned envelope boundary', () => {
    const valid = buildEnvelope() as {
      execution: { source: Record<string, unknown> } & Record<string, unknown>
    } & Record<string, unknown>

    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, execution: { ...valid.execution, extra: true } },
      {
        ...valid,
        execution: {
          ...valid.execution,
          source: { ...valid.execution.source, extra: true },
        },
      },
    ]) {
      expect(() => parseAgentCapabilityExecuteEnvelopeV1(invalid)).toThrow(
        'Agent capability execution input is invalid',
      )
    }
  })

  test('enforces identifiers, message and scope bounds', () => {
    const valid = buildEnvelope() as {
      execution: Record<string, unknown>
    } & Record<string, unknown>

    const tooManyMessages = Array.from({ length: 10_001 }, () => ({
      role: 'user',
      content: 'x',
    }))
    const tooManyScopeKeys = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`key-${index}`, index]),
    )

    for (const invalid of [
      { ...valid, protocolVersion: 2 },
      { ...valid, messages: tooManyMessages },
      {
        ...valid,
        execution: { ...valid.execution, id: ' execution-1' },
      },
      {
        ...valid,
        execution: { ...valid.execution, scopeMetadata: tooManyScopeKeys },
      },
    ]) {
      expect(() => parseAgentCapabilityExecuteEnvelopeV1(invalid)).toThrow(
        'Agent capability execution input is invalid',
      )
    }
  })

  test('fails closed when a caller attempts to inject Host runtime state', () => {
    for (const key of ['abortController', 'execution']) {
      try {
        parseAgentCapabilityExecuteEnvelopeV1(buildEnvelope({ config: { [key]: {} } }))
        throw new Error('expected parser to reject injected runtime state')
      } catch (error) {
        expect(error).toBeInstanceOf(AppError)
        expect((error as AppError).code).toBe('PERMISSION')
      }
    }
  })

  test('publishes the standard correlated event envelope in cross-channel order', async () => {
    const delivered: Array<{ type: string; payload: unknown }> = []
    const parsed = parseAgentCapabilityExecuteEnvelopeV1(buildEnvelope())
    const publisher = new AgentCapabilityEventPublisher(
      async (type, payload) => {
        delivered.push({ type, payload })
      },
      parsed.execution,
      () => undefined,
    )

    expect(publisher.enqueue('agent', { type: 'text-delta', text: 'a' })).toBe(true)
    expect(publisher.enqueue('state', { kind: 'done' })).toBe(true)
    await publisher.closeAndDrain()

    expect(delivered).toEqual([
      {
        type: AgentCapabilityExecutionEventType,
        payload: {
          protocolVersion: 1,
          executionId: 'execution-1',
          sourceProductId: 'velaros.test-host',
          sourceSessionId: 'session-1',
          sessionCorrelationId: 'correlation-1',
          channel: 'agent',
          payload: { type: 'text-delta', text: 'a' },
        },
      },
      {
        type: AgentCapabilityExecutionEventType,
        payload: {
          protocolVersion: 1,
          executionId: 'execution-1',
          sourceProductId: 'velaros.test-host',
          sourceSessionId: 'session-1',
          sessionCorrelationId: 'correlation-1',
          channel: 'state',
          payload: { kind: 'done' },
        },
      },
    ])
  })

  test('continues after delivery failures, drains once, and rejects late events', async () => {
    const delivered: number[] = []
    const failures: unknown[] = []
    const execution = parseAgentCapabilityExecuteEnvelopeV1(buildEnvelope()).execution
    const publisher = new AgentCapabilityEventPublisher(
      async (_type, payload) => {
        const value = (payload as { payload: number }).payload
        if (value === 1) throw new Error('subscriber failed')
        delivered.push(value)
      },
      execution,
      (error) => failures.push(error),
    )

    publisher.enqueue('debug', 1)
    publisher.enqueue('debug', 2)
    const firstDrain = publisher.closeAndDrain()
    expect(publisher.closeAndDrain()).toBe(firstDrain)
    await firstDrain
    expect(publisher.enqueue('debug', 3)).toBe(false)

    expect(failures).toHaveLength(1)
    expect(String(failures[0])).toContain('subscriber failed')
    expect(delivered).toEqual([2])
  })
})
