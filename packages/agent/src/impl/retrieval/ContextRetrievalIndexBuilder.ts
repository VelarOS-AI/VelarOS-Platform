import type { RetrievalPayloadStorePort, RetrievalStateStorePort } from '../../contract/requires.js'
import type { ChatContextRetrievalIndexSnapshot } from '../../types/retrieval.js'
import { isPrivateFileContextRecord } from '../../utils/context/private-file-records'
import { ChatContextRetrievalIndexVersion } from '../../utils/retrieval/index-snapshot'
import { buildMessageSearchIndex } from '../../utils/retrieval/messages'
import { chatSearchText } from '../../utils/retrieval/text'

import { contextRetrievalReferences } from './ContextRetrievalReferences'

/**
 * 会话检索索引的构建面：把一个会话的消息和工具 payload 读出来，预算好可搜文本与日志/制品引用，产出一份快照。
 *
 * 实现是 `ContextRetrievalIndexBuilder`，每个 `ChatContextRetrievalService` 实例持一个；它自己不落盘也不缓存，
 * 存哪儿、什么时候重建由调用方决定。
 */
export interface ContextRetrievalIndexBuilderApi {
  /** 现读现算一个会话的完整索引快照：并行拉消息和 payload，逐条算出 handleId、可搜文本、摘要和引用列表；调用方拿到后自己决定存不存。私有文件类的 payload 会被滤掉，`evidence` 恒为空数组（喂它的端口已下线）。会话不存在时给的是一份空快照，不抛。 */
  build(sessionId: string): Promise<ChatContextRetrievalIndexSnapshot>
}

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
class ContextRetrievalIndexBuilder implements ContextRetrievalIndexBuilderApi {
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
        const { text, searchableText, toolNames } = buildMessageSearchIndex(message)

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
        .filter(([, payload]) => !isPrivateFileContextRecord(payload.toolName))
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
