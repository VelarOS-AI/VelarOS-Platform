import type { ChatContextEvidenceRecord } from '@velaros-ai/agent/protocol'
import { isArray,isFunction } from '@velaros-ai/core'

import { chatSearchMessages } from './search/Messages'
import { chatSearchText } from './search/Text'
import {
  type ChatContextRetrievalIndexSnapshot,
  ChatContextRetrievalIndexVersion,
} from './IndexSnapshot'
import { contextRetrievalReferences } from './References'
import type {
  RetrievalPayloadStorePort,
  RetrievalSessionContextSnapshot,
  RetrievalStateStorePort,
} from './sessionStorePorts'

/**
 * 构建单会话**检索索引快照** {@link ChatContextRetrievalIndexSnapshot}。
 *
 * ## 为何需要索引
 * `history` / `terminal` 搜索若每次全量读 `messages` + `payloads` + 扫 `JSON`，延迟高。
 * 索引预计算 `searchableText`、`log`/`artifactReferences`、`evidence` 列表，落盘后可 `loadFresh`。
 *
 * ## `Handle` 约定（与 `PayloadReader` 一致）
 * | 类型 | `handleId` 格式 | 解析方式 |
 * |------|---------------|----------|
 * | 消息 | `message:{index}` | `messages[index]` |
 * | 工具 | `tool:{toolCallId}` | `toolResults[toolCallId]` |
 * | 内容寻址 | `ctx-payload:{hash}` | `toolResults` 键或 `payloadRef` 匹配 |
 *
 * 每 {@link ChatContextRetrievalService} 实例一个 `Builder`。
 */
class ContextRetrievalIndexBuilder {
  /** 索引内 serializedResult 截断上限（仅影响 searchableText，非 retrieve 全文）。 */
  private readonly indexedToolResultChars = 12_000
  /** 索引内 displayResult stringify 上限。 */
  private readonly indexedToolDisplayChars = 4_000

  constructor(
    private readonly payloadStore: RetrievalPayloadStorePort,
    private readonly stateStore: RetrievalStateStorePort
  ) {}

  /**
   * 构建并返回完整索引快照（caller 负责 indexStore.save）。
   *
   * 并行加载：
   * - stateStore.loadSessionMessages
   * - payloadStore.loadSessionPayloads
   * - loadSessionContextSnapshotForIndex（可选 API）
   *
   * evidence = contextView.evidenceLedger ∪ runtime evidenceLedger，按 id 去重。
   */
  public async build(sessionId: string): Promise<ChatContextRetrievalIndexSnapshot> {
    const [messages, payloads, contextSnapshot] = await Promise.all([
      this.stateStore.loadSessionMessages(sessionId),
      this.payloadStore.loadSessionPayloads(sessionId),
      this.loadSessionContextSnapshotForIndex(sessionId),
    ])
    const evidence = this.dedupeEvidence([
      ...(contextSnapshot.contextView?.evidenceLedger ?? []),
      ...contextSnapshot.evidenceLedger,
    ])

    return {
      version: ChatContextRetrievalIndexVersion,
      sessionId,
      builtAt: Date.now(),
      sourceFingerprint: {
        stateMtimeMs: null,
        payloadMtimeMs: null,
        payloadFingerprint: null,
      },
      messages: messages.map((message, index) => {
        const { text, searchableText, toolNames } = chatSearchMessages.buildMessageSearchIndex(message)

        return {
          handleId: `message:${index}`,
          messageId: message.id,
          messageIndex: index,
          role: message.role,
          timestamp: message.timestamp,
          text,
          searchableText,
          summary: chatSearchText.truncate(text || `${message.role} message`, 240),
          toolNames,
        }
      }),
      toolPayloads: Object.entries(payloads.toolResults)
        .map(([storageKey, payload]) => {
          const payloadRef = payload.payloadRef ?? (storageKey.startsWith('ctx-payload:')
            ? storageKey
            : null)
          const toolCallId = payload.toolCallId ?? storageKey

          return {
            handleId: payloadRef ?? `tool:${toolCallId}`,
            toolCallId,
            searchableText: [
              toolCallId,
              payloadRef,
              payload.toolName,
              chatSearchText.truncate(
                payload.serializedResult,
                this.indexedToolResultChars
              ),
              chatSearchText.stringifyPayload(
                payload.displayResult,
                this.indexedToolDisplayChars
              ),
            ].filter((item): item is string => Boolean(item)).join('\n'),
            logReferences: contextRetrievalReferences.collectReferencedLogPaths(
              payload.serializedResult,
              payload.displayResult
            ),
            artifactReferences: contextRetrievalReferences.collectReferencedArtifactPaths(
              payload.serializedResult,
              payload.displayResult
            ),
          }
        }),
      evidence,
    }
  }

  /**
   * 加载 Context OS snapshot；StateStore 未实现 loadSessionContextSnapshot 时返回空 ledger。
   * 使用 duck typing，避免强依赖具体 Store 实现。
   */
  private async loadSessionContextSnapshotForIndex(
    sessionId: string
  ): Promise<RetrievalSessionContextSnapshot> {
    const loadSessionContextSnapshot = this.stateStore.loadSessionContextSnapshot
    if (!isFunction(loadSessionContextSnapshot)) return {
        contextView: null,
        evidenceLedger: [],
      }

    const snapshot = await loadSessionContextSnapshot.call(this.stateStore, sessionId)
    return {
      contextView: snapshot.contextView,
      evidenceLedger: isArray(snapshot.evidenceLedger) ? snapshot.evidenceLedger : [],
    }
  }

  /**
   * 按 evidence.id 去重，保留首次出现顺序，但内容以后出现的记录为准。
   * contextView 里的 compacted evidence 可能早于 runtime ledger，后者代表更新鲜的运行时事实。
   */
  private dedupeEvidence(
    records: ChatContextEvidenceRecord[]
  ): ChatContextEvidenceRecord[] {
    const deduped = new Map<string, ChatContextEvidenceRecord>()

    for (const record of records) {
      if (!record.id) continue

      deduped.set(record.id, record)
    }

    return [...deduped.values()]
  }
}

export { ContextRetrievalIndexBuilder }
