/**
 * 向量派生索引的纯函数：落盘编解码与宽容解析。
 *
 * 落盘形态是**一个 JSON 文件**，向量用 base64 编码的 Float32（比 JSON 数字数组小约一个数量级）。
 * 这份文件是纯派生物：格式随时可换（版本戳对不上就整份重建），因此不需要宽容迁移，解析失败
 * 一律当作没建过。
 */

import { isArray, isBoolean, isNull, isNumber, isString, isUndefined } from '@velaros-ai/core'

import { MemoryVectorIndex } from '../contract/constants'
import type {
  MemoryRecallItem,
  MemoryRecallOptions,
  MemoryVectorIndexRecord,
} from '../types/memory'
import type { PersistedVectorIndex } from '../types/vector'

import { isMemoryVisibleInScope } from './scope'
import { MemoryTuning } from './tuning'

/** 把向量编码成 base64 字符串（Float32 原始字节）。 */
export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 把 base64 字符串解回向量。 */
export function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

/** 解析落盘的向量索引；形状不对或解析失败返回 null（触发完整重建）。 */
export function parsePersistedVectorIndex(raw: string): Nullable<PersistedVectorIndex> {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedVectorIndex>
    if (!isString(parsed?.version) || !isArray(parsed.records)) return null
    return { version: parsed.version, records: parsed.records }
  } catch {
    // arch-guard:silent-catch-ok 向量索引是可重建派生物；损坏时返回 null 触发完整重建。
    return null
  }
}

/** 把落盘记录还原成内存里的索引记录（向量解码，作用域种类按字面还原）。 */
export function toVectorIndexRecords(
  parsed: PersistedVectorIndex,
): Array<{ id: string, scopeType: string, scopeId: string, updatedAt: number, vector: Float32Array }> {
  return parsed.records.map((entry) => ({
    id: entry.id,
    scopeType: entry.scopeType,
    scopeId: entry.scopeId,
    updatedAt: entry.updatedAt,
    vector: decodeVector(entry.vector),
  }))
}

/** 索引记录形状的版本（常量表 MemoryVectorIndex.schemaVersion 的别名）。改了记录字段就 +1——老索引因此自动作废重建。 */
export const MemoryVectorIndexSchemaVersion = MemoryVectorIndex.schemaVersion

/** 把标题、摘要、正文拼成送去嵌入的文本，并按上限截断。 */
export function buildIndexText(title: string, summary: string, body: string): string {
  return [title, summary, body]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, MemoryTuning.vector.maxEmbeddedTextChars)
}

/** 把任意 claim 值变成可嵌入的文本；序列化不了就当空文本，正文仍可继续索引。 */
export function stringifyValue(value: unknown): string {
  if (isString(value)) return value
  if (isNull(value) || isUndefined(value)) return ''
  if (isNumber(value) || isBoolean(value)) return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    // arch-guard:silent-catch-ok 任意元数据无法序列化时使用空文本，向量正文仍可继续索引。
    return ''
  }
}

/**
 * 作用域过滤 —— 与权威层**同一个函数**，不是「同一套语义」的口头承诺。
 *
 * 语义召回如果不认作用域，就会把别的项目的记忆捞进来；这是**隔离**问题，不是相关性问题，
 * 所以它在打分之前就发生。
 */
export function matchesVectorScope(
  record: MemoryVectorIndexRecord,
  options: MemoryRecallOptions,
): boolean {
  return isMemoryVisibleInScope(record, {
    scopeId: options.scopeId,
    workspaceRoot: options.workspaceRoot,
    includeGlobal: options.includeGlobal,
  })
}

/**
 * 指针条目：只有 id / 作用域 / 相似度，**没有内容**。
 *
 * 编排层拿它回权威层 `getItem` 取全文。直接把这个东西当召回结果给用户是错的。
 */
export function toPointerItem(record: MemoryVectorIndexRecord, score: number): MemoryRecallItem {
  return {
    id: record.id,
    claimId: record.id,
    conceptId: record.id,
    conceptType: 'entity',
    predicate: 'memory',
    title: '',
    summary: '',
    value: null,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    confidence: score,
    salience: score,
    activation: 1,
    updatedAt: record.updatedAt,
    snapshotVersion: 0,
    retrievalReason: 'deep',
    evidenceIds: [record.id],
    sourceTypes: [],
    path: [],
  }
}

/** 把一组数字归一化成单位向量；长度为 0 或不可用时返回空向量。 */
export function normalizeVector(values: readonly number[]): Float32Array {
  let sum = 0
  for (const value of values) sum += value * value
  const magnitude = Math.sqrt(sum)
  if (!Number.isFinite(magnitude) || magnitude === 0) return new Float32Array(0)

  const normalized = new Float32Array(values.length)
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = values[index] / magnitude
  }
  return normalized
}

/** 两个已归一化向量的点积 = 余弦相似度。维度不符按最短的算（换模型的索引本就该重建）。 */
export function dot(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
  return sum
}

/** 把同步或异步可迭代统一成异步可迭代，调用方只写一种循环。 */
export async function* toAsyncIterable<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<T>
    return
  }
  yield* source as Iterable<T>
}
