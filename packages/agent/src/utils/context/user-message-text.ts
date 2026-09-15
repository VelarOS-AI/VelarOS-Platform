import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { isArray, isRecord, isString } from '@velaros-ai/core'

/** 用户正文的唯一提取口径；附件保留在消息中，不参与正文摘录或内容寻址。 */
export function readUserMessageText(message: ModelMessage): Nullable<string> {
  if (message.role !== 'user') return null
  if (isString(message.content)) return message.content
  if (!isArray(message.content)) return null

  return message.content
    .filter((part) => isRecord(part) && part.type === 'text' && isString(part.text))
    .map((part) => (part as { text: string }).text)
    .join('\n')
}

/** 持久化和驻留账本共用同一份正文的内容身份。 */
export function hashUserMessageText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
