/** 沙箱操作的入参核对：模型给的东西先在这里拦，不把半个入参交给宿主。 */

import { isEmpty, isString, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { ShellLimits } from '@velaros-ai/velaros/execution/contracts'

import { RehearsalSandboxLimits } from '../contract/constants.js'

/** 模型给的沙箱 id：必须是 create 回执里的那个非空字符串、不超过上限，不合法就当场拒绝。 */
export function sandboxIdOf(value: unknown): string {
  if (!isString(value) || isEmpty(value.trim()) || value.length > RehearsalSandboxLimits.idChars) {
    throw new AppError(
      'VALIDATION',
      `要 create 回执里的沙箱 id（原样复制），这里给的是 ${JSON.stringify(value)}`
    )
  }
  return value
}

/** 镜像里一条命令的超时：不给交宿主用它的缺省，给了钳进 `execution 宿主` 同一个上限（钳而不拒，超了按上限跑）。 */
export function sandboxTimeoutOf(value: Optional<number>): Optional<number> {
  return isUndefined(value)
    ? undefined
    : Math.max(1, Math.min(Math.floor(value), ShellLimits.timeoutMs))
}
