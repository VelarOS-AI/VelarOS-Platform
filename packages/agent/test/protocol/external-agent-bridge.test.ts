import { describe, expect, test } from 'bun:test'

import {
  ExternalAgentBridgeClientMessageSchema,
  ExternalAgentBridgeClientMessageTypes,
  ExternalAgentBridgeHostMessageSchema,
  ExternalAgentBridgeHostMessageTypes,
  ExternalAgentBridgeMessageType,
  ExternalAgentBridgeProtocolDescriptor,
  ExternalAgentBridgeProtocolVersion,
} from '../../src/protocol/external-agent-bridge'

describe('External Agent Bridge wire protocol', () => {
  test('accepts the versioned pair and command envelopes', () => {
    expect(
      ExternalAgentBridgeClientMessageSchema.parse({
        version: ExternalAgentBridgeProtocolVersion,
        type: ExternalAgentBridgeMessageType.Pair,
        code: '123456',
        provider: 'provider.example',
        capabilities: ['chat'],
        tabUrl: 'https://example.test/',
        modelLabel: null,
        providerSnapshot: null,
      }).type
    ).toBe('pair')

    expect(
      ExternalAgentBridgeHostMessageSchema.parse({
        version: ExternalAgentBridgeProtocolVersion,
        type: ExternalAgentBridgeMessageType.Command,
        command: {
          sequence: 1,
          type: 'invoke',
          payload: { callId: 'call-1' },
        },
      }).type
    ).toBe('command')
  })

  test('rejects stale versions and undeclared fields', () => {
    expect(
      ExternalAgentBridgeClientMessageSchema.safeParse({
        version: 1,
        type: ExternalAgentBridgeMessageType.Ack,
        sequence: 1,
      }).success
    ).toBe(false)

    expect(
      ExternalAgentBridgeClientMessageSchema.safeParse({
        version: ExternalAgentBridgeProtocolVersion,
        type: ExternalAgentBridgeMessageType.Ack,
        sequence: 1,
        desktopOnly: true,
      }).success
    ).toBe(false)
  })

  test('keeps the serializable descriptor aligned with the schemas', () => {
    expect(ExternalAgentBridgeProtocolDescriptor).toEqual({
      id: 'velaros-external-agent-bridge',
      transportVersion: 2,
      service: 'velaros-external-agent',
      socketPath: '/v1/external-agent/ws',
      clientMessageTypes: ExternalAgentBridgeClientMessageTypes,
      hostMessageTypes: ExternalAgentBridgeHostMessageTypes,
    })
    expect(
      ExternalAgentBridgeClientMessageSchema.options.map((schema) => schema.shape.type.value)
    ).toEqual([...ExternalAgentBridgeProtocolDescriptor.clientMessageTypes])
    expect(
      ExternalAgentBridgeHostMessageSchema.options.map((schema) => schema.shape.type.value)
    ).toEqual([...ExternalAgentBridgeProtocolDescriptor.hostMessageTypes])
  })
})
