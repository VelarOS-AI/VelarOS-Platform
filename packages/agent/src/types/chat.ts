import type { ToolCallPart } from 'ai'

import type { CapabilityScopeId, ChatContextEvidenceRecord, ChatContextRetrievalHandleKind, ChatContextUsageAccountingConfidence, ChatContextUsageAccountingSource, ChatMessage, ChatPromptFeatureId, ChatSendRequest, ChatStreamEvent, ChatStreamSnapshotItem, ContextUsageEstimate, DebugModelMessage, ExecutionModeId, ReasoningLevel, RunProfileSelectionId, SerializedMessage, ThinkingDepth, ToolSurfaceProfileId } from './agent.js'

export type ChatStreamLogEntry = ChatStreamSnapshotItem

export type ChatStreamLifecyclePhase = 'idle' | 'streaming' | 'terminal'

/** Renderer IPC consumer termination; `user_abort` blocks reconnect recovery. */
export type ChatStreamTerminationReason = 'user_abort' | 'completed' | 'failed'

export type TerminalRuntimeExecutionAction = 'complete' | 'abort' | 'fail'

export type AgentBridgeOutput =
  | { kind: 'delta'; text: string }
  | { kind: 'events'; events: ChatStreamEvent[] }

/** main StreamBridge 侧结构化日志；由 protocol 从 AgentEvent / ChatStreamEvent 推导。 */
export type StreamObservabilityEntry = {
  level: 'info' | 'error'
  message: string
  context: Record<string, unknown>
}

export type AgentBridgeDispatch = {
  outputs: AgentBridgeOutput[]
  observability: StreamObservabilityEntry[]
}

export type AssistantModelContentPart = { type: 'text'; text: string } | ToolCallPart

export type UserModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType?: string }

export interface ResolvedChatSendRequestOptions {
  runProfile: RunProfileSelectionId
  /** 用户在前端独立选择的思考深度；与 runProfile 解耦。未指定时为 undefined，由下游回落到 profile 默认。 */
  thinkingDepth?: ThinkingDepth
  /** Composer 思考力度 5 档（off/low/medium/high/ultra）；优先于 thinkingDepth 决定 reasoning 力度。 */
  reasoningLevel?: ReasoningLevel
  /** 能力轴：**只剩能力**，执行模式的旧形态 id 已在此剥除（见 stripExecutionModePromptFeatures）。 */
  promptFeatures: NonNullable<ChatSendRequest['promptFeatures']>
  /** 执行模式轴（权威）：新字段 ∪ 旧形态折算，见 resolveExecutionModes。 */
  executionModes: ExecutionModeId[]
  scope: CapabilityScopeId
  /** 由模式轴派生，保留给尚未改读新轴的下游（goal 生命周期、收尾门、阶段判定）。 */
  goalMode: boolean
  pureChatMode: boolean
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
  title: string
  titleManuallyEdited?: boolean
  isPinned?: boolean
  /** 成员在所属 folder 内的置顶状态；不影响外层 folder 排序。 */
  isMemberPinned?: boolean
  sidebarOrder?: LooseOptional<number>
  createdAt: number
  updatedAt: number
  thinkingDepth?: ThinkingDepth
  /** @deprecated 已并入 `executionModes`；存量磁盘会话仍可能只有这一格，读入时折算。 */
  goalMode?: boolean
  /**
   * 会话执行模式粘性（权威轴）：上次发送实际生效的执行模式。
   * hook send 省略 config 时回落到它，兑现「省略字段回落 session 默认」契约。
   */
  executionModes?: ExecutionModeId[]
  /** 会话能力粘性：上次发送实际生效的 prompt features（**只含能力**，模式已拆到 `executionModes`）。 */
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

export interface ChatMessagePaging {
  /** 当前 messages[] 在全量数组中的起始下标 */
  loadedFromIndex: number
  /** 全量消息数 */
  totalCount: number
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

// 手动压缩功能已移除(2026-07-18 用户裁决:压缩由内部看门自治);旧落盘数据里的 'manual'
// 在恢复时归一为 'auto'。
export type ChatContextCompactionTrigger = 'auto'

export interface ChatContextDebugTraceEntry {
  stage: ChatContextPipelineStageId
  action: 'inline' | 'summarize' | 'handle' | 'drop' | 'skip' | 'estimate' | 'retain'
  target: string
  reason: string
  score?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export interface ChatContextDroppedRange {
  startMessageIndex: number
  endMessageIndex: number
  action: ChatContextRetentionAction
  reason: string
  retrievalHandleIds: string[]
}

export interface ChatContextOSSourceGraphSnapshot {
  sessionId: string
  capturedAt: number
  sources: ChatContextOSSourceSnapshot[]
}

export interface ChatContextPipelineRun {
  profile: ChatContextPipelineProfileId
  stages: ChatContextPipelineStageRun[]
  budgetLanes: ChatContextBudgetLaneDefinition[]
  notes: string[]
}

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

export interface ChatContextViewRollbackMeta {
  parentViewId: Nullable<string>
  sourceMessageCount: number
  sourceLastMessageId: Nullable<string>
  sourceLastMessageTimestamp: Nullable<number>
  canRollback: boolean
  invalidationReasons: string[]
}

export interface ChatContextViewTokenStats {
  before: ContextUsageEstimate
  after: ContextUsageEstimate
  source: ChatContextUsageAccountingSource
  confidence: ChatContextUsageAccountingConfidence
}

export interface ChatContextBudgetLaneDefinition {
  id: ChatContextBudgetLaneId
  priority: number
  minPercent: number
  maxPercent: number
}

export type ChatContextRetentionAction =
  | 'keep-full'
  | 'keep-pinned'
  | 'summarize'
  | 'reference-only'
  | 'drop'

export type ChatContextBudgetLaneId = string

export interface ChatContextOSSourceSnapshot {
  kind: ChatContextOSSourceKind
  count: number
  label: string
  estimatedChars?: LooseOptional<number>
  metadata?: Record<string, unknown>
}

export type ChatContextPipelineProfileId = string

export type ChatContextPipelineStageId = string

export interface ChatContextPipelineStageRun {
  id: ChatContextPipelineStageId
  required: boolean
  status: ChatContextPipelineStageStatus
  reason?: LooseOptional<string>
}

export type ChatContextOSSourceKind = string

export type ChatContextPipelineStageStatus = 'completed' | 'skipped' | 'pending'
