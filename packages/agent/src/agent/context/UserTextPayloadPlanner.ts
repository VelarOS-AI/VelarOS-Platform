import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { UserTextPayloadReference } from '../history/sanitize'

import {
  type ContextPayloadStore,
  type ContextUserTextRecord,
  createContextUserTextRef,
} from './ContextPayloadStore'
import { hashUserMessageText, readUserMessageText } from './userMessageText'

export type { UserTextPayloadReference }

/** 超过该字符数时为用户全文建立持久化引用；发送驻留形态由完整请求的容量治理决定。 */
export const OversizedUserTextSafetyValveChars = 48_000

export interface PersistUserTextPayloadsResult {
  references: UserTextPayloadReference[]
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
    const candidates: Array<{ messageIndex: number; hash: string; text: string }> = []

    for (let messageIndex = 0; messageIndex < input.messages.length; messageIndex += 1) {
      const message = input.messages[messageIndex]
      if (!message) continue

      const text = readUserMessageText(message)
      if (!text || text.length <= input.thresholdChars) continue

      candidates.push({ messageIndex, text, hash: hashUserMessageText(text) })
    }
    if (isEmpty(candidates)) return { references: [] }

    const hashes = [...new Set(candidates.map((candidate) => candidate.hash))]
    const referencesByHash = await this.findExistingReferences(input.sessionId, hashes)
    const pendingByHash = new Map<string, ContextUserTextRecord>()
    for (const { messageIndex, hash, text } of candidates) {
      if (referencesByHash.has(hash) || pendingByHash.has(hash)) continue
      pendingByHash.set(hash, {
        sessionId: input.sessionId,
        hash,
        payloadRef: createContextUserTextRef(input.sessionId, hash),
        messageKey: buildUserTextMessageKey(input.sessionId, messageIndex, hash),
        text,
        chars: text.length,
        createdAt: Date.now(),
      })
    }

    const pending = [...pendingByHash.values()]
    if (!isEmpty(pending)) {
      if (this.payloadStore.putUserTextMany) {
        const stored = await this.payloadStore.putUserTextMany(pending)
        for (const record of stored) referencesByHash.set(record.hash, record.payloadRef)
      } else if (this.payloadStore.putUserText) {
        for (const record of pending) {
          const stored = await this.payloadStore.putUserText(record)
          referencesByHash.set(stored.hash, stored.payloadRef)
        }
      } else {
        const payloads = pending.map((record) => ({
          sessionId: record.sessionId,
          hash: record.hash,
          payloadRef: record.payloadRef,
          toolCallId: record.messageKey,
          toolName: '__context_user_text__',
          serializedResult: record.text,
          chars: record.chars,
          createdAt: record.createdAt,
        }))
        if (this.payloadStore.putMany) {
          const stored = await this.payloadStore.putMany(payloads)
          for (const record of stored) referencesByHash.set(record.hash, record.payloadRef)
        } else {
          for (const record of payloads) {
            const stored = await this.payloadStore.put(record)
            referencesByHash.set(stored.hash, stored.payloadRef)
          }
        }
      }
    }

    const references = candidates.map(({ messageIndex, hash, text }) => {
      const payloadRef = referencesByHash.get(hash)
      if (!payloadRef)
        throw new AppError('INVARIANT', 'User text persistence missed a payload reference')
      return { messageIndex, hash, payloadRef, originalChars: text.length }
    })
    return { references }
  }

  /** 批次按内容身份查重；宿主无需为历史里的每条长文各加载一遍全会话。 */
  private async findExistingReferences(
    sessionId: string,
    hashes: readonly string[]
  ): Promise<Map<string, string>> {
    const references = new Map<string, string>()
    if (this.payloadStore.findUserTextsByHash) {
      const found = await this.payloadStore.findUserTextsByHash(sessionId, hashes)
      for (const [hash, record] of found) references.set(hash, record.payloadRef)
    } else if (this.payloadStore.findUserTextByHash) {
      for (const hash of hashes) {
        const record = await this.payloadStore.findUserTextByHash(sessionId, hash)
        if (record) references.set(hash, record.payloadRef)
      }
    }

    const missing = hashes.filter((hash) => !references.has(hash))
    if (isEmpty(missing)) return references
    if (this.payloadStore.findManyByHash) {
      const found = await this.payloadStore.findManyByHash(sessionId, missing)
      for (const [hash, record] of found) references.set(hash, record.payloadRef)
    } else {
      for (const hash of missing) {
        const record = await this.payloadStore.findByHash(sessionId, hash)
        if (record) references.set(hash, record.payloadRef)
      }
    }
    return references
  }
}
