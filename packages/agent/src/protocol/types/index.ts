import type { SerializedError } from '@velaros-ai/core/error'

import type { ContextUsageEstimate } from '../../agent/context/contextUsage'

import type {
  AgentDeveloperContext,
  AgentSurfaceId,
  ChatPromptFeatureId,
  DebugModelMessage,
  StreamAssistantGeneratedFilePayload,
  StreamAssistantRawPayload,
  StreamToolResultEffects,
  StreamToolResultModelImage,
  StreamTurnContextPayload,
  StreamWorkerThreadPayload,
} from './agent'
import type { StreamStatePayload } from './chatRuntime'
import type {
  ChatContextEvidenceRecord,
  ChatContextUsageAccountingConfidence,
  ChatContextUsageAccountingSource,
} from './chatRuntime'
import type {
  ExecutionEventRecord,
  ExecutionPlanView,
  ExecutionStatus,
  ExecutionTaskExecutionAdvice,
  ExecutionTaskRecord,
} from './execution'
import type { RunProfileSelectionId } from './runProfile'
import type { SessionLineageContext } from './storage'
import type { AgentRoleId, AppLocale } from './system'
import type { ReasoningLevel, ThinkingDepth } from './team'
import type {
  CapabilityAutoApprovalNoticeBlock,
  CapabilityScopeId,
  ToolCategoryId,
  ToolSurfaceProfileId,
  UserActionCardBlock,
} from './tool'
import type { ChatMessageTurnContext, ContextDeltaReceipt } from './turnContext'

export * from './agent'
export * from './agentWorkflow'
export * from './chatRuntime'
export * from './execution'
export * from './runProfile'
export * from './skill'
export * from './storage'
export * from './subAgentTask'
export * from './system'
export * from './team'
export * from './tool'
export * from './turnContext'

// ─── 消息内容块 ───────────────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
  tone?: 'default' | 'error'
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  streamId?: string
  translatedText?: string
  translatedLocale?: AppLocale
  translationVisible?: boolean
}

export interface ToolCallBlock {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** 工具所属类别，由后端注入，前端直接用于渲染，不再需要工具名映射表 */
  categoryId?: ToolCategoryId
  /** 填入后表示该工具已执行完毕 */
  result?: unknown
  /** 发送给模型前裁剪过的工具结果 */
  serializedResult?: string
  /** 工具结果已移到隐藏的宿主资源文件中 */
  resultStoredExternally?: boolean
  /** 工具执行出错时的错误信息 */
  error?: string
  /** 是否正在执行 */
  isRunning?: boolean
  /** 工具开始执行的客户端时间戳 */
  startedAt?: number
  /** 工具结束执行的客户端时间戳 */
  finishedAt?: number
  /** 工具执行期间流式上报的进度文本，不进入模型历史 */
  progress?: string
  /** 工具执行期间上报的结构化展示标题，不进入模型历史 */
  title?: string
  /** 工具执行期间上报的结构化展示元数据，不进入模型历史 */
  metadata?: Record<string, unknown>
  /** 工具副作用语义，由后端计算后附加，前端无需解析结果 */
  effects?: StreamToolResultEffects
  /** Widget artifact lightweight reference; large content is stored externally. */
  widgetArtifact?: ChatSessionWidgetArtifactRef
  /** 当前内存/已水化的 widget artifact 版本快照，持久化主 session 时会卸载。 */
  widgetArtifactSnapshot?: ChatSessionWidgetArtifactVersion
  /** 工具提供给模型读取的图片数据，仅用于聊天界面预览，持久化时会卸载。 */
  modelImage?: StreamToolResultModelImage
}

export interface ChatSessionWidgetArtifactRef {
  artifactId: string
  versionId: string
}

export interface ChatSessionWidgetArtifactVersion extends ChatSessionWidgetArtifactRef {
  title: string
  htmlSource: string
  compiledHtml: string
  sessionId: string
  createdFromMessageId: string
  createdFromToolCallId: string
  createdAt: number
}

export interface HtmlArtifactBlock {
  type: 'html-artifact'
  artifactId: string
  protocolVersion?: string
  title: string
  html: string
  protocolText?: string
  protocolDiagnostics?: HtmlArtifactProtocolDiagnostic[]
  patches?: HtmlArtifactRenderPatch[]
  patchRevision?: number
  isStreaming?: boolean
  initialHeight?: number
  updateCount?: number
  createdAt?: number
  updatedAt?: number
}

export interface AssistantGeneratedFileBlock {
  type: 'assistant-generated-file'
  id: string
  mediaType: string
  data?: string
  size: number
  filename?: string
  storedExternally?: boolean
}

export interface AssistantSourceBlock {
  type: 'assistant-source'
  id: string
  sourceType: 'url'
  url: string
  title?: string
}

export type HtmlArtifactRenderPatch =
  | { type: 'replace'; target?: string; html: string }
  | { type: 'append'; target?: string; html: string }
  | { type: 'style'; styleId: string; css: string }
  | { type: 'script'; scriptId: string; code: string }

