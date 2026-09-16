// AgentQuestionService 用到的纯函数（不碰实例状态）。
import { isArray, isPlainObject, isString } from '@velaros-ai/core'

import type { AgentQuestionRequest } from '../../types/product-session.js'

/** 判断一条落盘记录是不是完整的提问请求。 */
export function isQuestionRequest(value: unknown): value is AgentQuestionRequest {
  return isRecord(value)
    && isString(value.id)
    && isString(value.sessionId)
    && isString(value.question)
    && isArray(value.options)
}

/** 判断是不是普通对象（落盘记录的最外层形状）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
}
