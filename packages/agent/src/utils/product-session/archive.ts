import { isArray, isBoolean, isNumber, isPlainObject, isString } from '@velaros-ai/core'

export const VelarosAgentSessionArchiveFormat = 'velaros.agent-session' as const
export const VelarosAgentSessionArchiveSchemaVersion = 1 as const

export interface AgentSessionArchiveEvent<TPayload = unknown> {
  readonly type: string
  readonly payload: TPayload
  readonly createdAt: number
}

/**
 * Product-neutral portable Session envelope. Product schema remains an explicit inner version and
 * payload; Platform owns identity, sanitation provenance, timestamp, and bounded collection shape.
 */
export interface AgentSessionArchiveEnvelope<TSession, TResource = unknown, TEvent = AgentSessionArchiveEvent> {
  readonly format: typeof VelarosAgentSessionArchiveFormat
  readonly schemaVersion: typeof VelarosAgentSessionArchiveSchemaVersion
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}

export function createAgentSessionArchiveEnvelope<TSession, TResource, TEvent>(input: {
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}): AgentSessionArchiveEnvelope<TSession, TResource, TEvent> {
  const productId = requireText(input.productId, 'Session archive productId')
  if (!Number.isInteger(input.productSchemaVersion) || input.productSchemaVersion <= 0) {
    throw new Error('Session archive productSchemaVersion must be a positive integer.')
  }
  if (Number.isNaN(Date.parse(input.exportedAt))) {
    throw new Error('Session archive exportedAt must be an ISO timestamp.')
  }
  return Object.freeze({
    format: VelarosAgentSessionArchiveFormat,
    schemaVersion: VelarosAgentSessionArchiveSchemaVersion,
    productId,
    productSchemaVersion: input.productSchemaVersion,
    exportedAt: input.exportedAt,
    sanitized: input.sanitized,
    session: input.session,
    resources: Object.freeze([...input.resources]),
    events: Object.freeze([...input.events]),
  })
}

export function parseAgentSessionArchiveEnvelope(input: unknown, options: {
  readonly expectedProductId?: string
  readonly maximumResources?: number
  readonly maximumEvents?: number
} = {}): AgentSessionArchiveEnvelope<unknown> {
  if (!isRecord(input)) throw new Error('Session archive must be a JSON object.')
  if (input.format !== VelarosAgentSessionArchiveFormat) {
    throw new Error(`Unsupported Session archive format: ${String(input.format ?? 'missing')}`)
  }
  if (input.schemaVersion !== VelarosAgentSessionArchiveSchemaVersion) {
    throw new Error(`Unsupported Session archive schema version: ${String(input.schemaVersion ?? 'missing')}`)
  }
  const productId = requireText(input.productId, 'Session archive productId')
  if (options.expectedProductId && productId !== options.expectedProductId) {
    throw new Error(`Session archive belongs to product ${productId}, not ${options.expectedProductId}.`)
  }
  if (!Number.isInteger(input.productSchemaVersion) || Number(input.productSchemaVersion) <= 0) {
    throw new Error('Session archive productSchemaVersion must be a positive integer.')
  }
  if (!isString(input.exportedAt) || Number.isNaN(Date.parse(input.exportedAt))) {
    throw new Error('Session archive exportedAt must be an ISO timestamp.')
  }
  if (!isBoolean(input.sanitized)) throw new Error('Session archive sanitized must be boolean.')
  if (!isArray(input.resources) || input.resources.length > (options.maximumResources ?? 1_000)) {
    throw new Error(`Session archive resources exceed the ${options.maximumResources ?? 1_000} entry limit.`)
  }
  if (
    !isArray(input.events)
    || !input.events.every(isAgentSessionArchiveEvent)
    || input.events.length > (options.maximumEvents ?? 100_000)
  ) {
    throw new Error(`Session archive events exceed the ${options.maximumEvents ?? 100_000} entry limit.`)
  }
  return Object.freeze({
    format: VelarosAgentSessionArchiveFormat,
    schemaVersion: VelarosAgentSessionArchiveSchemaVersion,
    productId,
    productSchemaVersion: Number(input.productSchemaVersion),
    exportedAt: input.exportedAt,
    sanitized: input.sanitized,
    session: structuredClone(input.session),
    resources: Object.freeze(structuredClone(input.resources)),
    events: Object.freeze(structuredClone(input.events)),
  })
}

function requireText(value: unknown, field: string): string {
  if (!isString(value) || !value.trim()) throw new Error(`${field} cannot be empty.`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

function isAgentSessionArchiveEvent(value: unknown): value is AgentSessionArchiveEvent {
  return (
    isRecord(value)
    && isString(value.type)
    && isNumber(value.createdAt)
    && 'payload' in value
  )
}
