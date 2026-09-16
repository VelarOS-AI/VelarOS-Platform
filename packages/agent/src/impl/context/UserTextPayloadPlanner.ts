import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { ContextUserTextRecord, PersistUserTextPayloadsResult } from '../../types/context.js'
import type { UserTextPayloadReference } from '../../types/history.js'
import { hashUserMessageText, readUserMessageText } from '../../utils/context/user-message-text'
import { AgentTuning } from '../../utils/tuning'

import { createContextUserTextRef } from './InMemoryContextPayloadStore'

export type { UserTextPayloadReference }

/**
 * 超过该字符数时为用户全文建立持久化引用；发送驻留形态由完整请求的容量治理决定。
 * 值在 `AgentTuning.context.oversizedUserTextChars`。
 */
export const OversizedUserTextSafetyValveChars: number = AgentTuning.context.oversizedUserTextChars

function buildUserTextMessageKey(sessionId: string, messageIndex: number, hash: string): string {
  return `${sessionId}:user:${messageIndex}:${hash.slice(0, 12)}`
}

/**
 * 超长用户正文的归档规划器：把历史里过长的用户消息原文存进 payload 店，换回一串「位置 → 地址」的引用。
 *
 * 由编译链按会话建（构造时收一份 `ContextPayloadStore`），自身无状态。
 * 按内容哈希去重——同一段正文在会话里只存一份，重复出现的位置共用同一个 `payloadRef`。
 * 只负责存与给地址，**不改消息**；发送时正文以哪种形态出现由完整请求的容量治理决定。
 */
export interface UserTextPayloadPlannerApi {
  /**
   * 扫一遍消息，把超过 `thresholdChars` 的用户正文存好并返回引用清单（消息下标、哈希、地址、原长）。
   * 先按哈希查会话里已有的记录，只存真正缺的那些；店支持批量接口就走批量，不支持就逐条退化。
   * 没有超长正文时返回空清单。存完仍取不到某条的地址属于不变量被破坏，抛 `INVARIANT` 而不是静默跳过。
   */
  persistOversizedUserTexts(input: {
    sessionId: string
    messages: readonly ModelMessage[]
    thresholdChars: number
  }): Promise<PersistUserTextPayloadsResult>
}

export class UserTextPayloadPlanner implements UserTextPayloadPlannerApi {
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
        throw new AppError('INVARIANT', `用户长文落盘后少了一条 payload 引用：hash ${hash} 既没查到已有记录，写入也没回填引用；缺引用会让这条正文在历史里无法召回，因此中止而不是写一份取不回的历史。`)
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
