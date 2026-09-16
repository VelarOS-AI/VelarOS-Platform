
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
