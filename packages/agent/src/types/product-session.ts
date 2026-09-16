
import type { HostProjection, ModelMessage, ModelMessagePart, ModelMessageRole, ToolCatalogEntry, VelarToolResultEnvelope,VelarToolResultStatus  } from './agent.js'
export interface AgentSessionApplicationEvent<TPayload = unknown> {
  readonly type: string
  readonly payload: TPayload
  readonly createdAt: number
}

export type AgentPlanStatus = 'draft' | 'approved' | 'complete' | 'cancelled'

export type AgentPlanStepStatus = 'pending' | 'in_progress' | 'complete' | 'skipped'

export interface AgentPlanStep {
  readonly id: string
  readonly text: string
  readonly status: AgentPlanStepStatus
}

export interface AgentPlan {
  readonly id: string
  readonly sessionId: string
  readonly objective: string
  readonly steps: readonly AgentPlanStep[]
  readonly status: AgentPlanStatus
  readonly reviewFeedback: Nullable<string>
  readonly createdAt: number
  readonly updatedAt: number
}

export type AgentGoalStatus = 'active' | 'complete' | 'blocked' | 'cancelled'

export interface AgentGoal {
  readonly id: string
  readonly sessionId: string
  readonly objective: string
  readonly status: AgentGoalStatus
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AgentQuestionRequest {
  readonly id: string
  readonly sessionId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom: boolean
  readonly createdAt: number
}

export interface AskAgentQuestionInput {
  readonly sessionId: string
  readonly question: string
  readonly options: readonly string[]
  readonly allowCustom?: boolean
}

export interface PendingQuestion {
  readonly request: AgentQuestionRequest
  readonly resolve: (answer: string) => void
  readonly reject: (error: Error) => void
}

export type QuestionListener = (questions: readonly AgentQuestionRequest[]) => void

export interface AgentSessionArchiveEvent<TPayload = unknown> {
  readonly type: string
  readonly payload: TPayload
  readonly createdAt: number
}

/**
 * Product-neutral portable Session envelope. Product schema remains an explicit inner version and
 * payload; Platform owns identity, sanitation provenance, timestamp, and bounded collection shape.
 */
export interface AgentSessionArchiveEnvelope<TSession, TResource = unknown, TEvent = AgentSessionArchiveEvent> {
  readonly format: 'velaros.agent-session'
  readonly schemaVersion: 1
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}

export type AgentPermissionReply = 'once' | 'session' | 'always' | 'reject'

export type AgentPermissionAction = 'allow' | 'deny' | 'ask'

export type AgentPermissionRisk = 'low' | 'high'

export interface AgentPermissionRule {
  readonly permission: string
  readonly pattern: string
  readonly action: AgentPermissionAction
}

export interface AgentPermissionRequest<TMode extends string = string> {
  readonly id: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly mode: TMode
  readonly permission: string
  readonly toolName: string
  readonly patterns: readonly string[]
  readonly alwaysPatterns: readonly string[]
  readonly readOnly: boolean
  readonly risk: AgentPermissionRisk
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export interface RequestAgentPermissionInput<TMode extends string = string> {
  readonly id?: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly mode: TMode
  readonly permission: string
  readonly toolName: string
  readonly patterns?: readonly string[]
  readonly alwaysPatterns?: readonly string[]
  readonly readOnly: boolean
  readonly risk?: AgentPermissionRisk
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type SessionInputDelivery = 'queue' | 'steer'

export type SessionTarget = {
  sessionId: string
  seq: Nullable<number>
}

export type AdmitRequest = {
  sessionId: string
  inputId: string
  role: Nullable<ModelMessageRole>
  content: string
  delivery: Nullable<SessionInputDelivery>
  metadata: Nullable<Record<string, unknown>>
  parts?: ModelMessagePart[]
}

export type AdmitReceipt = {
  inputId: string
  sessionId: string
  seq: number
}

export type WakeRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type SteerRequest = {
  sessionId: string
  inputId: string
  role: Nullable<ModelMessageRole>
  content: string
}

export type AnswerRequest = {
  sessionId: string
  seq: Nullable<number>
  answer: string
}

export type ApproveRequest = {
  sessionId: string
  seq: Nullable<number>
  approved: boolean
  rejectionMessage: Nullable<string>
  approvalPayload: unknown
}

export type CancelRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type CancelResult = {
  aborted: boolean
}

export type RuntimeStatusRequest = {
  sessionId: string
  seq: Nullable<number>
}

export type RuntimeStatusResponse = {
  hasPendingConfirmation: boolean
  hasPendingInput: boolean
  running: boolean
  pendingPrompt: boolean
  cancelRequested: boolean
  cancellable: boolean
  queuedInputs: number
  backgroundJobs: number
}

export type SessionEventPayload = {
  kind: 'lifecycle'
  phase: string
} | {
  kind: 'custom'
  customType: string
  data: unknown
}

export type SessionEventEnvelope = {
  sessionId: string
  sequence: number
  event: SessionEventPayload
}

export type ResolveCatalogRequest = {
  hostProjection: HostProjection
}

export type DescribeToolSchemaRequest = {
  name: string
}

export type ExecuteToolRequest = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export type ExecuteToolResponse = {
  protocolVersion: 1
  contractId: string
  catalogRevision: string
  toolCallId: string
  toolName: string
  status: VelarToolResultStatus
  output?: unknown
  error?: string
}

export type RunTurnOptions = {
  modelId?: string
  maxToolTurns?: number
}

export type RunTurnRequest = {
  messages: ModelMessage[]
  tools: ToolCatalogEntry[]
  options?: RunTurnOptions
}

export type RunTurnResponse = {
  messages: ModelMessage[]
  toolResults: VelarToolResultEnvelope[]
}
