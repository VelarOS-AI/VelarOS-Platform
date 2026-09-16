/** 文件正文与显示范围绑定同一 revision；列号沿用 Project 的 UTF-16 口径。 */
import type { ModelMessage } from 'ai'

import type { ContextPayloadStore } from '../contract/requires.js'

import type { ContextUsageEstimate,ToolCategoryId } from './agent.js'
import type { AgentHistoryToolContext,SanitizeModelHistoryOptions, UserTextPayloadReference } from './history.js'
import type { ProviderRequestFingerprint } from './records.js'
import type { ContextHandoffSignal, GovernanceEpochReport } from './residency.js'

export interface FileContextRange {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

export interface FileContextSnapshot {
  workspaceId: string
  path: string
  revision: string
  exists: boolean
  content: string
  redacted?: boolean
  range: FileContextRange
  totalLines: number
  complete: boolean
  /** Non-editable source candidate. A final model projection may mint a view for its displayed subset. */
  viewSource?: string
  presentation?: {
    lines: Array<[number, string]>
    fragments?: Array<{ line: number; columns: [number, number]; text: string }>
    continuation?: unknown
    hasMore?: boolean
  }
}

/** 来源负责项目边界、权限和版本一致性；Agent 不直接访问文件系统。 */
export interface FileContextSource {
  workspaceId: string
  normalizePath(path: string): string
  validateArchive?(snapshot: FileContextSnapshot): Promise<void>
  read(path: string, ranges: readonly FileContextRange[], scopeId?: string): Promise<FileContextSnapshot[]>
  finalizeModelResult?(value: unknown, scopeId: string): Promise<unknown>
}

export interface FileContextCarrier {
  codingSession?: unknown
  fileContextScope?: object
  getCurrentVisibleToolNames?: () => string[]
  sessionId?: string
  contextPayloadStore?: ContextPayloadStore
  abortSignal?: AbortSignal
  toolCallId?: string
}

/**
 * 文件上下文的过继能力（调用方只认这个最小形状）。
 *
 * 新建一个派生上下文（子 Agent、换 surface）时调用一次：子侧先拿到自己的作用域，再按当前可见工具面
 * 决定继承父侧哪些已读文件的来源，从而既不串用父的作用域，也不丢掉父已经读过的文件。
 */
export interface ForkFileContext {
  /** 把父载体上的文件来源过继给刚建好的子载体；父侧没有文件上下文时只清空子侧作用域，不抛错。 */
  (parent: FileContextCarrier, child: FileContextCarrier): void
}

export interface FileSnapshotArchive extends FileContextSnapshot {
  kind: 'file-snapshot'
  version: 1
  sourceToolCallId?: string
}

/** requested：模型显式读取或修改过的文件；incidental：搜索命中等顺带观察，预算不足时先让位、先淘汰。 */
export type FileContextViewTier = 'requested' | 'incidental'

export interface FileContextView {
  workspaceId: string
  path: string
  sequence: number
  priority: number
  /** 缺省视为 requested。 */
  tier?: FileContextViewTier
  status: 'fresh' | 'dirty' | 'unavailable' | 'deleted'
  ranges: FileContextRange[]
  snapshots: FileContextSnapshot[]
  refs: Array<string | undefined>
  error?: string
}

export interface FileSnapshotRecallInput {
  path?: string
  revision?: string
  ref?: string
  offset?: number
  maxChars?: number
  maxResults?: number
}

export interface FileContextProjection {
  history: ModelMessage[]
  tail: ModelMessage[]
}

export interface CompileProviderSendRequestInput
  extends Omit<
    CompileProviderRequestInput,
    'messages' | 'toolPayloadRefsByToolCallId' | 'userTextPayloadRefsByHash'
  > {
  sessionId: string
  rawHistoryMessages: ModelMessage[]
  /** 稳定前缀消息（系统提示词稳定层 + 缓存断点）。逐轮字节不变，账本不摄入它们之外的东西。 */
  leadingMessages?: readonly ModelMessage[]
  phase: 'stream' | 'query'
  turn?: LooseOptional<number>
  payloadStore?: LooseOptional<ContextPayloadStore>
  toolContext?: AgentHistoryToolContext
  sanitizeOptions?: SanitizeModelHistoryOptions
  /** 为 true 时跳过异步 user-text 持久化，主要用于测试。 */
  skipUserTextPersistence?: boolean
  buildToolPayloadRefs?: (
    providerMessages: ModelMessage[]
  ) => Promise<LooseOptional<Record<string, string>>>
}

export interface CompiledProviderSendRequest extends CompiledProviderRequest {
  sanitizedHistoryMessages: ModelMessage[]
  providerMessages: ModelMessage[]
  userTextPayloadRefs: number
}

export interface ContextPayloadRecord {
  sessionId: string
  hash: string
  payloadRef: string
  toolCallId: string
  toolName: string
  serializedResult: string
  chars: number
  createdAt: number
}

export interface ContextUserTextRecord {
  sessionId: string
  hash: string
  payloadRef: string
  messageKey: string
  text: string
  chars: number
  createdAt: number
}

export interface BuildToolPayloadRefsForProviderMessagesInput {
  sessionId: string
  messages: ModelMessage[]
  store: ContextPayloadStore
  /**
   * 声明 outputInline 的工具（如 tooling:map / tooling:read）：其结果禁止被 page-out 成 payload
   * 引用。这里直接不为它们生成 ref，下游 dedupe/reclaim 因 `!payloadRef` 自然跳过，工具输出
   * 始终原样内联给模型，避免「模型看到 __contextRef 又得 context:recall 召回」的多余轮次。
   */
  isOutputInlineToolName?: (toolName: string) => boolean
}

export interface CompileProviderRequestInput {
  model: string
  systemPrompt: string
  messages: ModelMessage[]
  /** 会话标识；提供后治理账本跨回合存活（缺省则本轮一次性账本，治理退化为纯准入）。 */
  sessionId?: string
  /**
   * 治理账本键（缺省 = `sessionId`）。
   *
   * 只有一种情况要与 `sessionId` 分开：子 agent 与父会话共用 sessionId（`sessionId` 还要给
   * PayloadStore 当分区，改不得），但它们是两条完全不同的消息序列，共用一本账本会让父子交替编译
   * 每次都在第 0 条指纹分叉 → 整本重建（审计 U12）。
   */
  governanceSessionId?: LooseOptional<string>
  /**
   * 是否贴发送面传输装饰（prompt-cache 断点）。
   *
   * 只有**真的要发出去**的编译才开。默认关：`compile()` 因此保持"账本进、投影出"的纯粹形态，
   * 治理未触发时出口与摄入逐字等价这条断言锁不受装饰干扰。
   */
  applySendTransportDecorations?: LooseOptional<boolean>
  availableToolNames?: readonly string[]
  toolChoiceName?: LooseOptional<string>
  toolSchemaChars?: Record<string, number>
  toolSchemaHashes?: Record<string, string>
  providerTools?: readonly ProviderToolDefinitionSnapshotInput[]
  providerToolChoice?: unknown
  toolPayloadRefsByToolCallId?: Record<string, string>
  /** 发送路径为紧接失败的那一次决策还原了完整参数的调用；编译期结构自愈不再压缩它们。 */
  preserveToolCallInputIds?: ReadonlySet<string>
  /** 超长 user 正文的内容哈希 → 持久 payloadRef；准入信封用它跨进程精确召回。 */
  userTextPayloadRefsByHash?: Readonly<Record<string, string>>
  retrievalHandles?: ContextWorkingSetRetrievalHandleInput[]
  activeTask?: LooseOptional<ContextActiveTaskInput>
  pinnedEvidence?: readonly ContextPinnedEvidenceInput[]
  resourceState?: LooseOptional<ContextResourceStateInput>
  contextUsageOptions?: EstimateContextUsageOptions
  contextWindow?: LooseOptional<number>
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  calibrationFactor?: LooseOptional<number>
  /**
   * 活动尾块：系统提示词 dynamic 层、turn-context 增量等**逐轮易变**的注入内容。
   * 排在账本投影之后，永不进稳定前缀（P7-1）。
   */
  tailBlocks?: readonly ModelMessage[]
  historyRewriteSignals?: readonly ProviderHistoryRewriteSignal[]
  /** canonical tool id → provider-safe request-local name. Persistent history remains canonical. */
  toolNameAliases?: Readonly<Record<string, string>>
}

export type ProviderRequestPressureKind =
  | 'none'
  | 'tokens'
  | 'payload'
  | 'tool-schema'
  | 'mixed'

export interface ProviderRequestCompileDecision {
  okToSend: boolean
  pressureKind: ProviderRequestPressureKind
  reason: string
  zoneDiagnostics: ProviderRequestZoneDiagnostic[]
}

export interface ProviderRequestZoneDiagnostic {
  zone: ContextWorkingSetZoneId
  usedTokens: number
  effectiveLimitTokens: number
  overBudgetTokens: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export interface CompiledProviderRequest {
  system: string
  messages: ModelMessage[]
  ledger: ContextLedgerEntry[]
  estimate: ContextUsageEstimate
  decision: ProviderRequestCompileDecision
  requestFingerprint: ProviderRequestFingerprint
  /** 真实组装终点的可持久化请求快照；发送前由 turn 路径校验完整性。 */
  providerRequest: ProviderRequestSnapshot
  /** 本轮跑过的治理 epoch 报告；未触发时为 null。 */
  governanceEpoch?: LooseOptional<GovernanceEpochReport>
  /** 会话累计已应用的 epoch 代数（跳过的 epoch 不计代，与 dashboard 上的号同源）。 */
  governanceEpochSeq?: LooseOptional<number>
  /** 治理后的投影占用（token）与驻留态计数，供调试面与 scoreboard 消费。 */
  governanceOccupancyPercent?: LooseOptional<number>
  /**
   * 转交信号（设计 §4）。B1 起送核门失去回收阶梯的二次挽救，**压力的唯一出路是转交**，
   * 所以这条信号必须沿编译结果一路出到壳侧的布防看门，不能只留在治理器内部。
   */
  governanceHandoff?: LooseOptional<ContextHandoffSignal>
  historyRewriteFingerprint?: string
}

export interface ProviderHistoryRewriteSignal {
  kind: string
  details: unknown
}

/** 本轮治理量纲：历史密度 + 账本正文之外的固定开销。 */
export interface ContextGovernanceRuler {
  /** 字符/token 密度（账本正文字符 → token 的换算尺）。 */
  charsPerToken: number
  /** 系统提示词 + 工具清单/schema + 稳定前缀 + 活动尾 + 保留上下文折成的 token 数。 */
  fixedOverheadTokens: number
}

export interface AgentLoopToolDescriptor {
  name: string
  description: string
  categoryId?: LooseOptional<ToolCategoryId>
}

export interface AgentLoopToolRegistry<TToolContext> {
  listAvailable(toolContext: TToolContext, allowedTools: string[]): AgentLoopToolDescriptor[]
  /**
   * 可选实现：返回当前可见工具集 JSON Schema 总字节数（含 name/description/wrapper）。
   * 提供时用它精确扣留上下文预算；缺省时回落到 `tools.length * 800` 启发值。
   */
  estimateToolsSerializedChars?(toolContext: TToolContext, allowedTools: string[]): number
}

export interface PersistUserTextPayloadsResult {
  references: UserTextPayloadReference[]
}

export interface CanonicalizeToolResultInput {
  sessionId: string
  toolCallId: string
  toolName: string
  serializedResult: string
}

export interface CanonicalToolResultVisibleReference {
  type: 'tool-payload-ref'
  toolCallId: string
  toolName: string
  payloadRef: string
  hash: string
  chars: number
  sameAsToolCallId?: string
}

export interface CanonicalToolResult {
  action: 'inline' | 'reference' | 'dedupe-reference'
  hash: string
  payloadRef: string
  record: ContextPayloadRecord
  visible: CanonicalToolResultVisibleReference
}

export interface HashedToolResultInput {
  input: CanonicalizeToolResultInput
  hash: string
}

/** 单次扫描的中间结果：工具引用面 + 折叠句柄计数，作为共享 scratch 的扫描位。 */
export interface ToolReferenceScan {
  toolNames: Set<string>
  toolCallIds: Set<string>
  toolResultIds: Set<string>
  contextRefCount: number
}

export type ProviderRequestAuditValue = Nullable<
  boolean
  | number
  | string
  | ProviderRequestAuditValue[]
  | { [key: string]: ProviderRequestAuditValue }
>

export interface ProviderVisibleRetainedContextResult {
  messages: ModelMessage[]
  /** 追加的保留上下文消息；无保留块则 null。追加不移动既有 `message:<index>`，故无需 offset。 */
  retainedMessage: Nullable<ModelMessage>
}

export interface ContextWorkingSetRetrievalHandleInput {
  id: string
  summary: string
  estimatedChars?: number
  payloadRef?: string
  stale?: boolean
}

export interface ContextActiveTaskInput {
  id?: LooseOptional<string>
  title?: LooseOptional<string>
  summary?: LooseOptional<string>
  state?: LooseOptional<string>
  latestFailure?: LooseOptional<string>
  updatedAt?: LooseOptional<number>
  metadata?: LooseOptional<Record<string, unknown>>
}

export interface ContextPinnedEvidenceInput {
  id: string
  kind?: LooseOptional<'evidence' | 'user-constraint'>
  content: string
  summary?: LooseOptional<string>
  source?: LooseOptional<string>
  payloadRef?: LooseOptional<string>
  filePath?: LooseOptional<string>
  contentHash?: LooseOptional<string>
  resourceRevision?: LooseOptional<string>
  recoverable?: LooseOptional<boolean>
  stale?: LooseOptional<boolean>
  verified?: LooseOptional<boolean>
}

export interface ContextResourceItemStateInput {
  path: string
  hash?: LooseOptional<string>
  revision?: LooseOptional<string>
  mtimeMs?: LooseOptional<number>
}

export interface ContextResourceStateInput {
  revision?: LooseOptional<string>
  files?: readonly ContextResourceItemStateInput[]
}

export interface ClassifyContextWorkingSetInput {
  systemPrompt: string
  messages: ModelMessage[]
  toolSchemaChars?: Record<string, number>
  retrievalHandles?: ContextWorkingSetRetrievalHandleInput[]
  activeTask?: LooseOptional<ContextActiveTaskInput>
  pinnedEvidence?: readonly ContextPinnedEvidenceInput[]
  resourceState?: LooseOptional<ContextResourceStateInput>
}

export interface ClassifiedContextWorkingSet {
  blocks: ContextWorkingSetBlock[]
}

export interface ProviderToolDefinitionSnapshotInput {
  name: string
  canonicalName: string
  description: string
  inputSchema: unknown
  schemaChars: number
  schemaHash: Nullable<string>
}

export interface ProviderToolDefinitionSnapshot
  extends Omit<ProviderToolDefinitionSnapshotInput, 'inputSchema'> {
  inputSchema: ProviderRequestAuditValue
}

/** 模型请求组装终点的可持久化事实；不含密钥、provider client 或执行函数。 */
export interface ProviderRequestSnapshot {
  schemaVersion: 1
  model: string
  system: string
  messages: ProviderRequestAuditValue
  tools: ProviderToolDefinitionSnapshot[]
  toolChoice: ProviderRequestAuditValue
  requestFingerprint: ProviderRequestFingerprint
}

/** 管线内流转的请求草稿：当前 provider 消息序列。 */
export interface ProviderRequestDraft {
  messages: ModelMessage[]
}

/** stage 输出：改写后的草稿消息 + 本 stage 贡献的历史改写签名。 */
export interface ProviderRequestStageOutput {
  messages: ModelMessage[]
  rewriteSignals: readonly ProviderHistoryRewriteSignal[]
}

/**
 * 跨 stage 共享上下文。每次编译单开一份（编译 pass 局部），承载会被多 stage 复用的
 * 中间扫描结果，避免各 stage 各扫一遍。
 */
export interface ProviderRequestScratch {
  /** provider 消息单次扫描结果，懒填充一次后复用（出核地板指纹与诊断共享）。 */
  toolReferenceScan: Nullable<ToolReferenceScan>
}

/**
 * stage 统一契约类型：治理管线的可插拔 seam。四个消息改写 stage
 * （tool-result-rewrite / history-sanitize / attention / retained-context）语义贴合此形态；
 * compaction 的回收阶梯是 pass 间驱动、budget 是出核前的终态装配，签名各自贴合数据流。
 */
export type ProviderRequestStage = (
  draft: ProviderRequestDraft,
  scratch: ProviderRequestScratch
) => ProviderRequestStageOutput

/** 送核门的窗口口径（{@link resolveContextUsageWindow} 的产物）。 */
export interface ContextUsageWindow {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
}

export interface EstimateContextUsageOptions {
  contextWindow?: LooseOptional<number>
  extraContext?: unknown
  extraEstimatedTokens?: LooseOptional<number>
  extraEstimatedChars?: LooseOptional<number>
  /**
   * 为模型本轮输出预留的 token 数；提供后 tokenPercent 改对“可用窗口”计量。
   * 不提供时退化为旧行为（usable == contextWindow），保持向后兼容。
   */
  reservedOutputTokens?: LooseOptional<number>
  /** 安全余量百分比，吸收本地估算与供应方计费口径偏差；与 reservedOutputTokens 同为可选。 */
  safetyMarginPercent?: LooseOptional<number>
  /**
   * MMU 校准系数：由 ContextUsageCalibrator 依据“估算↔真实”残差学习得到，
   * 乘到 estimatedTokens 上以贴近供应方真实输入用量。缺省/非法时按 1 处理。
   */
  calibrationFactor?: LooseOptional<number>
}

export type TokenizerEngine = 'heuristic' | 'tiktoken'

export interface SourceFragment { line: number; columns: number[]; text: string }

export type ContextWorkingSetBlockSource = string

export interface ContextWorkingSetBlockProvenance {
  source: ContextWorkingSetBlockSource
  messageIndex?: number
  toolCallId?: string
  toolName?: string
  payloadRef?: string
  filePath?: string
  resourceRevision?: string
  contentHash?: string
}

export interface ContextWorkingSetBlockLifecycle {
  pinned: boolean
  activeTask: boolean
  consumed: boolean
  verified: boolean
  stale: boolean
  expired: boolean
  recoverable: boolean
}

export interface ContextWorkingSetBlockSafety {
  containsUserInstruction: boolean
  containsPermissionDecision: boolean
  containsFailureCause: boolean
  containsUntrustedContent: boolean
  requiresExactQuote: boolean
  statefulToolResult: boolean
  containsSecret: boolean
}

export interface ContextWorkingSetBlock {
  id: string
  zone: ContextWorkingSetZoneId
  priority: number
  chars: number
  estimatedTokens: number
  contentText?: string
  provenance?: ContextWorkingSetBlockProvenance
  lifecycle?: ContextWorkingSetBlockLifecycle
  safety?: ContextWorkingSetBlockSafety
  payloadRef?: string
  embedding?: number[]
  hash?: string
  stale?: boolean
  reclaim: ContextWorkingSetReclaimAction
  content: unknown
}

export interface ContextLedgerEntry {
  id: string
  zone: ContextWorkingSetZoneId
  chars: number
  estimatedTokens: number
  action: 'inline' | 'reference' | 'dedupe-reference' | 'summary' | 'drop'
  reason: string
  toolCallId?: string
  toolName?: string
  hash?: string
  ref?: string
  zoneReservedTokens?: number
  zoneLimitTokens?: number
  zoneEffectiveLimitTokens?: number
  zoneUsedTokens?: number
  zoneOverBudgetTokens?: number
}

/** 校验相位标记：目前仅编译期一处出核，保留类型以备未来 seam 扩展。 */
export type AssertProviderRequestInvariantPhase = 'compile'

export interface ContextWindowBudget {
  /** 模型上下文窗口原始大小（token）。 */
  contextWindow: number
  /** 扣除输出预留与安全余量后，输入侧真正可用的额度（token）。 */
  usableContextWindow: number
  /** 为模型本轮输出预留的 token 数。 */
  reservedOutputTokens: number
  /** 实际采用的安全余量百分比。 */
  safetyMarginPercent: number
}

export interface ResolveContextWindowBudgetInput {
  contextWindow: number
  /** 显式输出预留；缺省时按窗口比例自动推导并夹在上下限之间。 */
  reservedOutputTokens?: LooseOptional<number>
  /** 显式安全余量百分比；缺省采用默认值。 */
  safetyMarginPercent?: LooseOptional<number>
}

export type ContextRefKind =
  | 'tool-output'
  | 'micro-compacted-tool-result'
  | 'attention-context-handle'
  | 'attention-code-pruned-context-handle'
  | 'attention-grounded-summary'
  | 'tool-payload-ref'
  | 'duplicate-tool-result'
  | 'history-budget-truncated'

export interface ContextRefRetrieval {
  tool: 'context:recall'
  args: {
    ref: string
    refKind: 'tool-payload' | 'payload-ref' | 'context-handle' | 'evidence'
    reason?: string
    maxChars?: number
    jsonPath?: string
  }
}

export interface ContextRefEnvelope {
  /** 唯一判别键;嗅探恒用 '"__contextRef"' 字符串。 */
  __contextRef: ContextRefKind
  /** 信封版本。 */
  v: 1
  /** 规范召回引用,恒等于 retrieval.args.ref。 */
  ref: string
  toolCallId?: string
  toolName?: string
  /** ctx-payload:* 内容寻址引用。 */
  payloadRef?: string
  payloadHash?: string
  excerpt?: string
  excerptKind?: 'structured' | 'head' | 'facts' | 'code' | 'text' | 'json'
  /** false=摘录未截断(内容已完整可见,不必召回);true/缺省=可能需要召回。 */
  excerptTruncated?: boolean
  originalLength?: number
  /** 折叠原因。 */
  reason?: string
  /** 恒存在恒同形;excerptTruncated:false 时仍带(供一致解析),但模型不应对未截断内容空转召回。 */
  retrieval: ContextRefRetrieval
  /** kind 扩展字段(如 attention-code-pruned 的 meta.codePruning)。 */
  meta?: Record<string, unknown>
}

export interface FileRenameArchive {
  kind: 'file-rename'
  workspaceId: string
  from: string
  to: string
  beforeRevision: string
  afterRevision: string
  refs: string[]
}

export type ContextWorkingSetZoneId =
  | 'kernel'
  | 'tool-schemas'
  | 'active-task'
  | 'pinned-evidence'
  | 'recent-turns'
  | 'semantic-summary'
  | 'retrieval-index'
  | 'recall'
  | 'tool-payloads'
  | 'diagnostics'

export type ContextWorkingSetReclaimAction =
  | 'keep'
  | 'summarize'
  | 'reference'
  | 'evict'
  | 'page-out'

export interface ContextWorkingSetZonePolicy {
  zone: ContextWorkingSetZoneId
  reservedRatio: number
  limitRatio: number
  priority: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export interface ContextWorkingSetBudgetLedgerEntry {
  zone: string
  estimatedTokens: number
}

export interface ContextWorkingSetBudgetGovernorInput {
  contextWindow: number
  usableContextWindow?: LooseOptional<number>
  reservedOutputTokens?: LooseOptional<number>
  safetyMarginPercent?: LooseOptional<number>
  ledger: readonly ContextWorkingSetBudgetLedgerEntry[]
  policies?: LooseOptional<Record<ContextWorkingSetZoneId, ContextWorkingSetZonePolicy>>
}

export interface ContextWorkingSetZoneBudgetSnapshot {
  zone: ContextWorkingSetZoneId
  reservedTokens: number
  limitTokens: number
  effectiveLimitTokens: number
  usedTokens: number
  overBudgetTokens: number
  priority: number
  reclaimOrder: ContextWorkingSetReclaimAction[]
}

export interface ContextWorkingSetBudgetAllocation {
  contextWindow: number
  usableContextWindow: number
  reservedOutputTokens: number
  safetyMarginPercent: number
  totalUsedTokens: number
  totalOverBudgetTokens: number
  zones: Record<ContextWorkingSetZoneId, ContextWorkingSetZoneBudgetSnapshot>
}
