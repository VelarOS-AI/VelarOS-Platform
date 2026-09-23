import { isArray, isBoolean, isFiniteNumber, isNull, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { StoreLimits } from '../contract/constants.js'
import type { StoreValue } from '../types/store.js'

/** 标记确定未提交的输入或并发错误。 */
export function storeFailure(code: string, message: string): Error {
  return AppError.withFields(code, message, { effect: 'none' })
}
/** 检查非空的宿主身份或对象键。 */
export function storeName(value: string, max: number): void {
  if (!isString(value) || !value.trim() || value.length > max || value.includes('\0'))
    throw storeFailure('STORE_INPUT', '状态身份或键无效')
}
/** 精确验证并稳定编码 JSON，拒绝损失字段、可执行 getter 与循环。 */
export function storeJson(value: StoreValue): string {
  const seen = new Set<object>()
  const copy = (item: unknown, depth: number): unknown => {
    if (depth > 64) throw storeFailure('STORE_INPUT', '状态对象嵌套超过 64 层')
    if (isNull(item) || isString(item) || isBoolean(item)) return item
    if (isFiniteNumber(item)) return item
    if ((!isObject(item) && !isNull(item)) || !item || seen.has(item))
      throw storeFailure('STORE_INPUT', '状态值必须是无环 JSON')
    if (
      !isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      !isNull(Object.getPrototypeOf(item))
    )
      throw storeFailure('STORE_INPUT', '状态对象必须是普通 JSON 对象')
    seen.add(item)
    const keys = Reflect.ownKeys(item).filter((key) => !(isArray(item) && key === 'length'))
    if (keys.some((key) => !isString(key)))
      throw storeFailure('STORE_INPUT', '状态对象不支持 Symbol 键')
    const result: Record<string, unknown> | unknown[] = isArray(item) ? [] : Object.create(null)
    if (
      isArray(item) &&
      (keys.length !== item.length || keys.some((key, index) => key !== String(index)))
    )
      throw storeFailure('STORE_INPUT', '状态数组必须连续且不带附加属性')
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw storeFailure('STORE_INPUT', '状态字段必须是普通可枚举数据')
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    seen.delete(item)
    return result
  }
  const json = JSON.stringify(copy(value, 0))
  if (new TextEncoder().encode(json).length > StoreLimits.valueBytes)
    throw storeFailure('STORE_LIMIT', '状态对象超过 256 KiB；大材料请保存引用')
  return json
}
/** 状态授权与订阅统一按字符串前缀匹配。 */
export function storeMatches(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix))
}
/** 校验并去重排序关注集合，保证重复声明幂等。 */
export function storeSelection(
  keys: readonly string[],
  prefixes: readonly string[]
): { keys: string[]; prefixes: string[] } {
  if (
    !isArray(keys) ||
    !isArray(prefixes) ||
    keys.length + prefixes.length > StoreLimits.watchItems
  )
    throw storeFailure('STORE_INPUT', '关注集合最多 64 项')
  for (const key of keys) storeName(key, StoreLimits.keyChars)
  for (const prefix of prefixes)
    if (!isString(prefix) || prefix.length > StoreLimits.keyChars || prefix.includes('\0'))
      throw storeFailure('STORE_INPUT', '关注前缀无效')
  return {
    keys: [...new Set<string>(keys as readonly string[])].sort(),
    prefixes: [...new Set<string>(prefixes as readonly string[])].sort(),
  }
}

/** 校验消息主题和有界正文，避免自动通知携带大材料。 */
export function storeMessageJson(topic: string, value: StoreValue): string {
  storeName(topic, StoreLimits.keyChars)
  const json = storeJson(value)
  if (new TextEncoder().encode(json).length > StoreLimits.messageBytes)
    throw storeFailure('STORE_LIMIT', '消息超过 16 KiB，请共享材料引用')
  return json
}
