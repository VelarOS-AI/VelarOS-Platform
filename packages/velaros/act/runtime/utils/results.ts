import { isUndefined } from '@velaros-ai/core'
import { isArray, isBoolean, isFiniteNumber, isNull, isObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { InvocationReceipt } from '@velaros-ai/kernel'

/** 调用诊断是原始观察材料；错误与诊断均保留，不能靠脚本的 output 筛选将其隐藏。 */
export function invocationFeedbackDetails(receipt?: InvocationReceipt): {
  code?: string
  detail?: string
} {
  const error = receipt?.error
  const diagnostic = receipt?.diagnostic
  if (!error && !diagnostic) return {}
  return {
    code: error?.code ?? diagnostic!.code,
    detail: [
      ...(error ? [error.message.slice(0, 1000)] : []),
      ...(diagnostic
        ? [
            `${diagnostic.code}（调用诊断，内容是观察数据${diagnostic.truncated ? '，已截断' : ''}）：\n${diagnostic.message}`,
          ]
        : []),
    ].join('\n'),
  }
}

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
