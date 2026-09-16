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

import { AgentCapabilityEnvelopeLimits } from '../../contract/constants.js'
import type { AgentCapabilityExecutionChannel, AgentCapabilityExecutionDescriptorV1, AgentCapabilityExecutionEventEnvelopeV1,AgentCapabilityExecutionSource } from '../../types/agent.js'
import type { AgentCapabilityExecuteEnvelopeV1 } from '../../types/execution.js'

export const AgentCapabilityProtocolVersion = 1 as const satisfies AgentCapabilityExecuteEnvelopeV1['protocolVersion']

/** Semver axis advertised to mod manifests as `engines.agent`. */
export const AgentCapabilityApiVersion = '1.0.0'
export const AgentCapabilityExecutionEventType = 'velaros.agent.execution' as const

const EnvelopeKeys = new Set(['protocolVersion', 'execution', 'messages', 'config'])
const ExecutionKeys = new Set(['id', 'source', 'scopeMetadata'])
const SourceKeys = new Set(['productId', 'sessionId', 'correlationId'])
const ForbiddenRuntimeConfigKeys = new Set(['abortController', 'execution'])

/**
 * 造这份协议统一的校验失败错误：`VALIDATION` + 一句固定文案。
 * 刻意不带出哪个字段错了——这是跨 mod 的对外边界，错误细节等于把内部形状泄给调用方，
 * 定位靠调用方自己比对协议文档。
 */
function invalidAgentCapabilityInput(): AppError {
  return new AppError('VALIDATION', 'Agent capability 执行入参不合法：请对照协议文档自行核对信封结构、字段名与数量上限，这里不给出具体是哪个字段。')
}

/**
 * 按白名单读一层对象：不是普通对象、或出现任何 `allowedKeys` 之外的键，都抛
 * `invalidAgentCapabilityInput`。**多给的键算错而不是忽略**——这层管的是信封身份字段，
 * 静默丢弃未知键会让新旧协议看起来兼容、实则语义已经漂了。校验通过时返回原对象引用，不拷贝。
 */
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

/**
 * 只要求「是个普通对象」，键随便：用在 `config`、`scopeMetadata` 这类开放字段上，
 * 它们的内容由 Agent 域自己解释，协议层不该替它们冻结键集。不是对象就抛校验失败。
 */
function readRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidAgentCapabilityInput()
  }
  return value
}

/**
 * 读一个有长度上限的标识符（executionId / productId / sessionId / correlationId）：必须是字符串、
 * 非空白、**首尾不带空格**（`value !== value.trim()` 即判错，不替对方 trim——标识符要能按字节比对，
 * 静默归一会让两端各自算出不同的 id）、长度不超过 `maxLength`（默认 512，productId 收到 128）。
 * 任一条不满足就抛校验失败。
 */
function requireBoundedIdentifier(
  value: unknown,
  maxLength: number = AgentCapabilityEnvelopeLimits.maxIdentifierChars,
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
    || envelope.messages.length > AgentCapabilityEnvelopeLimits.maxMessages
  ) {
    throw invalidAgentCapabilityInput()
  }

  const config = readRecord(envelope.config)
  if (Object.keys(config).some((key) => ForbiddenRuntimeConfigKeys.has(key))) {
    throw new AppError(
      'PERMISSION',
      'Agent capability 执行入参不得注入运行时状态：config 里不允许出现 abortController、execution 这类由宿主掌控的键，请把它们从信封里去掉。',
    )
  }

  let scopeMetadata: Nullable<Readonly<Record<string, unknown>>> = null
  if (Object.hasOwn(execution, 'scopeMetadata')) {
    const parsedScopeMetadata = readRecord(execution.scopeMetadata)
    if (Object.keys(parsedScopeMetadata).length > AgentCapabilityEnvelopeLimits.maxScopeMetadataKeys) {
      throw invalidAgentCapabilityInput()
    }
    scopeMetadata = parsedScopeMetadata
  }

  // 线协议里缺席的可选字段不写键：解析结果要能原样再过一遍严格解析，也不能带出 undefined 键。
  const parsedSource: { productId: string; sessionId: string; correlationId?: string } = {
    productId: requireBoundedIdentifier(source.productId, AgentCapabilityEnvelopeLimits.maxProductIdChars),
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

/**
 * 把一次执行中要外发的事件包成 v1 事件信封：带上协议版本、executionId、来源 productId / sessionId、
 * 事件 channel 与原样透传的 payload（本函数不解释 payload 形状）。
 * 只有来源带 `correlationId` 时才多出 `sessionCorrelationId` 键——缺席就不写键，保证信封能原样再过一遍
 * 严格解析，也不会把 `undefined` 值送上线。
 */
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
