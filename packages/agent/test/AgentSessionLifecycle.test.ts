import { describe, expect, test } from 'bun:test'

import {
  AgentSessionLeaseConflictError,
  createAgentSessionArchiveEnvelope,
  isTerminalAgentBackgroundState,
  normalizeAgentSessionListLimit,
  parseAgentSessionArchiveEnvelope,
  resolveAgentSessionLeaseClaim,
} from '../src/session'

describe('Agent Session application lifecycle', () => {
  test('keeps a live lease owner and allows dead-owner recovery', () => {
    const current = {
      sessionId: 'session-1',
      ownerId: 'owner-a',
      ownerPid: 41,
      acquiredAt: 10,
      heartbeatAt: 20,
    }
    expect(() => resolveAgentSessionLeaseClaim(
      current,
      { sessionId: 'session-1', ownerId: 'owner-b', ownerPid: 42 },
      () => true,
      100,
      'TestHost'
    )).toThrow(AgentSessionLeaseConflictError)
    expect(resolveAgentSessionLeaseClaim(
      current,
      { sessionId: 'session-1', ownerId: 'owner-b', ownerPid: 42 },
      () => false,
      100
    )).toEqual({
      sessionId: 'session-1',
      ownerId: 'owner-b',
      ownerPid: 42,
      acquiredAt: 100,
      heartbeatAt: 100,
    })
  })

  test('owns common detached terminal states and catalog limit bounds', () => {
    expect(isTerminalAgentBackgroundState('running')).toBe(false)
    expect(isTerminalAgentBackgroundState('completed')).toBe(true)
    expect(isTerminalAgentBackgroundState('interrupted')).toBe(true)
    expect(normalizeAgentSessionListLimit(0)).toBe(1)
    expect(normalizeAgentSessionListLimit(2_000)).toBe(1_000)
  })

  test('owns the portable archive envelope while leaving product payload opaque', () => {
    const archive = createAgentSessionArchiveEnvelope({
      productId: 'termel',
      productSchemaVersion: 1,
      exportedAt: '2026-08-24T00:00:00.000Z',
      sanitized: true,
      session: { id: 'session-1', productMode: 'plan' },
      resources: [],
      events: [{ type: 'message.created', payload: { text: '[redacted]' }, createdAt: 1 }],
    })

    expect(parseAgentSessionArchiveEnvelope(archive, { expectedProductId: 'termel' }))
      .toMatchObject({ format: 'velaros.agent-session', productId: 'termel', sanitized: true })
    expect(() => parseAgentSessionArchiveEnvelope(archive, { expectedProductId: 'desktop' }))
      .toThrow('belongs to product termel')
  })
})
