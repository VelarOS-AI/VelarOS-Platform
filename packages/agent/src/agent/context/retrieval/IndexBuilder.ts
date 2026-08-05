import { chatSearchMessages } from './search/Messages'
import { chatSearchText } from './search/Text'
import {
  type ChatContextRetrievalIndexSnapshot,
  ChatContextRetrievalIndexVersion,
} from './IndexSnapshot'
import { contextRetrievalReferences } from './References'
import type { RetrievalPayloadStorePort, RetrievalStateStorePort } from './sessionStorePorts'

/**
 * 构建单会话**检索索引快照** {@link ChatContextRetrievalIndexSnapshot}。
 *
 * ## 为何需要索引
 * `history` / `terminal` 搜索若每次全量读 `messages` + `payloads` + 扫 `JSON`，延迟高。
 * 索引预计算 `searchableText` 与 `log`/`artifactReferences` 列表，落盘后可 `loadFresh`。
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
   *
   * `evidence` 恒为空数组：喂它的那条 `sessionContextSnapshot.evidenceLedger` 端口已随
   * evidence 流协议链（2026-08-06）整体下线——从采集面到 renderer 账本全程零生产者，
   * 索引里那份列表在实现史上从未非空过。快照字段本身保留（`context:recall`
   * `refKind: 'evidence'` 仍读它，行为与下线前逐字相同：恒 `found: false`），
   * 该 refKind 的去留是独立的模型面裁决，不由本次下线顺手决定。
   */
  public async build(sessionId: string): Promise<ChatContextRetrievalIndexSnapshot> {
    const [messages, payloads] = await Promise.all([
      this.stateStore.loadSessionMessages(sessionId),
      this.payloadStore.loadSessionPayloads(sessionId),
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
      evidence: [],
    }
  }
}

export { ContextRetrievalIndexBuilder }
