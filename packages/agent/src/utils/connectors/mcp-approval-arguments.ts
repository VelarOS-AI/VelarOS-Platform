const MaxPreviewChars = 4_000
const MaxStringChars = 400
const SensitiveArgumentKey =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|cookie/i

/** Approval text is a bounded, redacted view. Never invokes argument getters or toJSON hooks. */
export function describeMcpApprovalArguments(args: Record<string, unknown>): string {
  const visited = new WeakSet<object>()
  let remainingEntries = 80
  const preview = (value: unknown, depth: number): unknown => {
    if (isString(value))
      return value.length > MaxStringChars ? `${value.slice(0, MaxStringChars)}…[truncated]` : value
    if (isNull(value) || isBoolean(value) || isNumber(value)) return value
    if (!isObject(value)) return `[${typeof value}]`
    if (depth >= 4) return '[nested value omitted]'
    if (visited.has(value)) return '[circular]'
    visited.add(value)
    try {
      const keys = Object.keys(value)
      const arrayValue = isArray(value)
      const result: Record<string, unknown> = Object.create(null)
      for (const key of keys.slice(0, 20)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (remainingEntries-- <= 0) {
          result['…'] = '[remaining arguments omitted]'
          break
        }
        result[key] = SensitiveArgumentKey.test(key)
          ? '[redacted]'
          : 'value' in descriptor
            ? preview(descriptor.value, depth + 1)
            : '[accessor omitted]'
      }
      if (keys.length > 20) result['…'] = `[${keys.length - 20} more entries]`
      return arrayValue ? Object.values(result) : result
    } finally {
      visited.delete(value)
    }
  }
  const text = JSON.stringify(preview(args, 0))
  return text.length > MaxPreviewChars ? `${text.slice(0, MaxPreviewChars)}…[truncated]` : text
}
import { isArray, isBoolean, isNull, isNumber, isObject, isString } from '@velaros-ai/core'
