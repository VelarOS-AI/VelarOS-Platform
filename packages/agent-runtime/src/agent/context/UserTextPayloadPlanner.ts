import { createHash } from 'node:crypto'

import type { ModelMessage } from 'ai'

import { isRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { UserTextPayloadReference } from '../history/microCompaction'

import {
  type ContextPayloadStore,
  type ContextUserTextRecord,
  createContextUserTextRef,
} from './ContextPayloadStore'

export type { UserTextPayloadReference }

export interface PersistUserTextPayloadsResult {
  references: UserTextPayloadReference[]
}

function readUserTextContent(message: ModelMessage): Nullable<string> {
  if (message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const textParts = content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
  if (textParts.length === 0) return null
  return textParts.join('\n')
}

function buildUserTextMessageKey(sessionId: string, messageIndex: number, hash: string): string {
  return `${sessionId}:user:${messageIndex}:${hash.slice(0, 12)}`
}

export class UserTextPayloadPlanner {
  public constructor(private readonly payloadStore: ContextPayloadStore) {}

  public async persistOversizedUserTexts(input: {
    sessionId: string
    messages: readonly ModelMessage[]
    thresholdChars: number
  }): Promise<PersistUserTextPayloadsResult> {
    const references: UserTextPayloadReference[] = []
    const pending: ContextUserTextRecord[] = []

    for (let messageIndex = 0; messageIndex < input.messages.length; messageIndex += 1) {
      const message = input.messages[messageIndex]
      if (!message) continue

      const text = readUserTextContent(message)
      if (!text || text.length <= input.thresholdChars) continue

      const hash = createHash('sha256').update(text).digest('hex')
      const existing =
        (await this.payloadStore.findUserTextByHash?.(input.sessionId, hash)) ??
        (await this.payloadStore.findByHash(input.sessionId, hash))
      if (existing) {
        references.push({
          messageIndex,
          payloadRef: existing.payloadRef,
          hash,
          originalChars: text.length,
        })
        continue
      }

      const payloadRef = createContextUserTextRef(input.sessionId, hash)
      const record: ContextUserTextRecord = {
        sessionId: input.sessionId,
        hash,
        payloadRef,
        messageKey: buildUserTextMessageKey(input.sessionId, messageIndex, hash),
        text,
        chars: text.length,
        createdAt: Date.now(),
      }
      pending.push(record)
      references.push({
        messageIndex,
        payloadRef,
        hash,
        originalChars: text.length,
      })
    }

    if (pending.length > 0) {
      if (this.payloadStore.putUserTextMany) {
        await this.payloadStore.putUserTextMany(pending)
      } else if (this.payloadStore.putUserText) {
        for (const record of pending) {
          await this.payloadStore.putUserText(record)
        }
      } else {
        for (const record of pending) {
          await this.payloadStore.put({
            sessionId: record.sessionId,
            hash: record.hash,
            payloadRef: record.payloadRef,
            toolCallId: record.messageKey,
            toolName: '__context_user_text__',
            serializedResult: record.text,
            chars: record.chars,
            createdAt: record.createdAt,
          })
        }
      }
    }

    return { references }
  }
}
