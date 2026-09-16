import { z } from 'zod'

import { ExternalAgentBridgeProtocol } from '../../contract/constants.js'
import type { ExternalAgentBridgeClientMessage, ExternalAgentBridgeCommand } from '../../types/agent.js'
import type { ExternalAgentBridgeHostMessage, ExternalAgentBridgeMessage } from '../../types/connectors.js'

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
  id: ExternalAgentBridgeProtocol.id,
  transportVersion: ExternalAgentBridgeProtocolVersion,
  service: ExternalAgentBridgeProtocol.service,
  socketPath: ExternalAgentBridgeProtocol.socketPath,
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
}) satisfies z.ZodType<ExternalAgentBridgeCommand>
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
]) satisfies z.ZodType<ExternalAgentBridgeClientMessage>
export const ExternalAgentBridgeHostMessageSchema = z.discriminatedUnion('type', [
  ExternalAgentBridgeHelloSchema,
  ExternalAgentBridgePairedSchema,
  ExternalAgentBridgeResumedSchema,
  ExternalAgentBridgePongSchema,
  ExternalAgentBridgeEventAckSchema,
  ExternalAgentBridgeCommandMessageSchema,
  ExternalAgentBridgeDisconnectedSchema,
  ExternalAgentBridgeErrorSchema,
]) satisfies z.ZodType<ExternalAgentBridgeHostMessage>
export const ExternalAgentBridgeMessageSchema = z.union([
  ExternalAgentBridgeClientMessageSchema,
  ExternalAgentBridgeHostMessageSchema,
]) satisfies z.ZodType<ExternalAgentBridgeMessage>
/**
 * 解析**外部 agent 客户端 → 宿主**方向的一条桥消息（probe/pair/resume/ping/ack/event/disconnect）。
 * 走 `strictObject` 判别联合：`version` 对不上、`type` 不在客户端方向的集合里、或多带了未知字段，
 * 一律抛 ZodError（不返回 null，也不静默丢未知字段）——桥两端必须同版本，含糊接收会把版本错配
 * 拖到更深的地方才炸。调用方负责 catch 后按错误回 `error` 消息。
 */
export function parseExternalAgentBridgeClientMessage(
  value: unknown
): ExternalAgentBridgeClientMessage {
  return ExternalAgentBridgeClientMessageSchema.parse(value)
}

/**
 * 解析**宿主 → 外部 agent 客户端**方向的一条桥消息
 * （hello/paired/resumed/pong/event_ack/command/disconnected/error）。
 * 严格程度与客户端方向那条一致：类型走错方向、版本不符、字段多余都抛 ZodError。
 * 两个方向分开解析，是为了让一端永远收不下本该由自己发出的消息类型。
 */
export function parseExternalAgentBridgeHostMessage(
  value: unknown
): ExternalAgentBridgeHostMessage {
  return ExternalAgentBridgeHostMessageSchema.parse(value)
}
