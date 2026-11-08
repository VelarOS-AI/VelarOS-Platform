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

import type { ProviderFingerprintValue } from '../types/compiler.js'

/**
 * 造一个带类型标签的审计值 `{ $velarosType, value }`，保存 JSON 不能直接表达的 bigint、bytes、date、url、undefined 与非有限数。
 * 两个键的形状属于内容指纹的编码约定。
 */
function tagged(type: string, value: string): ProviderFingerprintValue {
  return { $velarosType: type, value }
}

/**
 * 为本次内容指纹稳定编码真实 provider 输入。二进制、URL、日期和 bigint 都带类型标签；
 * 普通对象按键排序，因此同一份模型可见输入在不同进程中产生同一字节序。
 */
export function encodeProviderFingerprintValue(
  value: unknown,
  seen: Set<object> = new Set()
): ProviderFingerprintValue {
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
  if (value instanceof Uint8Array)
    return tagged('bytes', encodeBytes(value instanceof Uint8Array ? value : new Uint8Array(value)))
  if (value instanceof ArrayBuffer)
    return tagged('bytes', encodeBytes(value instanceof Uint8Array ? value : new Uint8Array(value)))
  if (!isObject(value)) {
    throw new AppError(
      'INVARIANT',
      '模型请求包含未登记的原始值类型，无法形成稳定指纹。',
      undefined,
      {
        source: 'provider-request-audit-serialization',
      }
    )
  }
  if (seen.has(value)) {
    throw new AppError('INVARIANT', '模型请求包含循环引用，无法形成稳定指纹。', undefined, {
      source: 'provider-request-audit-serialization',
    })
  }
  seen.add(value)
  try {
    if (isArray(value)) return value.map((item) => encodeProviderFingerprintValue(item, seen))
    if (!isPlainObject(value)) {
      throw new AppError(
        'INVARIANT',
        '模型请求包含未登记的对象类型，无法形成稳定指纹。',
        undefined,
        {
          source: 'provider-request-audit-serialization',
          constructor: value.constructor?.name ?? 'unknown',
        }
      )
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, encodeProviderFingerprintValue(value[key], seen)])
    )
  } finally {
    seen.delete(value)
  }
}

/** 使用标准 Web API 编码字节，避免宿主 Buffer 进入可移植请求图。 */
function encodeBytes(value: Uint8Array): string {
  let text = ''
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text)
}
