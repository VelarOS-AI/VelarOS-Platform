import type { ModelMessage } from 'ai'

import { isString } from '@velaros-ai/core'

import { isContextOSGeneratedAssistantMessage } from './contextOSMessage'

const InternalFollowUpPrefix = '[VelarOS internal follow-up]\n'
const InternalFollowUpTagName = 'sys_note'

type InternalFollowUpModelMessage = ModelMessage & {
  velarosInternal?: {
    kind: 'follow-up'
  }
}

function createInternalFollowUpMessage(content: string): ModelMessage {
  return {
    role: 'system',
    content: buildInternalFollowUpContent(content),
    velarosInternal: { kind: 'follow-up' },
  } as InternalFollowUpModelMessage
}

function buildInternalFollowUpContent(content: string): string {
  return [
    `<${InternalFollowUpTagName} role="system" hidden="1" from="velaros">`,
    '<![CDATA[',
    content.replaceAll(']]>', ']]]]><![CDATA[>'),
    ']]>',
    `</${InternalFollowUpTagName}>`,
  ].join('\n')
}

function isInternalFollowUpMessage(message: Pick<ModelMessage, 'content' | 'role'>): boolean {
  const internal = (message as InternalFollowUpModelMessage).velarosInternal
  if (internal?.kind === 'follow-up') return true

  return (
    isString(message.content) &&
    (message.content.startsWith(InternalFollowUpPrefix) ||
      message.content.startsWith(`<${InternalFollowUpTagName}`))
  )
}

function mapInternalFollowUpsForProvider(history: ModelMessage[]): {
  history: ModelMessage[]
  changedMessages: number
} {
  let changedMessages = 0
  const providerHistory = history.map((message) => {
    if (!isInternalFollowUpMessage(message) && !isContextOSGeneratedAssistantMessage(message)) return message

    changedMessages += 1
    return {
      role: 'user',
      content: message.content,
    } as ModelMessage
  })

  return {
    history: changedMessages > 0 ? providerHistory : history,
    changedMessages,
  }
}

export {
  buildInternalFollowUpContent,
  createInternalFollowUpMessage,
  InternalFollowUpPrefix,
  InternalFollowUpTagName,
  isInternalFollowUpMessage,
  mapInternalFollowUpsForProvider,
}
