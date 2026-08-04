// 域：Agent capability 的版本化执行 wire；Kernel 只路由，不解释这份领域信封。
import type { ModelMessage } from 'ai'

import {
  isArray,
  isBlank,
  isNull,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

export const AgentCapabilityProtocolVersion = 1 as const

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

export type AgentCapabilityExecutionChannel = 'agent' | 'state' | 'debug'

export interface AgentCapabilityExecutionSource {
  readonly productId: string
  readonly sessionId: string
  readonly correlationId?: string
}

export interface AgentCapabilityExecutionDescriptorV1 {
  readonly id: string
  readonly source: AgentCapabilityExecutionSource
  readonly scopeMetadata?: Readonly<Record<string, unknown>>
}

/**
 * `velaros.agent` capability 的公开 v1 请求信封。
 *
 * `config` 保持产品不透明，但禁止注入只应由 Host 创建的运行时对象。各 Host 在这层通用
 * 边界之后，再解析自己的模型选择、权限、空间与 hook 配置。
 */
export interface AgentCapabilityExecuteEnvelopeV1 {
  readonly protocolVersion: typeof AgentCapabilityProtocolVersion
  readonly execution: AgentCapabilityExecutionDescriptorV1
  readonly messages: readonly ModelMessage[]
  readonly config: Readonly<Record<string, unknown>>
}

/** renderer/Host 订阅的统一 Agent 执行事件信封。 */
export interface AgentCapabilityExecutionEventEnvelopeV1 {
  readonly protocolVersion: typeof AgentCapabilityProtocolVersion
  readonly executionId: string
  readonly sourceProductId: string
  readonly sourceSessionId: string
  readonly sessionCorrelationId?: string
  readonly channel: AgentCapabilityExecutionChannel
  readonly payload: unknown
}

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

  const correlationId = Object.hasOwn(source, 'correlationId')
    ? requireBoundedIdentifier(source.correlationId)
    : null

  return {
    protocolVersion: AgentCapabilityProtocolVersion,
    execution: {
      id: requireBoundedIdentifier(execution.id),
      source: {
        productId: requireBoundedIdentifier(source.productId, 128),
        sessionId: requireBoundedIdentifier(source.sessionId),
        ...(isNull(correlationId) ? {} : { correlationId }),
      },
      ...(isNull(scopeMetadata) ? {} : { scopeMetadata }),
    },
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
