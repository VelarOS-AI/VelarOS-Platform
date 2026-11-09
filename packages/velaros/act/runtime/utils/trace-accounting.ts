import { isFiniteNumber, isNull, isPlainObject, isString, optionalWhen } from '@velaros-ai/core'

import type { ActModelAccounting } from '../types/trace.js'

/** 协议接受、拒绝和计数分别解释；没有当前活跃租约时，缺失响应只说明未知。 */
export function modelAccounting(response: unknown, inflight: boolean): ActModelAccounting {
  const decoded = optionalWhen(isPlainObject, response)
  const settled = decoded?.status === 'accepted' || decoded?.status === 'rejected'
  const usage = isPlainObject(decoded?.usage) ? decoded.usage : undefined
  const inputTokens = tokenCount(usage?.inputTokens)
  const outputTokens = tokenCount(usage?.outputTokens)
  const cacheRead = tokenCount(usage?.cacheReadTokens)
  const cacheWrite = tokenCount(usage?.cacheWriteTokens)
  const cachesValid = !isNull(inputTokens) && (cacheRead ?? 0) + (cacheWrite ?? 0) <= inputTokens
  const finish = isPlainObject(decoded?.finish) ? decoded.finish : undefined
  const error = isPlainObject(decoded?.error) ? decoded.error : undefined
  return {
    status: settled ? 'settled' : inflight ? 'inflight' : 'unknown',
    outcome: settled ? (decoded.status as 'accepted' | 'rejected') : null,
    finishReason: finish?.reason === 'stop' || finish?.reason === 'length' ? finish.reason : null,
    error: error
      ? {
          code: isString(error.code) ? error.code : null,
          message: isString(error.message) ? error.message : null,
        }
      : null,
    usage: {
      coverage:
        !isNull(inputTokens) && !isNull(outputTokens) ? 'known' : inflight ? 'inflight' : 'unknown',
      inputTokens,
      outputTokens,
      cacheReadTokens: cachesValid ? cacheRead : null,
      cacheWriteTokens: cachesValid ? cacheWrite : null,
    },
  }
}

/** token 必须是实际报告的非负整数，缺失保持 null。 */
function tokenCount(value: unknown): Nullable<number> {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : null
}
