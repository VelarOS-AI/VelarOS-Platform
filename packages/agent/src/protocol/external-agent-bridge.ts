import { z } from 'zod'

/**
 * External Agent Bridge transport version.
 *
 * This is the wire version shared by any bridge host and external agent client.
 * It is intentionally independent from any concrete host or extension client, and
 * from the higher-level agent capability protocol.
 */
export const ExternalAgentBridgeProtocolVersion = 2 as const

export const ExternalAgentBridgeMessageType = {
  Probe: 'probe',
  Hello: 'hello',
  Pair: 'pair',
  Paired: 'paired',
  Resume: 'resume',
  Resumed: 'resumed',
  Ping: 'ping',
  Pong: 'pong',
  Ack: 'ack',
  Event: 'event',
  EventAck: 'event_ack',
  Command: 'command',
  Disconnect: 'disconnect',
  Disconnected: 'disconnected',
  Error: 'error',
} as const

export const ExternalAgentBridgeClientMessageTypes = Object.freeze([
  ExternalAgentBridgeMessageType.Probe,
  ExternalAgentBridgeMessageType.Pair,
  ExternalAgentBridgeMessageType.Resume,
  ExternalAgentBridgeMessageType.Ping,
  ExternalAgentBridgeMessageType.Ack,
  ExternalAgentBridgeMessageType.Event,
  ExternalAgentBridgeMessageType.Disconnect,
] as const)

export const ExternalAgentBridgeHostMessageTypes = Object.freeze([
  ExternalAgentBridgeMessageType.Hello,
  ExternalAgentBridgeMessageType.Paired,
  ExternalAgentBridgeMessageType.Resumed,
  ExternalAgentBridgeMessageType.Pong,
  ExternalAgentBridgeMessageType.EventAck,
  ExternalAgentBridgeMessageType.Command,
  ExternalAgentBridgeMessageType.Disconnected,
  ExternalAgentBridgeMessageType.Error,
] as const)

/**
 * Serializable transport descriptor used to generate dependency-free clients.
 * Keep this plain-data only: classic workers and non-TypeScript hosts vendor it.
 */
export const ExternalAgentBridgeProtocolDescriptor = Object.freeze({
  id: 'velaros-external-agent-bridge',
  transportVersion: ExternalAgentBridgeProtocolVersion,
  service: 'velaros-external-agent',
  socketPath: '/v1/external-agent/ws',
  clientMessageTypes: ExternalAgentBridgeClientMessageTypes,
  hostMessageTypes: ExternalAgentBridgeHostMessageTypes,
})

const VersionSchema = z.literal(ExternalAgentBridgeProtocolVersion)
const NonNegativeIntegerSchema = z.number().int().nonnegative()
const JsonRecordSchema = z.record(z.string(), z.unknown())

export const ExternalAgentBridgeCommandSchema = z.strictObject({
  sequence: NonNegativeIntegerSchema,
  type: z.string().min(1),
  payload: JsonRecordSchema,
})
export type ExternalAgentBridgeCommand = z.infer<typeof ExternalAgentBridgeCommandSchema>

export const ExternalAgentBridgeProbeSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Probe),
})

export const ExternalAgentBridgeHelloSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Hello),
  service: z.string().min(1),
  protocol: VersionSchema,
  pairingAvailable: z.boolean(),
  deviceId: z.string().min(1).nullable(),
})

export const ExternalAgentBridgePairSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Pair),
  code: z.string().min(1),
  provider: z.string().min(1),
  capabilities: z.unknown(),
  tabUrl: z.string().min(1),
  modelLabel: z.string().nullable(),
  providerSnapshot: z.unknown().nullable(),
})

export const ExternalAgentBridgePairedSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Paired),
  token: z.string().min(1),
  device: JsonRecordSchema,
})

export const ExternalAgentBridgeResumeSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Resume),
  token: z.string().min(1),
  deviceId: z.string().min(1),
  after: NonNegativeIntegerSchema,
})

export const ExternalAgentBridgeResumedSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Resumed),
  device: JsonRecordSchema,
  after: NonNegativeIntegerSchema,
})

export const ExternalAgentBridgePingSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Ping),
})

export const ExternalAgentBridgePongSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Pong),
  at: NonNegativeIntegerSchema,
})

export const ExternalAgentBridgeAckSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Ack),
  sequence: NonNegativeIntegerSchema,
})

export const ExternalAgentBridgeEventSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Event),
  eventId: z.string().min(1),
  event: JsonRecordSchema,
})

export const ExternalAgentBridgeEventAckSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.EventAck),
  eventId: z.string().min(1),
})

export const ExternalAgentBridgeCommandMessageSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Command),
  command: ExternalAgentBridgeCommandSchema,
})

export const ExternalAgentBridgeDisconnectSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Disconnect),
})

export const ExternalAgentBridgeDisconnectedSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Disconnected),
})

export const ExternalAgentBridgeErrorSchema = z.strictObject({
  version: VersionSchema,
  type: z.literal(ExternalAgentBridgeMessageType.Error),
  code: z.string().min(1),
  error: z.string().min(1),
})

export const ExternalAgentBridgeClientMessageSchema = z.discriminatedUnion('type', [
  ExternalAgentBridgeProbeSchema,
  ExternalAgentBridgePairSchema,
  ExternalAgentBridgeResumeSchema,
  ExternalAgentBridgePingSchema,
  ExternalAgentBridgeAckSchema,
  ExternalAgentBridgeEventSchema,
  ExternalAgentBridgeDisconnectSchema,
])
export type ExternalAgentBridgeClientMessage = z.infer<
  typeof ExternalAgentBridgeClientMessageSchema
>

export const ExternalAgentBridgeHostMessageSchema = z.discriminatedUnion('type', [
  ExternalAgentBridgeHelloSchema,
  ExternalAgentBridgePairedSchema,
  ExternalAgentBridgeResumedSchema,
  ExternalAgentBridgePongSchema,
  ExternalAgentBridgeEventAckSchema,
  ExternalAgentBridgeCommandMessageSchema,
  ExternalAgentBridgeDisconnectedSchema,
  ExternalAgentBridgeErrorSchema,
])
export type ExternalAgentBridgeHostMessage = z.infer<typeof ExternalAgentBridgeHostMessageSchema>

export const ExternalAgentBridgeMessageSchema = z.union([
  ExternalAgentBridgeClientMessageSchema,
  ExternalAgentBridgeHostMessageSchema,
])
export type ExternalAgentBridgeMessage = z.infer<typeof ExternalAgentBridgeMessageSchema>

export function parseExternalAgentBridgeClientMessage(
  value: unknown
): ExternalAgentBridgeClientMessage {
  return ExternalAgentBridgeClientMessageSchema.parse(value)
}

export function parseExternalAgentBridgeHostMessage(
  value: unknown
): ExternalAgentBridgeHostMessage {
  return ExternalAgentBridgeHostMessageSchema.parse(value)
}
