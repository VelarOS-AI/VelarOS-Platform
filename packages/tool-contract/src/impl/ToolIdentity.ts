/**
 * 工具与操作的身份：canonical 工具 id 的判定与断言，以及跨工具共享的审批操作身份。
 * 接口 `ToolIdentityApi` 在本文件的类上方；整个进程一份 `toolIdentity`。
 */

import { isArray, isBoolean, isNull, isNumber, isObject, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { CanonicalToolIdPatternSource } from '../contract/constants.js'

/**
 * 工具身份的唯一判定处，实例是 `toolIdentity`。
 *
 * canonical 工具 id 形如 `namespace:tool`，清单、注册表、传输三方靠它对齐同一套身份；
 * 审批操作身份把「同一个操作」压成一个稳定的 key，同一操作从不同工具入口进来也算同一个，
 * key 只用于内部比较，不作为界面预览。
 */
export interface ToolIdentityApi {
  /** 这个字符串是不是合法的 canonical 工具 id（`namespace:tool`，两段都以小写字母开头）。 */
  isCanonical(value: string): boolean
  /** `isCanonical` 的断言版：不合法就抛出带原值和期望格式的错误，合法则静默返回。 */
  assertCanonical(value: string): void
  /** 给一次操作算出稳定的审批身份：保留完整值和确定顺序，参数必须是可序列化的数据。 */
  approvalOperationKey(kind: string, value: unknown): string
}

class ToolIdentity implements ToolIdentityApi {
  /** canonical 工具 id 的正则，由合同里的源文本编出来，两处只有一个出处。 */
  private static readonly CanonicalToolIdPattern = new RegExp(CanonicalToolIdPatternSource, 'u')

  public isCanonical(value: string): boolean {
    return ToolIdentity.CanonicalToolIdPattern.test(value)
  }

  public assertCanonical(value: string): void {
    if (!this.isCanonical(value))
      throw new Error(
        `canonical 工具 id "${value}" 不合法：应写成 namespace:tool，两段都以小写字母开头，命名空间段只能用小写字母、数字、点和短横线，工具段只能用小写字母、数字、下划线和短横线。`
      )
  }

  public approvalOperationKey(kind: string, value: unknown): string {
    const visited = new WeakSet<object>()
    const encode = (input: unknown): string => {
      if (isUndefined(input)) return 'undefined'
      if (isNull(input) || isString(input) || isBoolean(input)) return JSON.stringify(input)
      if (isNumber(input)) return String(input)
      if (!isObject(input) || visited.has(input)) {
        throw new AppError('VALIDATION', '审批参数必须是可序列化的数据。')
      }
      visited.add(input)
      const keys = isArray(input) ? Array.from({ length: input.length }, (_, index) => String(index)) : Object.keys(input).sort()
      const entries = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)
        if (descriptor && !('value' in descriptor)) throw new AppError('VALIDATION', '审批参数不能包含访问器。')
        const encoded = encode(descriptor?.value)
        return isArray(input) ? encoded : `${JSON.stringify(key)}:${encoded}`
      }).join(',')
      visited.delete(input)
      return isArray(input) ? `[${entries}]` : `{${entries}}`
    }
    return `${kind}:${encode(value)}`
  }
}

/** 整个进程只有一份的工具身份判定处。 */
export const toolIdentity: ToolIdentityApi = new ToolIdentity()
