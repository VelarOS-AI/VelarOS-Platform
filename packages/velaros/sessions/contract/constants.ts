/** 现有会话协作的输入错误；目标归属、排队与运行错误由宿主直接返回。 */
export const SessionsErrorCodes = Object.freeze({
  /** 入参不是对象、带未识别字段或字段类型错误。 */
  inputInvalid: 'SESSIONS_INPUT_INVALID',
  /** ask 的 task 缺失或只有空白。 */
  taskEmpty: 'SESSIONS_TASK_EMPTY',
  /** tell 的 message 缺失或只有空白。 */
  messageEmpty: 'SESSIONS_MESSAGE_EMPTY',
  /** to 缺失或只有空白。 */
  targetMissing: 'SESSIONS_TARGET_MISSING',
} as const)

export type SessionsErrorCode = (typeof SessionsErrorCodes)[keyof typeof SessionsErrorCodes]
