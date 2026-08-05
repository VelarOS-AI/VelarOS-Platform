import type {
  ChatContextEvidenceRecord,
  ChatContextRetrievalIndexDiagnostics,
  ChatContextRetrievalIndexSourceFingerprint,
  ChatMessage,
  SerializedMessage,
} from '@velaros-ai/agent/protocol'
import { isPresent } from '@velaros-ai/core'

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
  /**
   * **结构性恒空**：喂它的 evidence 流协议链已于 2026-08-06 整体下线，
   * {@link ContextRetrievalIndexBuilder.build} 现在直接发 `[]`。字段保留是因为
   * `context:recall({ refKind: 'evidence' })` 仍读它，而那份列表在实现史上从未非空过——
   * 保留即维持逐字相同的行为，删掉才是一次模型面工具形状的改动。
   */
  evidence: ChatContextEvidenceRecord[]
}

/** {@link ChatContextRetrievalIndexStore.save} 的可选入参。 */
interface ChatContextRetrievalIndexSaveOptions {
  /**
   * **构建开始之前**采集的源指纹。
   *
   * 缺席时宿主自行现算——那正是 U7 的形态：build 读完数据后才采样，构建期间落盘的新 blob
   * 会被算进指纹却不在快照里，之后每次 `loadFresh` 都判 fresh，那条工具结果永久漏检索。
   * 传旧指纹的代价至多是多重建一次，方向永远是"宁可判 stale"。
   */
  sourceFingerprint?: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>
}

/**
 * 检索索引存储**窄端口**：本单元只消费 `loadFresh` / `save`（+ 可选 `getDiagnostics`
 * 与 `readSourceFingerprint`）。宿主提供文件系统实现（Desktop 的
 * `ChatContextRetrievalIndexFileStore` 结构化满足），内核只认端口不认实现——落盘策略、
 * 新鲜度指纹计算全在宿主侧。
 */
interface ChatContextRetrievalIndexStore {
  loadFresh(sessionId: string): Promise<Nullable<ChatContextRetrievalIndexSnapshot>>
  save(
    sessionId: string,
    snapshot: ChatContextRetrievalIndexSnapshot,
    options?: ChatContextRetrievalIndexSaveOptions
  ): Promise<void>
  getDiagnostics?(sessionId: string): Promise<ChatContextRetrievalIndexDiagnostics>
  /**
   * 当前源指纹（不读索引文件）。服务层用它做两件事：build 前采样（见
   * {@link ChatContextRetrievalIndexSaveOptions.sourceFingerprint}）与内存索引缓存的命中判据。
   */
  readSourceFingerprint?(
    sessionId: string
  ): Promise<Nullable<ChatContextRetrievalIndexSourceFingerprint>>
}

/**
 * 两份源指纹是否等价（= 索引仍新鲜）。
 *
 * 任一侧三项全空视为**不可比**（返回 false，强制 rebuild）：全空既可能是"会话真没数据"，
 * 也可能是"目录读失败"，两者不可区分时只能选不缓存。宿主与服务层共用这一把尺，
 * 否则磁盘新鲜度与内存缓存新鲜度会在边界情况上分叉。
 */
function contextRetrievalFingerprintsEqual(
  left: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>,
  right: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>
): boolean {
  if (!left || !right) return false
  if (isBlankFingerprint(left) || isBlankFingerprint(right)) return false

  return (
    left.stateMtimeMs === right.stateMtimeMs &&
    left.payloadMtimeMs === right.payloadMtimeMs &&
    left.payloadFingerprint === right.payloadFingerprint
  )
}

/** 指纹是否可作为新鲜度判据（三项全空 = 不可比，见 {@link contextRetrievalFingerprintsEqual}）。 */
function contextRetrievalFingerprintIsComparable(
  fingerprint: LooseOptional<ChatContextRetrievalIndexSourceFingerprint>
): boolean {
  return !!fingerprint && !isBlankFingerprint(fingerprint)
}

function isBlankFingerprint(fingerprint: ChatContextRetrievalIndexSourceFingerprint): boolean {
  return (
    !isPresent(fingerprint.stateMtimeMs) &&
    !isPresent(fingerprint.payloadMtimeMs) &&
    !isPresent(fingerprint.payloadFingerprint)
  )
}

export {
  type ChatContextRetrievalIndexMessageEntry,
  type ChatContextRetrievalIndexReferencedPath,
  type ChatContextRetrievalIndexSaveOptions,
  type ChatContextRetrievalIndexSnapshot,
  type ChatContextRetrievalIndexStore,
  type ChatContextRetrievalIndexToolPayloadEntry,
  ChatContextRetrievalIndexVersion,
  contextRetrievalFingerprintIsComparable,
  contextRetrievalFingerprintsEqual,
}
