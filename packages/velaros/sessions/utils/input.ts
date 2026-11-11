/** 只规范现有会话身份与正文；目标归属、排队及运行状态由宿主核验。 */
import { isEmpty, isNonBlankString, isPlainObject, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { type SessionsErrorCode, SessionsErrorCodes } from '../contract/constants.js'
import type { SessionAskInput, SessionTellInput } from '../types/sessions.js'

const AcceptedFields = Object.freeze({
  ask: Object.freeze(['to', 'task']),
  tell: Object.freeze(['to', 'message']),
})

/** 未识别字段直接拒绝，避免调用方误以为附加配置已生效。 */
function fieldsOf(input: unknown, operation: keyof typeof AcceptedFields): Record<string, unknown> {
  const accepted: readonly string[] = AcceptedFields[operation]
  if (!isPlainObject(input))
    throw new AppError(
      SessionsErrorCodes.inputInvalid,
      `${operation} 要一个对象入参，字段是 ${accepted.join('、')}`
    )
  const extra = Object.keys(input).filter((key) => !accepted.includes(key))
  if (!isEmpty(extra))
    throw new AppError(
      SessionsErrorCodes.inputInvalid,
      `${operation} 不认 ${extra.join('、')}：只收 ${accepted.join('、')}`
    )
  return input
}

/** 正文保持原样；空白或非文本在到达宿主之前失败。 */
function requiredText(value: unknown, field: string, code: SessionsErrorCode): string {
  if (isPresent(value) && !isString(value))
    throw new AppError(SessionsErrorCodes.inputInvalid, `${field} 要是字符串`)
  if (!isNonBlankString(value)) throw new AppError(code, `${field} 是空的：请写清楚任务或消息`)
  return value
}

/** 只接收目录中的现有会话身份，不推断或创建目标。 */
function target(value: unknown): string {
  if (isPresent(value) && !isString(value))
    throw new AppError(SessionsErrorCodes.inputInvalid, 'to 要是字符串')
  if (!isNonBlankString(value))
    throw new AppError(SessionsErrorCodes.targetMissing, '未指定目标：to 要是 list 中的现有会话 id')
  return value.trim()
}

/** 发起任务时只传目标身份和完整任务说明。 */
export function askRequest(input: unknown): SessionAskInput {
  const fields = fieldsOf(input, 'ask')
  const task = requiredText(fields.task, 'task', SessionsErrorCodes.taskEmpty)
  return { to: target(fields.to), task }
}

/** 引导只传目标身份和原始消息。 */
export function tellRequest(input: unknown): SessionTellInput {
  const fields = fieldsOf(input, 'tell')
  const message = requiredText(fields.message, 'message', SessionsErrorCodes.messageEmpty)
  return { to: target(fields.to), message }
}
