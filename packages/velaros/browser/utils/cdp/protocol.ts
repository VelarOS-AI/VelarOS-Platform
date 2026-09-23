/** 模型那条 CDP 会话的共用规则：协议报错换成专属码、事件按方法名或域前缀筛。 */

import { isPlainObject, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { BrowserErrorCodes } from '../../contract/constants.js'

/** 协议报错换成 `BROWSER_PROTOCOL_FAILED`：message 用协议给的原话（传输层记在 context 里的那句优先），前面点名是哪条命令。 */
export function protocolFailure(method: string, error: unknown): AppError {
  const failure = AppError.from(error)
  const protocolMessage = isString(failure.context.protocolMessage)
    ? failure.context.protocolMessage
    : failure.message
  return new AppError(BrowserErrorCodes.protocolFailed, `${method}：${protocolMessage}`, error)
}

/** 事件方法名匹不匹配筛选：完整方法名要相等，以点结尾的是域前缀；不给筛选就都算。 */
export function protocolMethodMatches(method: string, filter: Optional<string>): boolean {
  if (!filter) return true
  return filter.endsWith('.') ? method.startsWith(filter) : method === filter
}

/** Fetch.requestPaused 里被拦下的请求地址；读不到就是空字符串。 */
export function pausedRequestUrl(params: unknown): string {
  if (!isPlainObject(params) || !isPlainObject(params.request)) return ''
  return isString(params.request.url) ? params.request.url : ''
}
