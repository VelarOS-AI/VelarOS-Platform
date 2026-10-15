import { isFiniteNumber, isPlainObject, isPresent, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ModelTurnDelta } from '../../types/driver.js'
import { ModelTuning } from '../tuning.js'

/** Responses 的完成、截断、失败都是终端事实；普通消息结束和 SSE DONE 不能代替它。 */
export function responseTerminalKind(chunk: unknown): Optional<string> {
  if (
    isPlainObject(chunk) &&
    isString(chunk.type) &&
    ['response.completed', 'response.incomplete', 'response.failed'].includes(chunk.type)
  )
    return chunk.type
  return undefined
}

/** 失败事实不依赖 SDK 对整个事件的识别；只保留有界的错误码和文案，不接收其他正文。 */
export function responseTerminalFailure(chunk: unknown): Optional<AppError> {
  if (responseTerminalKind(chunk) !== 'response.failed' || !isPlainObject(chunk)) return undefined
  const fallback = '供应商报告响应失败，但未提供有效错误详情'
  const error = isPlainObject(chunk.response) ? chunk.response.error : undefined
  if (!isPlainObject(error)) return new AppError('PROTOCOL', fallback)
  const { code, message } = error
  // 不截断再分类：截断可能抹掉永久错误原因，或把过长字段剪成可重试机器码。
  if (
    (isPresent(code) &&
      (!isString(code) ||
        code.length > ModelTuning.stream.failureCodeChars ||
        !/^[a-z][a-z0-9_]*$/iu.test(code))) ||
    (isPresent(message) &&
      (!isString(message) || message.length > ModelTuning.stream.failureMessageChars))
  )
    return new AppError('PROTOCOL', fallback)
  const detail = isString(message) ? message.trim() : undefined
  const machine = optionalWhen(isString, code)
  return new AppError('PROTOCOL', detail || machine || fallback, {
    code: machine,
    message: detail,
  })
}

/** SDK 在终端之后断流或收到失败事件时可能不发布 usage；只保留终端已明确报告的计数。 */
export function responseTerminalUsage(
  chunk: unknown
): Optional<Extract<ModelTurnDelta, { type: 'usage' }>> {
  if (!responseTerminalKind(chunk) || !isPlainObject(chunk) || !isPlainObject(chunk.response))
    return undefined
  const usage = chunk.response.usage
  if (!isPlainObject(usage)) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined
  const reported: Extract<ModelTurnDelta, { type: 'usage' }> = {
    type: 'usage',
    inputTokens,
    outputTokens,
  }
  const details = usage.input_tokens_details
  if (isPlainObject(details)) {
    const read = details.cached_tokens
    const write = details.cache_write_tokens
    if (isTokenCount(read) && read <= inputTokens)
      Object.assign(reported, { cacheReadTokens: read })
    if (isTokenCount(write) && write <= inputTokens - (reported.cacheReadTokens ?? 0))
      Object.assign(reported, { cacheWriteTokens: write })
  }
  return reported
}

/** 只接受实际报告的非负整数；缺项不能补成零。 */
function isTokenCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0
}
