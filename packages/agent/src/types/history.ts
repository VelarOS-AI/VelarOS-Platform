/**
 * 超大 user 正文的全保真层引用（`UserTextPayloadPlanner` 落盘后回填给清洗层，
 * 截断信封才能指向 payloadRef 而不是只留一句"已截断"）。
 *
 * 原住 v1 `history/microCompaction.ts`；该文件随治理 v2 拆除，此形状是
 * {@link SanitizeModelHistoryOptions} 的一部分，跟着清洗层走。
 */
import type { ModelMessage } from 'ai'

import type { ContextPayloadStore } from '../contract/requires.js'

import type { ToolResultModelContentPart } from './agent.js'

export interface UserTextPayloadReference {
  messageIndex: number
  payloadRef: string
  hash: string
  originalChars: number
}

export interface ModelHistorySanitizationResult {
  history: ModelMessage[]
  changedMessages: number
}

export interface ModelMessageSanitizationResult {
  message: ModelMessage
  changed: boolean
}

export interface ModelMessageSanitizationOptions {
  skipToolResultBudget?: boolean
  /** 本次发送刻意展示完整参数的调用（紧接失败的那一次决策）；结构清洗不再把它们压回省略形态。 */
  preserveToolCallInputIds?: ReadonlySet<string>
}

export interface AssistantToolCallNameCandidate {
  partIndex: number
  toolCallId: string
  toolName: Nullable<string>
}

export interface ToolResultNameReference {
  toolCallId: string
  toolName: string
}

export interface PositionalToolCallReference {
  messageIndex: number
  partIndex: number
  toolCallId: Nullable<string>
  toolName: Nullable<string>
}

export interface PositionalToolResultReference extends PositionalToolCallReference {}

/** `sanitizeModelHistory` 的选项。 */
export interface SanitizeModelHistoryOptions {
  /**
   * 供应方回放前必须替换工具结果正文的工具调用标识。
   * 编码编排器用它避免原始发现阶段输出流入变更、验证和综合阶段。
   */
  /** 已持久化的超大 user 正文 payload 引用，按 messageIndex 索引（准入层的 payloadRef 来源）。 */
  userTextPayloadRefs?: readonly UserTextPayloadReference[]
  /** 已持久化的工具结果 payload 引用，按 toolCallId 或 message/part occurrence key 索引。 */
  toolResultPayloadRefs?: Readonly<Record<string, string>>
  /** 切换供应商/模型回放历史时，移除供应商私有的 part metadata。 */
  stripProviderSpecificMetadata?: boolean
}

/** provider 运行时会在消息/片段上私挂的未声明键;泛型剥离用的解析后桥接形状(§12.5)。 */
export interface ProviderSpecificMetadataCarrier {
  providerMetadata?: unknown
  callProviderMetadata?: unknown
}

export interface HistoryToolCallReference {
  toolCallId: string
  toolName: string
}

export interface ToolCallReference {
  messageIndex: number
  toolName: string
}

export interface ModelHistoryValidationIssue {
  messageIndex: number
  role: string
  message: string
  toolCallId?: string
}

export interface ModelHistoryValidationResult {
  valid: boolean
  issues: ModelHistoryValidationIssue[]
}

export interface AssertValidModelHistoryOptions {
  phase: 'stream' | 'query' | 'compile'
  turn: Nullable<number>
}

/**
 * 解析后的合成消息结构。
 *
 * 每段都是"含标记的完整原文"，可以直接拼回新的合成消息，
 * 不需要再次手工拼前缀和说明，避免标记常量散落在多处定义。
 *
 * - `summarySegment`：从压缩摘要标记到下一段标记之前的整段原文。
 * - `evidenceSegment`：从置顶证据标记到下一段标记之前的整段原文。
 * - `handlesSegment`：从动态句柄标记到消息末尾的整段原文。
 */
export interface ParsedContextOSGeneratedMessage {
  summarySegment: Nullable<string>
  evidenceSegment: Nullable<string>
  handlesSegment: Nullable<string>
}

export type ModelHistoryRequestPhase = 'stream' | 'query'

export interface AgentHistoryToolContext {
  /** Opaque execution-session state carried through generic history preparation. */
  codingSession: unknown
  sessionId?: string
  contextPayloadStore?: ContextPayloadStore
  /** canonical tool id → provider transport name for the current request. */
  getCurrentVisibleToolTransportNames?: () => Readonly<Record<string, string>>
}

export interface AgentTurnToolResult {
  toolCallId: string
  toolName: string
  args?: Record<string, unknown>
  result?: unknown
  modelResult?: unknown
  error?: LooseOptional<string>
  modelImage?: {
    data: string
    mediaType: string
  }
  modelContent?: ToolResultModelContentPart[]
}

export interface AgentTurnToolExecutor {
  collectAll(): Promise<AgentTurnToolResult[]>
  getTerminalError(): unknown
}

export type AssistantContentPart =
  | { type: 'text'; text: string; replayable?: boolean }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: Record<string, unknown>
    }

export type AssistantModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

export type AssistantRawContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown> }

export type InternalFollowUpModelMessage = ModelMessage & {
  velarosInternal?: {
    kind: 'follow-up'
  }
}

export interface HistorySanitizationIssue {
  kind:
    | 'orphan-tool-result'
    | 'unsafe-assistant-message'
    | 'missing-tool-results'
  messageIndex: number
  role: ModelMessage['role']
  removedMessages: number
  reason: string
  toolCallIds?: string[]
  missingToolCallIds?: string[]
}

export interface HistorySanitizationResult {
  history: ModelMessage[]
  removedMessages: number
  changedMessages: number
  issues: HistorySanitizationIssue[]
}

/**
 * 逐条扫描历史，修复三类结构损坏：
 *  - 无前驱 assistant tool-call 的整条 tool 消息 → 丢弃；
 *  - 回放不安全的 assistant 消息 → 丢弃；
 *  - 缺结果的 tool-call 组 → 能回填就补「被中断」占位结果，不能回填就整组移除。
 */
export interface HistoryStructureRepairOptions {
  /** 本次发送刻意展示完整参数的调用；结构自愈不压缩它们的参数。 */
  preserveToolCallInputIds?: ReadonlySet<string>
}
