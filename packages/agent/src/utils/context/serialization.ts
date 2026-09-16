import { Buffer } from 'node:buffer'

import {
  isArray,
  isBigInt,
  isBoolean,
  isFunction,
  isNull,
  isNumber,
  isObject,
  isPlainObject,
  isString,
  isSymbol,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ProviderRequestAuditValue } from '../../types/context.js'

/**
 * 造一个带类型标签的审计值 `{ $velarosType, value }`，让 JSON 里表达不了的类型（bigint/bytes/date/url/undefined/非有限数）能落盘又能反解。
 * 两个键的形状是与 `decodeProviderRequestAuditValue` 的硬约定：解码端正是靠「恰好这两个键」认出标签值，不能随便加字段。
 */
function tagged(type: string, value: string): ProviderRequestAuditValue {
  return { $velarosType: type, value }
}

/**
 * 把真实 provider 输入变成可稳定落 JSONL、可反解的值。二进制、URL、日期和 bigint 都带类型标签；
 * 普通对象按键排序，因此同一份模型可见输入在不同进程中产生同一字节序。
 */
export function encodeProviderRequestAuditValue(
  value: unknown,
  seen: Set<object> = new Set()
): ProviderRequestAuditValue {
  if (isNull(value)) return null
  if (isString(value) || isBoolean(value)) return value
  if (isNumber(value)) {
    if (!Number.isFinite(value)) return tagged('number', String(value))
    return value
  }
  if (isBigInt(value)) return tagged('bigint', String(value))
  if (isUndefined(value)) return tagged('undefined', '')
  if (isFunction(value) || isSymbol(value)) {
    throw new AppError('INVARIANT', '模型请求包含不可序列化的函数或 symbol。', undefined, {
      source: 'provider-request-audit-serialization',
      valueType: typeof value,
    })
  }
  if (value instanceof URL) return tagged('url', value.toString())
  if (value instanceof Date) return tagged('date', value.toISOString())
  if (value instanceof Uint8Array) return tagged('bytes', Buffer.from(value).toString('base64'))
  if (value instanceof ArrayBuffer) return tagged('bytes', Buffer.from(value).toString('base64'))
  if (!isObject(value)) {
    throw new AppError('INVARIANT', '模型请求包含未登记的原始值类型，无法形成可重建快照。', undefined, {
      source: 'provider-request-audit-serialization',
    })
  }
  if (seen.has(value)) {
    throw new AppError('INVARIANT', '模型请求包含循环引用，无法形成可重建快照。', undefined, {
      source: 'provider-request-audit-serialization',
    })
  }
  seen.add(value)
  try {
    if (isArray(value)) return value.map((item) => encodeProviderRequestAuditValue(item, seen))
    if (!isPlainObject(value)) {
      throw new AppError('INVARIANT', '模型请求包含未登记的对象类型，无法形成可重建快照。', undefined, {
        source: 'provider-request-audit-serialization',
        constructor: value.constructor?.name ?? 'unknown',
      })
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, encodeProviderRequestAuditValue(value[key], seen)])
    )
  } finally {
    seen.delete(value)
  }
}

/**
 * `encodeProviderRequestAuditValue` 的逆操作：把审计快照还原成真实的 provider 输入值。
 * 只有「恰好两个键、$velarosType 与 value 都是字符串」的对象才当标签值解（bigint/bytes/date/number/undefined/url），
 * 其余对象与数组递归还原；标签名不认识时不抛错，退化成按普通对象处理，保证老快照遇到新标签也读得下去。
 */
export function decodeProviderRequestAuditValue(value: ProviderRequestAuditValue): unknown {
  if (isNull(value) || !isObject(value)) return value
  if (isArray(value)) return value.map(decodeProviderRequestAuditValue)
  if (
    isString(value.$velarosType)
    && isString(value.value)
    && Object.keys(value).length === 2
  ) {
    switch (value.$velarosType) {
      case 'bigint': return BigInt(value.value)
      case 'bytes': return Uint8Array.from(Buffer.from(value.value, 'base64'))
      case 'date': return new Date(value.value)
      case 'number': return Number(value.value)
      case 'undefined': return undefined
      case 'url': return new URL(value.value)
      default: break
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decodeProviderRequestAuditValue(item)])
  )
}
