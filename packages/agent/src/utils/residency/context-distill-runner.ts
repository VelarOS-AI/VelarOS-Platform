// ContextDistillRunner 用到的纯函数（不碰实例状态）。
import { isRecord, isString } from '@velaros-ai/core'

/** `TimerScope.withTimeout` 的超时中止（与端口自己抛的错分开记账：超时不是失败）。 */
export function isTimeoutError(error: unknown): boolean {
  return isRecord(error) && isString(error.name) && error.name === 'TimeoutError'
}
