/** 沙箱操作的入参核对：模型给的东西先在这里拦，不把半个入参交给宿主。 */

import { isEmpty, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { RehearsalSandboxLimits } from '../contract/constants.js'

/** 模型给的沙箱 id：必须是 create 回执里的那个非空字符串、不超过上限，不合法就当场拒绝。 */
export function sandboxIdOf(value: unknown): string {
  if (!isString(value) || isEmpty(value.trim()) || value.length > RehearsalSandboxLimits.idChars) {
    throw new AppError('VALIDATION', `要 create 回执里的沙箱 id（原样复制），这里给的是 ${JSON.stringify(value)}`)
  }
  return value
}
