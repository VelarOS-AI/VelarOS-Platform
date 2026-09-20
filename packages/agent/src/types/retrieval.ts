import type { ChatContextEvidenceRecord, ChatContextRetrievalIndexDiagnostics, ChatContextRetrievalIndexLoadSource, ChatContextRetrievalIndexSourceFingerprint, ChatMessage, ChatSessionToolResultPayload, SerializedMessage } from './agent.js'
import type { ContextRecord } from './residency.js'

export type ChatContextRetrievalIndexToolPayload =
  ChatContextRetrievalIndexSnapshot["toolPayloads"][number];

/** 账本 ref 解析结果：命中的记录 + 该 ref 对应的全保真层引用（per-part 优先）。 */
export interface ResolvedLedgerRecord {
  record: ContextRecord;
  payloadRef: Nullable<string>;
  toolCallId: Nullable<string>;
  toolName: Nullable<string>;
}

/** 内存索引缓存条目：快照 + 它成立时的源指纹。 */
export interface CachedRetrievalIndex {
  fingerprint: ChatContextRetrievalIndexSourceFingerprint;
  snapshot: ChatContextRetrievalIndexSnapshot;
}

/**
 * 单次 loadRetrievalIndex 的构建遥测，合并进 diagnostics。
 */
export interface RetrievalIndexBuildTelemetry {
  /** 本次命中 fresh 磁盘索引还是内存 rebuild。 */
  lastLoadSource: ChatContextRetrievalIndexLoadSource;
  /** rebuild 耗时 ms；loadFresh 命中时为 null。 */
  lastBuildDurationMs: LooseOptional<number>;
  /** 索引 snapshot.builtAt。 */
  lastBuiltAt: LooseOptional<number>;
}

/**
 * resolveToolPayload 成功后的内部结构。
 */
export interface ResolvedToolPayload {
  payload: ChatSessionToolResultPayload
  /** toolResults 对象中的键（可能是 toolCallId 或 ctx-payload:…）。 */
  storageKey: string
  toolCallId: Nullable<string>
  payloadRef: Nullable<string>
}

export interface DirectToolPayloadLookupResult {
  checked: boolean
  payload: Nullable<ChatSessionToolResultPayload>
}

export type JsonPathSegment = string | number

export interface JsonPathSelection {
  found: boolean
  value: unknown
  reason?: string
}

/**
 * {@link ContextRetrievalQueryTraceStore.register} 的返回值。
 * 由 search* 方法持有并传入 {@link ContextRetrievalQueryTraceStore.record}。
 */
export interface RetrievalQueryRegistration {
  /** 与 register 入参一致，回传便于 record 写 trace。 */
  retrievalScopeId: string
  /** normalizeQuerySignature 结果，用于 trace 展示与去重键。 */
  normalizedQuery: string
  /** 本 scope 内该 query 第几次搜索（从 1 起）。 */
  retrievalCount: number
  /** retrievalCount > 1。 */
  repeated: boolean
}

export interface PaginatedJsonPathSelection {
  offset: number
  returnedItems: number
  totalItems: number
  nextOffset: Nullable<number>
  serialized: string
  oversizedItemIndex?: number
}

/** 正文及非数组 JSON 子树的 UTF-16 字符窗口。 */
export interface PaginatedTextWindow {
  offset: number
  totalChars: number
  returnedChars: number
  nextOffset: Nullable<number>
  text: string
  /** offset 已越过正文末尾：模型多半在原地打转，必须显式告知而不是静默回第一页。 */
  beyondEnd: boolean
}

/**
 * 索引中一条可搜索消息的扁平条目（由 IndexBuilder 预计算 searchableText）。
 */
