import { isUndefined } from '@velaros-ai/core'
import { isArray, isBoolean, isFiniteNumber, isNull, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 领域可选字段省略 undefined，void 转 null；非 JSON 值明确拒绝而不是悄悄变形。 */
export function normalizeCapabilityValue(value: unknown): unknown {
  const seen = new Set<object>()
  const copy = (item: unknown, root = false): unknown => {
    if (isUndefined(item) && root) return null
    if (isNull(item) || isString(item) || isBoolean(item)) return item
    if (isFiniteNumber(item)) return item
    if (
      (!isObject(item) && !isNull(item)) ||
      seen.has(item) ||
      (!isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
    )
      throw new AppError('OUTPUT_ENCODING', '领域结果必须是无环 JSON 数据')
    seen.add(item)
    const next = isArray(item)
      ? item.map((child) => copy(child, true))
      : Object.fromEntries(
          Object.entries(item)
            .filter(([, child]) => !isUndefined(child))
            .map(([key, child]) => [key, copy(child)])
        )
    seen.delete(item)
    return next
  }
  return copy(value, true)
}

/** 失败带着这些错误码之一；用来认出发生在任何写入之前、可以记成没有效果的拒绝。 */
export function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  return codes.includes((error as { code?: string })?.code ?? '')
}