export interface HtmlArtifactProtocolDiagnostic {
  code: string
  message: string
  phase: 'protocol'
  patchType?: HtmlArtifactRenderPatch['type']
  patchId?: string
  createdAt?: number
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | HtmlArtifactBlock
  | AssistantGeneratedFileBlock
  | AssistantSourceBlock
  | CapabilityAutoApprovalNoticeBlock
  | UserActionCardBlock

export interface ChatAttachmentMeta {
  id: string
  kind: 'image' | 'file'
  name: string
  mediaType: string
  size: number
  path?: string
  lastModified?: number
}

export interface SerializedImageAttachment {
  id: string
  kind: 'image'
  filename: string
  mediaType: string
  data: string
  size: number
}

// ─── 渲染层消息（含 UI 状态，不跨 IPC） ───────────────────────────────────────

/**
 * 会话内的产品语义，与发给模型的 `role` 正交。
 *
 * `run-guidance` / `interaction-reply` 在模型协议里仍是 user role，但它们属于当前运行内部，
 * 不能被窗口分节、回卷或“最近一次用户诉求”等逻辑误判成一轮新对话。
 */
export type ChatMessageConversationKind =
  | 'turn-input'
  | 'run-guidance'
  | 'interaction-reply'
  | 'assistant-output'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** 产品会话语义；缺失仅用于读取旧消息时按 role / guidanceStatus 推断。 */
  conversationKind?: ChatMessageConversationKind
  /** 一次用户提交触发的完整运行边界；用于上下文压缩识别最后一轮。 */
  runId?: string
  /** 当前聊天轮次边界；初始与 runId 相同，后续可细分多 turn 运行。 */
  turnId?: string
  /** 结构化内容块列表；纯文本时 blocks 只有一个 TextBlock */
  blocks: ContentBlock[]
  attachments?: ChatAttachmentMeta[]
  /** 发送时冻结的环境回合上下文（receipt + 气泡 chips）；仅用户消息。 */
  turnContext?: ChatMessageTurnContext
  serialized?: SerializedMessage
  /** 用户原始 serialized payload 已移到隐藏的宿主资源文件中 */
  serializedStoredExternally?: boolean
  /** 用户在运行中补充给下一轮的引导消息状态。 */
  guidanceStatus?: 'awaiting-decision' | 'pending' | 'sent'
  /** 毫秒时间戳，由客户端本地生成 */
  timestamp: number
}

interface ChatMessageConversationSemanticInput {
  readonly role?: unknown
  readonly conversationKind?: unknown
  readonly guidanceStatus?: unknown
}

/** 旧消息只在读取时推断；所有新 user-role 消息创建路径都应显式写 conversationKind。 */
export function resolveChatMessageConversationKind(
  message: ChatMessageConversationSemanticInput
): ChatMessageConversationKind {
  // 持久化/IPC 外框可能只把 role 声明成 string；未知或非 user role 必须 fail closed，
  // 不能被分页、回卷和“最近一次用户诉求”逻辑误判成新一轮输入。
  if (message.role !== 'user') return 'assistant-output'
  if (
    message.conversationKind === 'turn-input' ||
    message.conversationKind === 'run-guidance' ||
    message.conversationKind === 'interaction-reply'
  )
    return message.conversationKind

  return message.guidanceStatus ? 'run-guidance' : 'turn-input'
}

export function isConversationTurnInputMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'turn-input'
}

export function isRunGuidanceMessage(
  message: ChatMessageConversationSemanticInput
): boolean {
  return resolveChatMessageConversationKind(message) === 'run-guidance'
}

// ─── IPC 传输格式（纯数据，主进程用来构造 CoreMessage） ───────────────────────

/**
 * 跨 IPC 传输的历史消息格式
 * 将 ChatMessage 的 blocks 扁平化，方便主进程直接转为 ai SDK CoreMessage
 */
export interface SerializedMessage {
  /** 来源 ChatMessage id，用于跨进程校验压缩边界。 */
  messageId?: string
  /** 来源 ChatMessage runId。 */
  runId?: string
  /** 来源 ChatMessage turnId。 */
  turnId?: string
  /** 来源 ChatMessage timestamp，用于主进程校验压缩视图边界。 */
  timestamp?: number
  role: 'user' | 'assistant'
  /** 纯文本块 */
  textBlocks: string[]
  /** 用户消息中附带的图片输入，会按 image part 发送给模型 */
  imageAttachments?: SerializedImageAttachment[]
  /** 已完成的 tool call，用于重建多轮上下文 */
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    /** 发送给模型前裁剪过的工具参数，避免生成文件等大输入被跨轮回放 */
    args: Record<string, unknown>
    /** 发送给模型前裁剪过的工具结果，避免跨次请求时上下文膨胀 */
    serializedResult?: string
  }>
}

export interface ChatSendRequest {
  sessionId: string
  resourceId?: LooseOptional<string>
  messages: SerializedMessage[]
  modelContextView?: LooseOptional<ChatSendContextView>
  sessionLineage?: LooseOptional<SessionLineageContext>
  locale?: AppLocale
  provider?: string
  thinkingDepth?: ThinkingDepth
  /** Composer 思考力度 5 档（off/low/medium/high/ultra）；优先于 thinkingDepth，决定本次请求 reasoning 力度。 */
  reasoningLevel?: ReasoningLevel
  model?: string
  promptFeatures?: ChatPromptFeatureId[]
  goalMode?: boolean
  /** 纯聊天模式，与 space 正交：由 active context 的 pureChatMode 显式传入，不再由 space===System 推断。 */
  pureChatMode?: boolean
  scope?: CapabilityScopeId
  runProfile?: RunProfileSelectionId
  selectedSkillIds?: string[]
  toolSurfaceProfile?: ToolSurfaceProfileId
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  developerContext?: LooseOptional<AgentDeveloperContext>
  /** 本次发送冻结的环境回合上下文回执；main 在 accept 后据此推进 cursor。 */
  turnContextReceipt?: LooseOptional<ContextDeltaReceipt>
}

