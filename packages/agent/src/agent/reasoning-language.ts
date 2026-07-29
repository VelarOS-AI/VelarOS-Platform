import type { ModelMessage } from 'ai'

import { isArray, isObject,isString } from '@velaros-ai/core'
import type { ReasoningLanguagePreference } from '@velaros-ai/core/types'

const ReasoningLanguageBlockPattern = /^\s*<reasoning-language>[\s\S]*?<\/reasoning-language>\s*/i
type UserModelMessage = Extract<ModelMessage, { role: 'user' }>
type UserModelMessageContent = UserModelMessage['content']

function buildReasoningLanguageInstruction(
  preference: ReasoningLanguagePreference
): Nullable<string> {
  if (preference === 'auto') return null

  const instruction =
    preference === 'zh'
      ? 'Visible reasoning/thinking text preference: use Simplified Chinese when the provider exposes reasoning text. Keep code, identifiers, file paths, shell commands, and untranslated technical terms in their original form. This preference does not override an explicit user request for the final answer language.'
      : 'Visible reasoning/thinking text preference: use English when the provider exposes reasoning text. Keep code, identifiers, file paths, shell commands, and untranslated technical terms in their original form. This preference does not override an explicit user request for the final answer language.'

  return `<reasoning-language>\n${instruction}\n</reasoning-language>\n\n`
}

function hasLeadingReasoningLanguageBlock(text: string): boolean {
  return ReasoningLanguageBlockPattern.test(text)
}

function prependReasoningLanguageInstruction(
  message: ModelMessage,
  block: string
): ModelMessage {
  if (message.role !== 'user') return message

  const content = message.content
  if (isString(content)) {
    if (hasLeadingReasoningLanguageBlock(content)) return message
    return { ...message, content: `${block}${content}` } as UserModelMessage
  }

  if (!isArray(content)) return message

  const firstTextIndex = content.findIndex(
    (part) => isObject(part) && (part as { type?: unknown }).type === 'text'
  )
  if (firstTextIndex < 0) return {
      ...message,
      content: [{ type: 'text', text: block }, ...content] as UserModelMessageContent,
    } as UserModelMessage

  const firstTextPart = content[firstTextIndex]
  if (!isObject(firstTextPart)) return message

  const text = isString((firstTextPart as { text?: unknown }).text)
    ? (firstTextPart as { text: string }).text
    : ''
  if (hasLeadingReasoningLanguageBlock(text)) return message

  const nextContent = content.map((part, index) =>
    index === firstTextIndex
      ? {
          ...firstTextPart,
          text: `${block}${text}`,
        }
      : part
  )
  return {
    ...message,
    content: nextContent as UserModelMessageContent,
  } as UserModelMessage
}

function applyReasoningLanguagePreferenceToLatestUserMessage(
  messages: readonly ModelMessage[],
  preference: ReasoningLanguagePreference = 'auto'
): ModelMessage[] {
  const block = buildReasoningLanguageInstruction(preference)
  if (!block) return [...messages]

  const latestUserIndex = messages.findLastIndex((message) => message.role === 'user')
  if (latestUserIndex < 0) return [...messages]

  return messages.map((message, index) =>
    index === latestUserIndex ? prependReasoningLanguageInstruction(message, block) : message
  )
}

export {
  applyReasoningLanguagePreferenceToLatestUserMessage,
  buildReasoningLanguageInstruction,
}