export interface ChatContextRetrievalIndexMessageEntry {
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
export interface ChatContextRetrievalIndexReferencedPath {
  path: string
  source: string
}

/**
 * 索引中一条工具 payload 的可搜索条目。
 */
export interface ChatContextRetrievalIndexToolPayloadEntry {
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
export interface ChatContextRetrievalIndexSnapshot {
  version: 2
  sessionId: string
  builtAt: number
  /** 用于判断索引是否 stale（宿主实现按会话载荷指纹比对）。 */
  sourceFingerprint: ChatContextRetrievalIndexSourceFingerprint
  messages: ChatContextRetrievalIndexMessageEntry[]
  toolPayloads: ChatContextRetrievalIndexToolPayloadEntry[]
  /**
   * **结构性恒空**：喂它的 evidence 流协议链已于 2026-08-06 整体下线，
   * {@link ContextRetrievalIndexBuilder.build} 现在直接发 `[]`。字段保留是因为
   * `历史检索服务({ refKind: 'evidence' })` 仍读它，而那份列表在实现史上从未非空过——
   * 保留即维持逐字相同的行为，删掉才是一次模型面工具形状的改动。
   */
  evidence: ChatContextEvidenceRecord[]
}

/** {@link ChatContextRetrievalIndexStore.save} 的可选入参。 */
export interface ChatContextRetrievalIndexSaveOptions {
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
 * 与 `readSourceFingerprint`）。宿主提供文件系统实现；内核只认端口不认实现——落盘策略、
 * 新鲜度指纹计算全在宿主侧。
 */
export interface ChatContextRetrievalIndexStore {
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
 * {@link rankContextText} 的完整打分输出。
 * 供会话搜索、history 搜索、terminal 搜索与 query trace 共用。
 */
export interface RankingSignals {
  /** 最终排序分 = semanticScore +（命中时）recency 微调；用于结果排序。 */
  score: number;
  /** 纯语义相关分（词项/路径/符号/错误/计划等加权之和），≤0 表示未命中。 */
  semanticScore: number;
  /** 人类可读命中原因，如「词项匹配」「路径重合」；空数组表示无有效信号。 */
  matchReasons: string[];
  /** 与 query 路径 hint 重合的路径；无重合时退回正文内提取的前 4 条路径 hint。 */
  pathHints: string[];
  /** 与 query 符号 hint 重合的标识符；无重合时退回正文内提取的前 4 条。 */
  symbolHints: string[];
  /** 消息在会话中的时间序位置，0=最早，1=最新；仅传入 index/total 时有意义。 */
  recencyScore: number;
  /** 正文中命中的错误关键词（最多 4 个逗号拼接）；用于 agent 收窄「同类报错」检索。 */
  errorFingerprint: LooseOptional<string>;
}

/**
 * 单条 {@link ChatMessage} 的扁平搜索索引。
 * `searchableText` 是 {@link rankContextText} 的实际输入。
 */
export interface MessageSearchIndex {
  /** 仅 text block 合并后的可见正文（不含 tool 结果）。 */
  text: string
  /** 本条消息内出现过的工具名（去重）。 */
  toolNames: string[]
  /**
   * 打分用拼接串：`text` + role + id + toolNames + 各 tool args 序列化。
   * 换行分隔，全部 lowerCase 匹配在 Ranking 内完成。
   */
  searchableText: string
}

/**
 * 带会话内序号的消息索引行。
 * {@link SessionSearchService} 用 messageIndex 参与 recency；
 * messageIndex=-1 表示「仅标题命中」的合成行。
 */
export interface IndexedSessionMessage {
  /** 消息 id；标题占位行为 `{sessionId}:title`。 */
  messageId: string
  /** 在 session.messages 中的下标；标题占位为 -1。 */
  messageIndex: number
  role: ChatMessage['role']
  timestamp: number
  /** 可见正文，snippet 优先取此字段。 */
  text: string
  /** 完整搜索面，见 {@link MessageSearchIndex.searchableText}。 */
  searchableText: string
}

/**
 * 扫描阶段发现的内部命令日志绝对路径。
 * `source` 记录该 path 在工具结果 JSON 中的逻辑位置，便于 debug。
 */
export interface ReferencedLogPath {
  /** 绝对路径，须通过 {@link ContextRetrievalReferences.isInternalCommandLogPath}。 */
  path: string
  /** 如 `serializedResult`、`displayResult.foo.logPath`。 */
  source: string
}

/**
 * 扫描阶段发现的内部 artifact 绝对路径。
 */
export interface ReferencedArtifactPath {
  /** 绝对路径，须含 `/.velaros/artifacts/`。 */
  path: string
  source: string
}

/**
 * {@link ContextRetrievalReferenceReader.readReferencedLogs} 的单条读盘结果。
 * content 为 null 时表示未读到有效文本（不存在、二进制、非内部路径等）。
 */
export interface LogReadSnippet {
  path: string
  source: string
  /** UTF-8 文本内容，经 truncate；null 表示不可用。 */
  content: LooseOptional<string>
  /** 文件字节大小；未知时为 null。 */
  size: LooseOptional<number>
  /** 是否因文件过大而 head+tail 采样。 */
  truncated: boolean
  /** 非致命问题说明（文件消失、二进制等）；null 表示正常。 */
  warning: LooseOptional<string>
}

/**
 * {@link ContextRetrievalReferenceReader.readReferencedArtifactManifests} 的单条结果。
 * 非文本 artifact 仅有 metadata，preview 为 null。
 */
export interface ArtifactManifestSnippet {
  path: string
  source: string
  filename: string
  /** 由 {@link ContextRetrievalReferences.inferArtifactType} 推断。 */
  type: string
  size: LooseOptional<number>
  /** 文本类 artifact 的文件头 preview；二进制为 null。 */
  preview: LooseOptional<string>
  warning: LooseOptional<string>
}

// 四条进程内容量上限都在 AgentTuning.retrieval：计数索引 countEntryLimit、构建遥测
// indexBuildTelemetrySessionLimit、终端输出候选 terminalOutputPayloadCandidateLimit，以及内存索引缓存
// cachedIndexSessionLimit——缓存的是整份索引快照（长会话可达数 MB），所以宁小勿大：真正的热点只有
// "当前正在跑的那个会话"，8 个槽位足以覆盖并行子 agent + 用户手动切换，再多只是拿内存换命不中的概率。

/** 建 `ChatContextRetrievalService` 时给的一组进程内容量上限；全部可以不传，不传就用本文件的缺省值。 */
export interface ChatContextRetrievalServiceOptions {
  /** handle/证据重复读取计数最多记多少个键，缺省 4096；键是「会话+scope+handle+jsonPath+offset」，满了按最近使用淘汰，被淘汰的 handle 重新从 1 数起（重复告警会漏报一次）。 */
  maxRetrievalCountEntries?: LooseOptional<number>;
  /** 索引构建遥测最多留多少个会话，缺省 512；只影响 `getRetrievalIndexDiagnostics` 能不能报出上次构建的来源和耗时。 */
  maxIndexBuildTelemetrySessions?: LooseOptional<number>;
  /** 搜终端输出时，每次最多挑多少条工具 payload 去读盘，缺省 64；这是读盘量的闸门，调大更全但更慢。 */
  maxTerminalOutputPayloadCandidates?: LooseOptional<number>;
  /** 内存里最多缓存几个会话的索引快照，缺省 8；一份快照长会话可达数 MB，热点其实只有当前在跑的那个，调大只是拿内存换命不中的概率。 */
  maxCachedIndexSessions?: LooseOptional<number>;
  /** 转给内部 `ContextRetrievalQueryTraceStore` 的容量上限，管查询计数表和每会话 trace 条数。 */
  queryTrace?: ContextRetrievalQueryTraceStoreOptions;
}

/** 建 `ContextRetrievalQueryTraceStore` 时给的两个容量上限；两项都可以不传，不传就用本文件的缺省值。 */
export interface ContextRetrievalQueryTraceStoreOptions {
  /** 查询计数表最多记多少个键，缺省 4096；键是「会话+scope+kind+归一化查询」，满了按最近使用淘汰，被淘汰的查询重新从 1 数起。 */
  maxQueryCountEntries?: LooseOptional<number>
  /** 每个会话保留多少条最近的 trace，缺省 24；只影响 `getRecent` 能回溯多远，超出的从最旧的丢。 */
  maxRecentQueryTracesPerSession?: LooseOptional<number>
}