export interface ExecutionProvideGuidanceRequest {
  sessionId: string
  message: SerializedMessage
}

export interface ChatTranslateThinkingRequest {
  sessionId: string
  messageId: string
  blockIndex: number
  text: string
  locale: AppLocale
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatTranslateThinkingResponse {
  text: string
}

export interface ChatSummarizeForHandoffRequest {
  sessionId: string
  /** 供续跑简报总结的对话正文（调用方已做裁剪/序列化）。 */
  transcript: string
  /** 会话的资源范围提示（本地根路径 / 远端 URL 等），供简报点明落点。 */
  scopeHint?: string
  locale: AppLocale
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatSummarizeForHandoffResponse {
  brief: string
}

export type ChatSuggestionPhase = 'new-session' | 'next-turn'

export interface ChatSuggestionItem {
  id: string
  title: string
  prompt: string
  reason: string
  confidence: number
}

export interface ChatGenerateSuggestionsRequest {
  sessionId: string
  phase: ChatSuggestionPhase
  locale: AppLocale
  /** Opaque capability scope used by injected suggestion context providers. */
  scope?: CapabilityScopeId
  resourceId?: string
  scopeMetadata?: Record<string, unknown>
  scopeHint?: string
  /** next-turn only：renderer 已裁剪并序列化的最近对话。 */
  transcript?: string
  provider?: string
  model?: string
  thinkingDepth?: ThinkingDepth
}

export interface ChatGenerateSuggestionsResponse {
  suggestions: ChatSuggestionItem[]
  sourceCount: number
}

// 手动压缩功能已移除(2026-07-18 用户裁决:压缩由内部看门自治);旧落盘数据里的 'manual'
// 在恢复时归一为 'auto'。
export type ChatContextCompactionTrigger = 'auto'

export interface ChatSendContextView {
  viewId: string
  messages: DebugModelMessage[]
  coveredMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
}

export type ChatContextOSSourceKind = string

export interface ChatContextOSSourceSnapshot {
  kind: ChatContextOSSourceKind
  count: number
  label: string
  estimatedChars?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface ChatContextOSSourceGraphSnapshot {
  sessionId: string
  capturedAt: number
  sources: ChatContextOSSourceSnapshot[]
}

export type ChatContextPipelineProfileId = string
export type ChatContextPipelineStageId = string
export type ChatContextBudgetLaneId = string

export type ChatContextPipelineStageStatus = 'completed' | 'skipped' | 'pending'

export interface ChatContextPipelineStageRun {
  id: ChatContextPipelineStageId
  required: boolean
  status: ChatContextPipelineStageStatus
  reason?: LooseOptional<string>
}

export interface ChatContextBudgetLaneDefinition {
  id: ChatContextBudgetLaneId
  priority: number
  minPercent: number
  maxPercent: number
}

export interface ChatContextPipelineRun {
  profile: ChatContextPipelineProfileId
  stages: ChatContextPipelineStageRun[]
  budgetLanes: ChatContextBudgetLaneDefinition[]
  notes: string[]
}

export interface ChatContextDebugTraceEntry {
  stage: ChatContextPipelineStageId
  action: 'inline' | 'summarize' | 'handle' | 'drop' | 'skip' | 'estimate' | 'retain'
  target: string
  reason: string
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export type ChatContextRetrievalHandleKind = string

export interface ChatContextRetrievalHandle {
  id: string
  kind: ChatContextRetrievalHandleKind
  sessionId: string
  sourceMessageIndex: Nullable<number>
  role?: LooseOptional<SerializedMessage['role']>
  toolCallId?: LooseOptional<string>
  toolName?: LooseOptional<string>
  label: string
  summary: string
  estimatedChars: number
  priority: number
  metadata?: Record<string, unknown>
}

export interface ChatContextRetrievePayloadRequest {
  sessionId: string
  handleId: string
  jsonPath?: LooseOptional<string>
  /** jsonPath 命中数组时的起始条目（0 起）；配合 __truncatedItems 标记的 nextOffset 续读。 */
  offset?: LooseOptional<number>
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  reason?: LooseOptional<string>
  maxChars?: LooseOptional<number>
}

export interface ChatContextRetrievedPayload {
  handleId: string
  sessionId: string
  found: boolean
  kind: ChatContextRetrievalHandleKind | 'unknown'
  content: Nullable<string>
  repeated: boolean
  retrievalCount: number
  warning?: LooseOptional<string>
  metadata?: Record<string, unknown>
}

export interface ChatContextSearchConversationHistoryRequest {
  sessionId: string
  query: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxResults?: LooseOptional<number>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchConversationHistoryItem {
  handleId: string
  messageId: string
  messageIndex: number
  role: SerializedMessage['role'] | ChatMessage['role']
  timestamp: number
  score: number
  matchReasons: string[]
  pathHints: string[]
  symbolHints: string[]
  recencyScore: number
  errorFingerprint: Nullable<string>
  summary: string
  matchedText: Nullable<string>
  toolNames: string[]
}

export interface ChatContextSearchConversationHistoryResult {
  sessionId: string
  query: string
  totalMessages: number
  items: ChatContextSearchConversationHistoryItem[]
  trace: ChatContextRetrievalQueryTraceEntry
  retryHints?: LooseOptional<string[]>
  warning?: LooseOptional<string>
}

export interface ChatContextReadEvidenceRequest {
  sessionId: string
  evidenceId: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxChars?: LooseOptional<number>
}

export interface ChatContextReadEvidenceResult {
  sessionId: string
  evidenceId: string
  found: boolean
  evidence: Nullable<ChatContextEvidenceRecord>
  payloadHandleId: Nullable<string>
  repeated?: boolean
  retrievalCount?: number
  warning?: LooseOptional<string>
}

export interface ChatContextReadToolPayloadRequest {
  sessionId: string
  toolCallId?: string
  payloadRef?: string
  jsonPath?: LooseOptional<string>
  /** jsonPath 命中数组时的起始条目（0 起）；配合 __truncatedItems 标记的 nextOffset 续读。 */
  offset?: LooseOptional<number>
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  reason?: LooseOptional<string>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchTerminalOutputRequest {
  sessionId: string
  query: string
  retrievalScopeId?: LooseOptional<string>
  sessionLineage?: LooseOptional<SessionLineageContext>
  maxResults?: LooseOptional<number>
  maxChars?: LooseOptional<number>
}

export interface ChatContextSearchTerminalOutputItem {
  handleId: string
  toolCallId: string
  logPath: string
  source: string
  score: number
  matchReasons: string[]
  snippet: string
  truncated: boolean
  warning?: LooseOptional<string>
}

export interface ChatContextSearchTerminalOutputResult {
  sessionId: string
  query: string
  items: ChatContextSearchTerminalOutputItem[]
  trace: ChatContextRetrievalQueryTraceEntry
  retryHints?: LooseOptional<string[]>
  warning?: LooseOptional<string>
}

export interface ChatContextRetrievalIndexSourceFingerprint {
  stateMtimeMs: Nullable<number>
  payloadMtimeMs: Nullable<number>
  payloadFingerprint: Nullable<string>
}

export type ChatContextRetrievalQueryKind = 'conversation-history' | 'terminal-output' | 'evidence'

export interface ChatContextRetrievalScoreBucket {
  label: string
  minScore: number
  maxScore: number
  count: number
}

export interface ChatContextRetrievalScoreStats {
  min: Nullable<number>
  max: Nullable<number>
  average: Nullable<number>
  buckets: ChatContextRetrievalScoreBucket[]
}

export interface ChatContextRetrievalQueryTraceEntry {
  id: string
  sessionId: string
  retrievalScopeId: string
  kind: ChatContextRetrievalQueryKind
  query: string
  normalizedQuery: string
  requestedAt: number
  repeated: boolean
  retrievalCount: number
  totalCandidates: number
  matchedCount: number
  returnedCount: number
  topScore: Nullable<number>
  topHandleIds: string[]
  matchReasons: string[]
  scoreStats: ChatContextRetrievalScoreStats
  warning?: LooseOptional<string>
}

export type ChatContextRetrievalIndexLoadSource =
  | 'fresh-index'
  | 'rebuilt-index'
  | 'missing-index'
  | 'invalid-index'
  | 'stale-index'

export interface ChatContextRetrievalIndexDiagnostics {
  sessionId: string
  indexPath: string
  exists: boolean
  fresh: boolean
  staleReason: Nullable<string>
  builtAt: Nullable<number>
  sourceFingerprint: Nullable<ChatContextRetrievalIndexSourceFingerprint>
  currentFingerprint: ChatContextRetrievalIndexSourceFingerprint
  messageCount: number
  toolPayloadCount: number
  evidenceCount: number
  logReferenceCount: number
  artifactReferenceCount: number
  lastLoadSource: Nullable<ChatContextRetrievalIndexLoadSource>
  lastBuildDurationMs: Nullable<number>
  lastBuiltAt: Nullable<number>
  recentQueries: ChatContextRetrievalQueryTraceEntry[]
}

export interface ChatContextRetrievalIndexDiagnosticsRequest {
  sessionId: string
}

export type ChatContextRetentionAction =
  | 'keep-full'
  | 'keep-pinned'
  | 'summarize'
  | 'reference-only'
  | 'drop'

export interface ChatContextDroppedRange {
  startMessageIndex: number
  endMessageIndex: number
  action: ChatContextRetentionAction
  reason: string
  retrievalHandleIds: string[]
}

export interface ChatContextViewTokenStats {
  before: ContextUsageEstimate
  after: ContextUsageEstimate
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
}

export interface ChatContextViewRollbackMeta {
  parentViewId: Nullable<string>
  sourceMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
  canRollback: boolean
  invalidationReasons: string[]
}

export interface ChatSessionContextView {
  id: string
  parentViewId: Nullable<string>
  sessionId: string
  trigger: ChatContextCompactionTrigger
  createdAt: number
  model: string
  sourceGraph: ChatContextOSSourceGraphSnapshot
  sourceMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
  coveredMessageCount: number
  messages: DebugModelMessage[]
  estimatedBefore: ContextUsageEstimate
  estimatedAfter: ContextUsageEstimate
  removedMessages: number
  passes: number
  keptRecentTurns: number
  targetPercent: number
  usageSource: ChatContextUsageAccountingSource
  pipeline: ChatContextPipelineRun
  protectedEvidenceIds: string[]
  droppedRanges: ChatContextDroppedRange[]
  tokenStats: ChatContextViewTokenStats
  rollbackMeta: ChatContextViewRollbackMeta
  evidenceLedger: ChatContextEvidenceRecord[]
  retrievalHandles: ChatContextRetrievalHandle[]
  debugTrace: ChatContextDebugTraceEntry[]
  generatedTitle?: LooseOptional<string>
}

export interface ChatSessionContextViewStore {
  activeViewId: Nullable<string>
  views: ChatSessionContextView[]
  maxViews: number
}

/** Capability-owned evidence freshness snapshot used during compaction. */
export interface ChatCompactContextCapabilityTruth {
  revisionsByResource: Readonly<Record<string, string>>
  externallyTouchedResourceIds: readonly string[]
}

export interface ChatAbortRequest {
  sessionId: string
}

export type ActiveContextArtifactKind = 'plan' | 'decision' | 'requirement'
export type ActiveContextArtifactScope = string
export type ActiveContextArtifactStatus = 'active' | 'completed' | 'archived'

export interface ActiveContextArtifact {
  id: string
  kind: ActiveContextArtifactKind
  scope: ActiveContextArtifactScope
  status: ActiveContextArtifactStatus
  sessionId: string
  resourceId?: LooseOptional<string>
  title: string
  content: string
  sourceMessageId?: LooseOptional<string>
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface ActiveContextUpsertInput {
  id?: string
  kind: ActiveContextArtifactKind
  scope?: ActiveContextArtifactScope
  status?: ActiveContextArtifactStatus
  resourceId?: LooseOptional<string>
  title: string
  content: string
  sourceMessageId?: LooseOptional<string>
  metadata?: Record<string, unknown>
}

export interface ActiveContextListOptions {
  status?: ActiveContextArtifactStatus | 'all'
  kinds?: ActiveContextArtifactKind[]
  resourceId?: LooseOptional<string>
}

export interface ActiveContextArchiveFilter {
  ids?: string[]
  kinds?: ActiveContextArtifactKind[]
  resourceId?: LooseOptional<string>
}

export type ActiveContextGovernanceAction =
  | 'keep'
  | 'suggest-complete'
  | 'suggest-archive'
  | 'review'

export type ActiveContextGovernanceSeverity = 'low' | 'medium' | 'high'

export interface ActiveContextGovernanceSuggestion {
  id: string
  artifactId: string
  kind: ActiveContextArtifactKind
  status: ActiveContextArtifactStatus
  title: string
  action: ActiveContextGovernanceAction
  severity: ActiveContextGovernanceSeverity
  score: number
  reason: string
  ageMs: number
  inactiveMs: number
  metadata?: Record<string, unknown>
}

export interface ActiveContextGovernanceOptions {
  resourceId?: LooseOptional<string>
  now?: LooseOptional<number>
  staleAfterMs?: LooseOptional<number>
  completedArchiveAfterMs?: LooseOptional<number>
  maxActiveArtifacts?: LooseOptional<number>
}

export interface ActiveContextGovernanceReport {
  sessionId: string
  generatedAt: number
  activeCount: number
  completedCount: number
  archivedCount: number
  maxActiveArtifacts: number
  suggestions: ActiveContextGovernanceSuggestion[]
  summary: string
}

export type ActiveContextGovernanceDecision = 'accept' | 'reject' | 'ignore'

export interface ActiveContextApplyGovernanceDecisionInput {
  suggestionId: string
  artifactId: string
  action: ActiveContextGovernanceAction
  decision: ActiveContextGovernanceDecision
  reason?: LooseOptional<string>
}

export interface ActiveContextGovernanceApplyResult {
  artifact: Nullable<ActiveContextArtifact>
  report: ActiveContextGovernanceReport
}

export interface ChatActiveContextRequest {
  sessionId: string
}

export interface ChatAssessActiveContextGovernanceRequest {
  sessionId: string
  options?: ActiveContextGovernanceOptions
}

export interface ChatApplyActiveContextGovernanceRequest extends ActiveContextApplyGovernanceDecisionInput {
  sessionId: string
  options?: ActiveContextGovernanceOptions
}

export interface ChatArchiveActiveContextRequest {
  sessionId: string
  filter: ActiveContextArchiveFilter
}

export type ChatGoalLifecycleAction =
  | 'resume'
  | 'pause'
  | 'block'
  | 'complete'
  | 'cancel'
  | 'remove'

export interface ChatUpdateGoalLifecycleRequest {
  sessionId: string
  action: ChatGoalLifecycleAction
}

export interface ChatUpdateGoalLifecycleResponse {
  goal: ActiveContextArtifact
}

export interface ChatGetGoalLifecycleRequest {
  sessionId: string
}

export interface ChatGetGoalLifecycleResponse {
  goal: Nullable<ActiveContextArtifact>
}

export interface ChatSessionToolResultPayload {
  serializedResult: string
  displayResult: unknown
  toolCallId?: string
  toolName?: string
  payloadRef?: string
  hash?: string
}

export interface ChatSessionPayloadSnapshot {
  sessionId: string
  userMessages: Record<string, SerializedMessage>
  /** assistant 消息的 serialized payload，卸载到文件以减少 localStorage 体积 */
  assistantMessages: Record<string, SerializedMessage>
  toolResults: Record<string, ChatSessionToolResultPayload>
  widgetArtifacts?: Record<string, ChatSessionWidgetArtifactVersion>
  generatedFiles?: Record<string, StreamAssistantGeneratedFilePayload>
}

export interface ChatPersistSessionPayloadsRequest {
  sessions: ChatSessionPayloadSnapshot[]
}

export interface ChatLoadSessionPayloadRequest {
  sessionId: string
}

// ─── Session State Disk Storage ───────────────────────────────────────────────

export interface ChatSessionStateTimelineSnapshot {
  key: string
  messages: ChatMessage[]
  messagePaging?: LooseOptional<ChatMessagePaging>
}

export interface ChatMessagePaging {
  /** 当前 messages[] 在全量数组中的起始下标 */
  loadedFromIndex: number
  /** 全量消息数 */
  totalCount: number
}

/**
 * 会话磁盘快照的规范 JSON 形状。
 *
 * - 写出：`serializeSessionForDisk`（renderer，不含 executionGraph）
 * - 重组：`ChatStateStore.loadAllSessions` → `entry.data`
 * - 持久化：manifest 中的 `session` 为去掉 messages 后的 metadata；完整快照由上述路径重组
 *
 * renderer `chatTypes.StoredChatSession` 与之同构。
 */
export interface StoredChatSession {
  id: string
  /** 所属 folder id；成员会话搜索结果需要用它回到正确的侧边栏容器。 */
  folderId?: LooseOptional<string>
  kind?: LooseOptional<'chat'>
  title: string
  titleManuallyEdited?: boolean
  isPinned?: boolean
  /** 成员在所属 folder 内的置顶状态；不影响外层 folder 排序。 */
  isMemberPinned?: boolean
  sidebarOrder?: LooseOptional<number>
  createdAt: number
  updatedAt: number
  thinkingDepth?: ThinkingDepth
  goalMode?: boolean
  /** 会话执行模式粘性：上次发送实际生效的 prompt features（hook send 省略 config 时的回落默认）。 */
  promptFeatures?: ChatPromptFeatureId[]
  scope?: CapabilityScopeId
  pureChatMode?: boolean
  toolSurfaceProfile?: ToolSurfaceProfileId
  selectedProvider?: LooseOptional<string>
  selectedModel?: string
  resourceId?: LooseOptional<string>
  scopeMetadata?: Record<string, unknown>
  resourceVersion?: number
  messages: ChatMessage[]
  messageRunMarkers?: unknown[]
  isStreaming?: boolean
  runtime?: Record<string, unknown>
  contextView?: LooseOptional<ChatSessionContextView>
  contextViewStore?: ChatSessionContextViewStore
  trace?: unknown[]
  turnContexts?: unknown[]
  workerThreads?: unknown[]
  crewAgentRuns?: unknown[]
  checkpoints?: unknown
  headSnapshot?: LooseOptional<Record<string, unknown>>
  branches?: unknown[]
  activeBranchId?: string
  sourceResourceId?: LooseOptional<string>
  messagePaging?: LooseOptional<ChatMessagePaging>
}

export interface ChatSessionStateSaveSnapshot {
  version: 1
  /** 已移除时间线消息数组的 `StoredChatSession` 元数据。 */
  session: Record<string, unknown>
  timelines: ChatSessionStateTimelineSnapshot[]
  /** 子 Agent 执行线程独立保存，不写入 session manifest。 */
  workerThreads?: unknown[]
}

/**
 * 单个 session 状态的保存请求。
 * snapshot 是 renderer 侧已拆分的 metadata + timeline windows。
 */
export interface ChatSaveSessionStateRequest {
  sessionId: string
  snapshot?: LooseOptional<ChatSessionStateSaveSnapshot>
}

/**
 * folder 注册表单条：虚拟文件夹（会话组）元数据的唯一落盘真值。
 * 成员会话不再反范式复制 pin/排序等 folder 级字段。
 */
export interface ChatFolderRegistryEntry {
  id: string
  kind: 'chat'
  title: string
  titleManuallyEdited: boolean
  isPinned: boolean
  sidebarOrder: Nullable<number>
  /** 归档时间；null 表示正常显示，非空表示仅在归档页显示。 */
  archivedAt?: LooseOptional<number>
  /** 单独归档的成员；成员仍留在 folder 中，恢复时可回到原位置。 */
  archivedMembers?: Array<{
    memberSessionId: string
    archivedAt: number
  }>
  surfaceScope: Nullable<{
    surface: string
    resourceId?: string
    metadata?: Record<string, unknown>
  }>
  /**
   * folder 级执行体绑定。缺省 = Velar Solo；存在 = 该 folder 的全部成员都由指定外部引擎执行。
   *
   * 这是主进程从 folders.json 读取的权威路由声明，不得由 renderer 的 space 或发送载荷覆盖。
   * 绑定创建后不可变；切换执行体必须新建 folder，避免一条会话混入两种执行账本。
   */
  executionBinding?: LooseOptional<{
    kind: 'engine'
    engineId: 'claude-code' | 'codex'
    workspaceRoot: string
  }>
  createdAt: number
  updatedAt: number
  /** 成员会话 id（每个成员一个固定资源范围）。 */
  memberSessionIds: string[]
  /** 当前活跃成员会话 id。 */
  activeMemberSessionId: string
}

/** folder 注册表磁盘快照（storage/chat/folders.json）。 */
export interface ChatFolderRegistrySnapshot {
  version: 1
  /** 当前活跃 folder；启动恢复 = 其 activeMemberSessionId 指向的成员会话。 */
  activeFolderId: string
  folders: ChatFolderRegistryEntry[]
  updatedAt: number
}

/** folder 注册表保存请求（整表覆盖写）。 */
export interface ChatSaveFolderRegistryRequest {
  snapshot: ChatFolderRegistrySnapshot
}

/** 单个 session 磁盘文件记录。 */
export interface ChatSessionStateDiskEntry {
  sessionId: string
  /** JSON 序列化的 {@link StoredChatSession}。 */
  data: string
}

/** 启动首屏快速恢复：先返回最近 session 的可显示窗口，再由 renderer 后台补全全部 session。 */
export interface ChatStartupSessionStateResponse {
  activeEntry: Nullable<ChatSessionStateDiskEntry>
  sessionCount: number
}

/** 启动时批量返回所有已保存的 session 状态。 */
export interface ChatLoadAllSessionStatesResponse {
  sessions: ChatSessionStateDiskEntry[]
}

/**
 * 按需加载较老消息的请求。
 *
 * beforeIndex: 当前已加载部分在全量数组中的起始下标（即 messages[beforeIndex..]已在内存中）。
 * count: 本次期望加载多少条消息。
 */
export interface ChatLoadOlderMessagesRequest {
  sessionId: string
  /** Optional capability-owned context selector. */
  /** 当前活动分支；省略时由磁盘 manifest 的 activeBranchId 兜底。 */
  branchId?: LooseOptional<string>
  /** 已在内存中的消息在全量数组里的起始位置 */
  beforeIndex: number
  /** 期望加载的条数 */
  count: number
}

/** 加载较老消息的响应。 */
export interface ChatLoadOlderMessagesResponse {
  /** 载入的消息（按时间顺序） */
  messages: ChatMessage[]
  /** 这批消息在全量数组里的起始位置 */
  loadedFromIndex: number
  /** 是否还有更老的消息 */
  hasMore: boolean
}

/** 按需加载子 Agent 执行线程详情。 */
export interface ChatLoadWorkerThreadDetailRequest {
  sessionId: string
  threadId: string
}

export interface ChatLoadWorkerThreadDetailResponse {
  workerThread: Nullable<Record<string, unknown>>
}

// ─── Session Search ───────────────────────────────────────────────────────────

export type ChatSessionSearchMatchType = 'keyword'

export interface ChatSessionSearchRequest {
  query: string
  limit?: LooseOptional<number>
  kinds?: LooseOptional<Array<'chat'>>
}

export interface ChatSessionSearchMatch {
  messageId: string
  messageIndex: number
  role: SerializedMessage['role'] | ChatMessage['role']
  timestamp: number
  score: number
  matchType: ChatSessionSearchMatchType
  snippet: string
}

export interface ChatSessionSearchResultGroup {
  sessionId: string
  folderId: string
  title: string
  kind: 'chat'
  createdAt: number
  updatedAt: number
  topScore: number
  matches: ChatSessionSearchMatch[]
}

export interface ChatSessionSearchResponse {
  query: string
  groups: ChatSessionSearchResultGroup[]
}

export interface ChatStreamSnapshotCursor {
  sessionId: string
  afterSequence?: LooseOptional<number>
}

export interface ChatStreamSnapshotRequest {
  cursors?: ChatStreamSnapshotCursor[]
}

// ─── IPC 事件载荷 ──────────────────────────────────────────────────────────────

export interface StreamToolCallPayload {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  /** 工具所属类别，由后端 ToolRegistry 解析注入，前端直接用于渲染 */
  categoryId?: ToolCategoryId
}

export interface StreamReasoningPayload {
  id: string
  text: string
}

export interface StreamToolResultPayload {
  toolCallId: string
  result: unknown
  error?: string
  /** 工具执行产生的副作用语义，由后端计算后附加，前端无需解析结果 */
  effects?: StreamToolResultEffects
  /** 后端从工具结果中抽取的上下文证据，供压缩/召回 pipeline 使用 */
  evidence?: ChatContextEvidenceRecord[]
  /** 工具提供给模型读取的图片数据，renderer 用它做聊天内预览。 */
  modelImage?: StreamToolResultModelImage
}

export interface StreamToolProgressPayload {
  toolCallId: string
  chunk: string
  timestamp?: number
}

export interface StreamToolMetadataPayload {
  toolCallId: string
  title?: string
  metadata?: Record<string, unknown>
  timestamp?: number
}

export interface StreamExecutionGraphPayload {
  kind: 'execution-graph'
  executionId: string
  sourceSessionId: string
  status: ExecutionStatus
  currentTaskId: Nullable<string>
  currentRecommendedAction: ExecutionTaskRecord['recommendedAction']
  currentExecutionAdvice: Nullable<ExecutionTaskExecutionAdvice>
  planView: Nullable<ExecutionPlanView>
  roleId: Nullable<AgentRoleId>
  roleLabel: Nullable<string>
  tasks: ExecutionTaskRecord[]
  events: ExecutionEventRecord[]
}

export type StreamDebugPayload =
  | StreamTurnContextPayload
  | StreamAssistantRawPayload
  | StreamExecutionGraphPayload

export type ChatStreamNoticeEvent = {
  type: 'notice'
  kind: string
  payload: unknown
}

export type ChatStreamEvent =
  | { type: 'reasoning'; payload: StreamReasoningPayload }
  | { type: 'tool-call'; payload: StreamToolCallPayload }
  | { type: 'tool-progress'; payload: StreamToolProgressPayload }
  | { type: 'tool-metadata'; payload: StreamToolMetadataPayload }
  | { type: 'tool-result'; payload: StreamToolResultPayload }
  | { type: 'worker-thread'; payload: StreamWorkerThreadPayload }
  | { type: 'state'; payload: StreamStatePayload }
  | { type: 'debug'; payload: StreamDebugPayload }
  | ChatStreamNoticeEvent
  | { type: 'end' }
  | { type: 'error'; payload: SerializedError }

/** IPC 信封：所有 stream 事件都携带 sourceSessionId，前端据此路由到正确 session */
export interface ChatStreamDeltaEnvelope {
  sourceSessionId: string
  text: string
  sequence?: number
}

export interface ChatStreamEventEnvelope {
  sourceSessionId: string
  event: ChatStreamEvent
  sequence?: number
}

export interface ChatHookSendTaskEvent {
  sessionId: string
  capabilityContext?: unknown
  messageId: string
  message: string
  timestamp: number
  /** 外部 hook 指定的发送配置覆盖（模型/运行模式/思考力度等）；省略则用目标上下文默认。 */
  config?: unknown
  /** hook 携带的图片输入（等价 composer 贴图/选图）；renderer 装配进 serialized.imageAttachments。 */
  imageAttachments?: SerializedImageAttachment[]
}

/**
 * hook 可见性操作的会话选中通知：主进程窗口前置后,让 renderer 把目标会话切成 UI 当前选中
 * （等价侧边栏点击）。sessionId 可为成员 id 或 folder id,renderer 用与 send_task 同一套解析。
 * 没有这一步时 focus/send 只有 OS 级窗口聚焦——已存在会话的界面永远不切换（真机踩坑）。
 */
export interface ChatHookFocusSessionEvent {
  sessionId: string
}

/** hook provide_guidance：向运行中的会话追加用户引导（renderer 负责入会话+持久化）。 */
export interface ChatHookProvideGuidanceEvent {
  sessionId: string
  messageId: string
  message: string
  timestamp: number
}

/** hook bridge_ping：主进程探测 renderer hook 桥活性的 ping 事件；renderer 收到后以同 nonce 回 pong。 */
export interface ChatHookBridgePingEvent {
  nonce: string
}

/**
 * hook resolve_confirmation：主进程 headless 放行确认后,通知 renderer 对目标会话重新进入
 * streaming 态(prepareSessionStreamStart + markSessionStreaming)。UI 点按钮走
 * useChatExecutionResolveConfirmation 会自己 re-prime;hook 批准绕过 renderer,不补这一步
 * 则恢复流(tool-result+后续回答)会被当迟到输入丢弃、不落 state store。
 */
export interface ChatHookResolveConfirmationEvent {
  sessionId: string
}

/** hook arm_handoff：绕过降级判定，直接给目标会话布防转交建议卡（测试驱动）。 */
export interface ChatHookArmHandoffEvent {
  sessionId: string
}

/** hook resolve_handoff：程序化解析目标会话当前布防的转交建议卡（等价点击卡片按钮）。 */
export interface ChatHookResolveHandoffEvent {
  sessionId: string
  approved: boolean
}

export type BackendLogNotificationLevel = 'warn' | 'error' | 'fatal'
export type BackendLogNotificationTone = 'warning' | 'error'

export interface BackendLogNotificationEvent {
  id: string
  title: string
  tone: BackendLogNotificationTone
  level: BackendLogNotificationLevel
  scope: string
  timestamp: number
}

export type ChatStreamSnapshotItem =
  | { kind: 'delta'; sequence: number; text: string }
  | { kind: 'event'; sequence: number; event: ChatStreamEvent }

export interface ChatStreamSnapshot {
  sourceSessionId: string
  isStreaming: boolean
  latestSequence: number
  items: ChatStreamSnapshotItem[]
}

// ─── 配置 ─────────────────────────────────────────────────────────────────────

export interface ChatConfig {
  /** Product-owned model selection. Core does not define provider/catalog/auth DTOs. */
  modelSelection?: unknown
  systemPromptAppend: string
}
