import { isArray, isBoolean, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentSessionArchiveEnvelope,AgentSessionArchiveEvent } from '../../types/product-session.js'

export const VelarosAgentSessionArchiveFormat = 'velaros.agent-session' as const satisfies AgentSessionArchiveEnvelope<never, never, never>['format']
export const VelarosAgentSessionArchiveSchemaVersion = 1 as const satisfies AgentSessionArchiveEnvelope<never, never, never>['schemaVersion']

/**
 * 把一次会话导出装进带版本号的信封并整体冻结：`format` 与 `schemaVersion` 由本模块常量钉死，
 * `productId` 去空白后必须非空，`productSchemaVersion` 必须是正整数，`exportedAt` 必须能被 `Date.parse` 解析，
 * 不合就抛。`resources`/`events` 各另存一份再冻，导出之后调用方改原数组也反写不进信封。
 */
export function createAgentSessionArchiveEnvelope<TSession, TResource, TEvent>(input: {
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}): AgentSessionArchiveEnvelope<TSession, TResource, TEvent> {
  const productId = requireText(input.productId, '会话归档的 productId')
  if (!Number.isInteger(input.productSchemaVersion) || input.productSchemaVersion <= 0) {
    throw new Error('会话归档的 productSchemaVersion 不合法：必须是大于 0 的整数（产品自己的数据版本号）。')
  }
  if (Number.isNaN(Date.parse(input.exportedAt))) {
    throw new Error('会话归档的 exportedAt 不合法：必须是能被 Date.parse 解析的 ISO 时间戳，形如 2026-08-24T00:00:00.000Z。')
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

/**
 * 读回一份来路不明的归档：逐项校验，任何一项不合就抛，绝不「尽力解析」出半个信封。
 * 校验包括——必须是 JSON 对象；`format`/`schemaVersion` 与本版**完全相等**（既不收旧版本也不做升级）；
 * 传了 `expectedProductId` 就必须一致（挡住把 A 产品的归档导进 B 产品）；`productSchemaVersion` 是正整数；
 * `exportedAt` 可解析；`sanitized` 是布尔；`resources`/`events` 是数组且条数不超上限（默认 1000 / 100000，
 * 上限用于挡住一份超大归档在导入侧把内存吃穿），每条 event 还要过 `isAgentSessionArchiveEvent`。
 * 返回值里 `session`/`resources`/`events` 都是 `structuredClone` 后再冻的副本，与入参不共享任何引用。
 */
export function parseAgentSessionArchiveEnvelope(input: unknown, options: {
  readonly expectedProductId?: string
  readonly maximumResources?: number
  readonly maximumEvents?: number
} = {}): AgentSessionArchiveEnvelope<unknown> {
  if (!isRecord(input)) throw new Error('这份会话归档读不出来：最外层必须是一个 JSON 对象，数组、null、字符串都不收。')
  if (input.format !== VelarosAgentSessionArchiveFormat) {
    throw new Error(`会话归档的 format 不合法：只认 ${VelarosAgentSessionArchiveFormat}，这份写的是 ${String(input.format ?? '缺失')}。`)
  }
  if (input.schemaVersion !== VelarosAgentSessionArchiveSchemaVersion) {
    throw new Error(`会话归档的 schemaVersion 不合法：本版只读 ${VelarosAgentSessionArchiveSchemaVersion}，既不收旧版本也不自动升级，这份写的是 ${String(input.schemaVersion ?? '缺失')}。`)
  }
  const productId = requireText(input.productId, '会话归档的 productId')
  if (options.expectedProductId && productId !== options.expectedProductId) {
    throw new Error(`这份会话归档属于产品 ${productId}，不是 ${options.expectedProductId}：请改到 ${productId} 里导入，或换一份 ${options.expectedProductId} 导出的归档。`)
  }
  if (!Number.isInteger(input.productSchemaVersion) || Number(input.productSchemaVersion) <= 0) {
    throw new Error('会话归档的 productSchemaVersion 不合法：必须是大于 0 的整数（产品自己的数据版本号）。')
  }
  if (!isString(input.exportedAt) || Number.isNaN(Date.parse(input.exportedAt))) {
    throw new Error('会话归档的 exportedAt 不合法：必须是能被 Date.parse 解析的 ISO 时间戳字符串，形如 2026-08-24T00:00:00.000Z。')
  }
  if (!isBoolean(input.sanitized)) throw new Error('会话归档的 sanitized 不合法：只能是 true 或 false，用来标明这份归档有没有脱敏过。')
  if (!isArray(input.resources) || input.resources.length > (options.maximumResources ?? 1_000)) {
    throw new Error(`会话归档的 resources 不合法：必须是数组，且条数不超过 ${options.maximumResources ?? 1_000} 条。`)
  }
  if (
    !isArray(input.events)
    || !input.events.every(isAgentSessionArchiveEvent)
    || input.events.length > (options.maximumEvents ?? 100_000)
  ) {
    throw new Error(`会话归档的 events 不合法：必须是数组，每条都要有字符串 type、数字 createdAt 和 payload 三个字段，且总条数不超过 ${options.maximumEvents ?? 100_000} 条。`)
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

/** 取一个必填文本字段：必须是字符串且去掉首尾空白后非空，否则抛 `${field} 不能为空：…`；返回的是去过空白的值，调用方要用返回值而不是原值。 */
function requireText(value: unknown, field: string): string {
  if (!isString(value) || !value.trim()) throw new Error(`${field} 不能为空：必须是字符串，且去掉首尾空白后仍有内容。`)
  return value.trim()
}

/** 只有普通对象才为真（数组、null、类实例一律为假）。解析外部 JSON 时取字段前的第一道闸，免得在数组或 null 上读属性。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}

/**
 * 一条归档事件的最低要求：普通对象、`type` 是字符串、`createdAt` 是数字，并且 `payload` 这个键**存在**。
 * 只查 payload 在不在、不限制它的值——payload 的形状由各产品自己定义，Platform 这层不认识它。
 */
function isAgentSessionArchiveEvent(value: unknown): value is AgentSessionArchiveEvent {
  return (
    isRecord(value)
    && isString(value.type)
    && isNumber(value.createdAt)
    && 'payload' in value
  )
}
