import type { ToolCallPart } from 'ai'

import type { CapabilityScopeId,ChatSendRequest, ChatStreamEvent, ChatStreamSnapshotItem, ExecutionModeId, ReasoningLevel, RunProfileSelectionId, ThinkingDepth } from './agent.js'

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
