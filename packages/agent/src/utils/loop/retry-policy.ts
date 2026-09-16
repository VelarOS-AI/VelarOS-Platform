// RetryPolicy 用到的纯函数（不碰实例状态）。
import { isBoolean, isPlainObject } from '@velaros-ai/core'
import { isArray, isFunction, isObject, isPresent } from '@velaros-ai/core'

import type { ContextOverflowReplayUnsafeDetails } from '../../types/loop.js'

import { ContextOverflowReplayUnsafeSymbol } from './model-retry-classification'

/** 判断错误现场是不是「上下文溢出且重放不安全」的那一份。 */
export function isContextOverflowReplayUnsafeDetails(
  value: unknown
): value is ContextOverflowReplayUnsafeDetails {
  if (!isPlainObject(value)) return false

  const record = value
  return isBoolean(record.hasVisibleOutput) && isBoolean(record.hasToolUse)
}

/** 给一个溢出错误打上「重放不安全」的现场标记（本轮已有可见输出或工具副作用）。 */
export function markContextOverflowReplayUnsafe(
  error: unknown,
  details: ContextOverflowReplayUnsafeDetails
): unknown {
  if (!isObject(error) && !isFunction(error)) return error

  Reflect.set(error as Record<PropertyKey, unknown>, ContextOverflowReplayUnsafeSymbol, details)
  return error
}

/** 判断这个错误上有没有「重放不安全」标记，沿 cause 与 errors 链最多找五层。 */
export function isContextOverflowReplayUnsafe(error: unknown, depth: number = 0): boolean {
  if (depth > 5 || !isPresent(error)) return false
  if (!isObject(error) && !isFunction(error)) return false

  const record = error as Record<PropertyKey, unknown>
  const details = record[ContextOverflowReplayUnsafeSymbol]
  if (isContextOverflowReplayUnsafeDetails(details)) return true

  if (isContextOverflowReplayUnsafe(record.cause, depth + 1)) return true
  const nestedErrors = record.errors
  if (isArray(nestedErrors))
    return nestedErrors.some((nestedError) => isContextOverflowReplayUnsafe(nestedError, depth + 1))
  return false
}
