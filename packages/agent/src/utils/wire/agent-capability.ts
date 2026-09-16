// 域：Agent capability 的版本化执行 wire；Kernel 只路由，不解释这份领域信封。
import type { ModelMessage } from 'ai'

import {
  isArray,
  isBlank,
  isNotNull,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentCapabilityExecutionChannel, AgentCapabilityExecutionDescriptorV1, AgentCapabilityExecutionEventEnvelopeV1,AgentCapabilityExecutionSource } from '../../types/agent.js'
import type { AgentCapabilityExecuteEnvelopeV1 } from '../../types/execution.js'

export const AgentCapabilityProtocolVersion = 1 as const satisfies AgentCapabilityExecuteEnvelopeV1['protocolVersion']

/** Semver axis advertised to mod manifests as `engines.agent`. */
export const AgentCapabilityApiVersion = '1.0.0'
export const AgentCapabilityExecutionEventType = 'velaros.agent.execution' as const

const MaxAgentCapabilityMessages = 10_000
const MaxAgentCapabilityScopeMetadataKeys = 128
const DefaultIdentifierMaxLength = 512

const EnvelopeKeys = new Set(['protocolVersion', 'execution', 'messages', 'config'])
const ExecutionKeys = new Set(['id', 'source', 'scopeMetadata'])
const SourceKeys = new Set(['productId', 'sessionId', 'correlationId'])
const ForbiddenRuntimeConfigKeys = new Set(['abortController', 'execution'])

function invalidAgentCapabilityInput(): AppError {
  return new AppError('VALIDATION', 'Agent capability execution input is invalid')
}

function readStrictRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidAgentCapabilityInput()
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw invalidAgentCapabilityInput()
  }
  return value
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidAgentCapabilityInput()
  }
  return value
}

function requireBoundedIdentifier(
  value: unknown,
  maxLength = DefaultIdentifierMaxLength,
): string {
  if (
    !isString(value)
    || isBlank(value)
    || value !== value.trim()
    || value.length > maxLength
  ) {
    throw invalidAgentCapabilityInput()
  }
  return value
}

/**
 * 在 Agent domain 的唯一入口严格解析 capability v1 请求。
 *
 * 消息内容仍由实际 Agent loop 解释；这里验证传输容器、数量上限和身份边界，避免协议层
 * 因某个 provider 新增 content part 而抢先冻结模型消息全集。
 */
export function parseAgentCapabilityExecuteEnvelopeV1(
  input: unknown,
): AgentCapabilityExecuteEnvelopeV1 {
  const envelope = readStrictRecord(input, EnvelopeKeys)
  if (envelope.protocolVersion !== AgentCapabilityProtocolVersion) {
    throw invalidAgentCapabilityInput()
  }

  const execution = readStrictRecord(envelope.execution, ExecutionKeys)
  const source = readStrictRecord(execution.source, SourceKeys)
  if (
    !isArray(envelope.messages)
    || envelope.messages.length > MaxAgentCapabilityMessages
  ) {
    throw invalidAgentCapabilityInput()
  }

  const config = readRecord(envelope.config)
  if (Object.keys(config).some((key) => ForbiddenRuntimeConfigKeys.has(key))) {
    throw new AppError(
      'PERMISSION',
      'Agent capability execution input cannot inject runtime state',
    )
  }

  let scopeMetadata: Nullable<Readonly<Record<string, unknown>>> = null
  if (Object.hasOwn(execution, 'scopeMetadata')) {
    const parsedScopeMetadata = readRecord(execution.scopeMetadata)
    if (Object.keys(parsedScopeMetadata).length > MaxAgentCapabilityScopeMetadataKeys) {
      throw invalidAgentCapabilityInput()
    }
    scopeMetadata = parsedScopeMetadata
  }

  // 线协议里缺席的可选字段不写键：解析结果要能原样再过一遍严格解析，也不能带出 undefined 键。
  const parsedSource: { productId: string; sessionId: string; correlationId?: string } = {
    productId: requireBoundedIdentifier(source.productId, 128),
    sessionId: requireBoundedIdentifier(source.sessionId),
  }
  if (Object.hasOwn(source, 'correlationId')) {
    parsedSource.correlationId = requireBoundedIdentifier(source.correlationId)
  }
  const parsedExecution: {
    id: string
    source: AgentCapabilityExecutionSource
    scopeMetadata?: Readonly<Record<string, unknown>>
  } = {
    id: requireBoundedIdentifier(execution.id),
    source: parsedSource,
  }
  if (isNotNull(scopeMetadata)) parsedExecution.scopeMetadata = scopeMetadata

  return {
    protocolVersion: AgentCapabilityProtocolVersion,
    execution: parsedExecution,
    messages: envelope.messages as ModelMessage[],
    config,
  }
}

export function createAgentCapabilityExecutionEventEnvelopeV1(
  execution: AgentCapabilityExecutionDescriptorV1,
  channel: AgentCapabilityExecutionChannel,
  payload: unknown,
): AgentCapabilityExecutionEventEnvelopeV1 {
  const envelope = {
    protocolVersion: AgentCapabilityProtocolVersion,
    executionId: execution.id,
    sourceProductId: execution.source.productId,
    sourceSessionId: execution.source.sessionId,
    channel,
    payload,
  }
  if (isPresent(execution.source.correlationId))
    return { ...envelope, sessionCorrelationId: execution.source.correlationId }
  return envelope
}
