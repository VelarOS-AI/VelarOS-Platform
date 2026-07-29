import type {
  ChatContextEvidenceRecord,
  ChatMessage,
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
} from '@velaros-ai/core/types'

/**
 * 检索单元消费的**会话存储窄端口**（宪章 §12.2「SessionStorePort 子接口」）。
 *
 * 只声明本单元实际读到的方法，不设计完整 SessionStorePort（那是 WS2 的活）。
 * 宿主的具体存储类（Desktop 的 `ChatPayloadStore` / `ChatStateStore`）字段更多，
 * 结构化满足这些端口即可注入；内核侧只依赖端口，与宿主持久化实现解耦。
 */

/**
 * payload 读端口：工具结果与消息序列化载荷的按会话读取。
 * `loadToolPayload` 可选——宿主若提供单 blob 直读则走快路径，缺席时退回整包快照扫描。
 */
interface RetrievalPayloadStorePort {
  loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot>
  loadToolPayload?(
    sessionId: string,
    key: string
  ): Promise<Nullable<ChatSessionToolResultPayload>>
}

/**
 * {@link RetrievalStateStorePort.loadSessionContextSnapshot} 的返回形状：
 * 索引构建仅需 evidenceLedger（Context OS 压缩视图 + 运行时账本）。
 */
interface RetrievalSessionContextSnapshot {
  /** Context OS 压缩视图；evidenceLedger 可能与 runtime ledger 重叠。 */
  contextView: LooseOptional<{
    evidenceLedger?: ChatContextEvidenceRecord[]
  }>
  /** 运行时 evidence 账本。 */
  evidenceLedger: ChatContextEvidenceRecord[]
}

/**
 * state 读端口：会话消息与 Context OS 快照的按会话读取。
 * `loadSessionContextSnapshot` 可选——宿主未实现时索引以空 evidence 构建。
 */
interface RetrievalStateStorePort {
  loadSessionMessages(sessionId: string): Promise<ChatMessage[]>
  loadSessionMessage(sessionId: string, index: number): Promise<Nullable<ChatMessage>>
  loadSessionContextSnapshot?(sessionId: string): Promise<RetrievalSessionContextSnapshot>
}

export {
  type RetrievalPayloadStorePort,
  type RetrievalSessionContextSnapshot,
  type RetrievalStateStorePort,
}
