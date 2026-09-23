import {
  isArray,
  isBoolean,
  isNull,
  isNumber,
  isObject,
  isString,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
/**
 * 给一次操作算出稳定的审批身份：`<kind>:<编码后的参数>`。保留完整值和确定顺序（对象键排序、数组按位），
 * 同一操作从不同工具入口进来也算同一个；参数必须是可序列化的数据，成环或带访问器就抛 VALIDATION。
 * 只用于内部比较，不作为界面预览。
 */
export function createApprovalOperationKey(kind: string, value: unknown): string {
  const visited = new WeakSet<object>()
  const encode = (input: unknown): string => {
    if (isUndefined(input)) return 'undefined'
    if (isNull(input) || isString(input) || isBoolean(input)) return JSON.stringify(input)
    if (isNumber(input)) return String(input)
    if (!isObject(input) || visited.has(input)) {
      throw new AppError('VALIDATION', '审批参数必须是可序列化的数据。')
    }
    visited.add(input)
    const keys = isArray(input)
      ? Array.from({ length: input.length }, (_, index) => String(index))
      : Object.keys(input).sort()
    const entries = keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (descriptor && !('value' in descriptor))
          throw new AppError('VALIDATION', '审批参数不能包含访问器。')
        const encoded = encode(descriptor?.value)
        return isArray(input) ? encoded : `${JSON.stringify(key)}:${encoded}`
      })
      .join(',')
    visited.delete(input)
    return isArray(input) ? `[${entries}]` : `{${entries}}`
  }
  return `${kind}:${encode(value)}`
}
