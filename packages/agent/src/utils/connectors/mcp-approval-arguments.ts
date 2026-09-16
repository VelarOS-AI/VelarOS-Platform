const MaxPreviewChars = 4_000
const MaxStringChars = 400
const SensitiveArgumentKey =
  /password|passwd|secret|token|authorization|credential|api[-_]?key|cookie/i

/**
 * 把 MCP 工具的调用参数摊成一段**有界且脱敏**的审批预览文本——这是用户在确认弹窗里唯一看得见的东西。
 *
 * 五道上限一起收口：单个字符串超 400 字截断、每层最多列 20 个键、总条目 80 个、嵌套超过 4 层写 `[nested value omitted]`，
 * 最后整段再截到 4000 字；环引用写 `[circular]`。键名命中敏感词（password / token / api-key / cookie 等）的值一律换成 `[redacted]`。
 * **绝不触发取值器或 toJSON**：只读自有属性描述符，遇到 getter 就写 `[accessor omitted]`——渲染一段审批预览本身不该产生任何副作用。
 * 截掉的内容不提供找回途径，也不需要：这段文本只供人眼确认，真正发给 server 的始终是原始参数。
 */
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
