import type {
  ChatContextEvidenceRecord,
  ChatContextRetrievalIndexDiagnostics,
  ChatContextRetrievalIndexSourceFingerprint,
  ChatMessage,
  SerializedMessage,
} from '@velaros-ai/core/types'

/** 索引 snapshot schema 版本；与 {@link ContextRetrievalIndexBuilder} 产出一致。 */
const ChatContextRetrievalIndexVersion = 1

/**
 * 索引中一条可搜索消息的扁平条目（由 IndexBuilder 预计算 searchableText）。
 */
interface ChatContextRetrievalIndexMessageEntry {
  /** retrieve/search 用 handle，如 `message:3`。 */
  handleId: string
  messageId: string
  messageIndex: number
  role: SerializedMessage['role'] | ChatMessage['role']
  timestamp: number
  /** 可见正文摘要。 */
  text: string
  /** rankContextText 输入面。 */
  searchableText: string
  /** UI 列表用短摘要。 */
  summary: string
  toolNames: string[]
}

/** 工具 payload 引用的磁盘路径（日志/artifact）。 */
interface ChatContextRetrievalIndexReferencedPath {
  path: string
  source: string
}

/**
 * 索引中一条工具 payload 的可搜索条目。
 */
interface ChatContextRetrievalIndexToolPayloadEntry {
  handleId: string
  toolCallId: string
  searchableText: string
  logReferences: ChatContextRetrievalIndexReferencedPath[]
  artifactReferences: ChatContextRetrievalIndexReferencedPath[]
}

/**
 * 完整检索索引快照（落盘 JSON + 内存 rebuild 产物）。
 * 由 {@link ContextRetrievalIndexBuilder.build} 生成，由宿主的索引存储（{@link ChatContextRetrievalIndexStore}）落盘。
 */
interface ChatContextRetrievalIndexSnapshot {
  version: typeof ChatContextRetrievalIndexVersion
  sessionId: string
  builtAt: number
  /** 用于判断索引是否 stale（宿主实现按会话载荷指纹比对）。 */
  sourceFingerprint: ChatContextRetrievalIndexSourceFingerprint
  messages: ChatContextRetrievalIndexMessageEntry[]
  toolPayloads: ChatContextRetrievalIndexToolPayloadEntry[]
  evidence: ChatContextEvidenceRecord[]
}

/**
 * 检索索引存储**窄端口**：本单元只消费 `loadFresh` / `save`（+ 可选 `getDiagnostics`）。
 * 宿主提供文件系统实现（Desktop 的 `ChatContextRetrievalIndexFileStore` 结构化满足），
 * 内核只认端口不认实现——落盘策略、新鲜度指纹计算全在宿主侧。
 */
interface ChatContextRetrievalIndexStore {
  loadFresh(sessionId: string): Promise<Nullable<ChatContextRetrievalIndexSnapshot>>
  save(sessionId: string, snapshot: ChatContextRetrievalIndexSnapshot): Promise<void>
  getDiagnostics?(sessionId: string): Promise<ChatContextRetrievalIndexDiagnostics>
}

export {
  type ChatContextRetrievalIndexMessageEntry,
  type ChatContextRetrievalIndexReferencedPath,
  type ChatContextRetrievalIndexSnapshot,
  type ChatContextRetrievalIndexStore,
  type ChatContextRetrievalIndexToolPayloadEntry,
  ChatContextRetrievalIndexVersion,
}
