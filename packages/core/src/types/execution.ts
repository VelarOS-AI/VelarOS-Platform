import type {
  AgentDelegationContract,
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  WorkflowType,
} from './system'
import type { UserActionCard, UserActionCardResult } from './tool'

export type ExecutionStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'running'
  | 'awaiting_input'
  | 'aborted'
  | 'completed'
  | 'failed'

export type ExecutionTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_confirmation'
  | 'awaiting_input'
  | 'aborted'
  | 'completed'
  | 'failed'

export interface ExecutionInputRequest {
  question: string
  askedAt: number
}

export interface ExecutionConfirmationRequest {
  message: string
  askedAt: number
  userActionCards?: UserActionCard[]
}

export interface ExecutionProvideInputRequest {
  sessionId: string
  answer: string
}

export interface ExecutionResolveConfirmationRequest {
  sessionId: string
  approved: boolean
  rejectionMessage?: LooseOptional<string>
  userActionCardResults?: LooseOptional<UserActionCardResult[]>
}

export type ExecutionPendingInteractionKind = 'confirmation' | 'input'

export interface ExecutionHasPendingInteractionRequest {
  sessionId: string
  kind: ExecutionPendingInteractionKind
}

export type ExecutionPendingInteractionSnapshot =
  | {
      kind: 'confirmation'
      executionId: string
      message: string
      userActionCards?: LooseOptional<UserActionCard[]>
    }
  | {
      kind: 'input'
      executionId: string
      question: string
    }

export interface ExecutionHasPendingInteractionResult {
  available: boolean
  interaction?: LooseOptional<ExecutionPendingInteractionSnapshot>
}

export interface ExecutionAbortSubAgentWorkerRequest {
  sessionId: string
  threadId: string
  reason?: LooseOptional<string>
}

export interface ExecutionAbortSubAgentWorkerResult {
  aborted: boolean
}

export interface ExecutionRelaySubAgentGuidanceRequest {
  sessionId: string
  threadId: string
  message: string
}

export interface ExecutionRelaySubAgentGuidanceResult {
  relayed: boolean
}

export type ExecutionTaskPlanStepStatus =
  | 'pending'
  | 'delegated'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ExecutionTaskPlanStep {
  id: string
  title: string
  roleId: AgentRoleId
  objective: string
  kind: 'respond' | 'prepare' | 'implement' | 'synthesize'
  mode: 'self' | 'delegated'
  required: boolean
  dependsOn: string[]
  actionable: boolean
  status: ExecutionTaskPlanStepStatus
  taskId: Nullable<string>
  updatedAt: Nullable<number>
  /**
   * 步骤来源：'scaffold' 是路由按 workflow 角色注入的默认占位步骤（如 operator-execute），
   * 'manual' 是模型经 update_plan 亲自编写的计划步骤。缺省视作 scaffold（兼容旧数据）。
   * 一旦存在 manual 步骤，角色 turn 的 scaffold 合并就不得再覆盖模型计划（见 mergeExecutionPlan）。
   */
  origin?: 'scaffold' | 'manual'
}

export interface ExecutionPlanViewStep extends ExecutionTaskPlanStep {
  active: boolean
  blockedBy: string[]
  linkedTaskTitle: Nullable<string>
  linkedTaskStatus: Nullable<ExecutionTaskStatus>
}

export interface ExecutionPlanViewSummary {
  total: number
  pending: number
  delegated: number
  running: number
  completed: number
  failed: number
  skipped: number
}

export interface ExecutionPlanView {
  taskId: string
  taskTitle: string
  activeStepId: Nullable<string>
  steps: ExecutionPlanViewStep[]
  summary: ExecutionPlanViewSummary
  recommendedAction: Nullable<ExecutionTaskRecommendedAction>
  executionAdvice: Nullable<ExecutionTaskExecutionAdvice>
}

export type ExecutionTaskRecommendedActionKind =
  | 'self'
  | 'delegate'
  | 'wait'
  | 'done'

export interface ExecutionTaskRecommendedAction {
  kind: ExecutionTaskRecommendedActionKind
  planStepId: Nullable<string>
  roleId: Nullable<AgentRoleId>
  title: string
  objective: string
  blockingStepIds: string[]
}

export type ExecutionTaskExecutionAdviceMode =
  | 'auto-continue'
  | 'prompt-delegation'
  | 'wait'
  | 'completed'

export interface ExecutionTaskExecutionAdvice {
  mode: ExecutionTaskExecutionAdviceMode
  planStepId: Nullable<string>
  roleId: Nullable<AgentRoleId>
  title: string
  objective: string
  reason: string
  blockingStepIds: string[]
}

export type ExecutionEventSeverity = 'info' | 'success' | 'warning' | 'error'

export type ExecutionEventKind =
  | 'execution-created'
  | 'execution-status-changed'
  | 'runtime-state-captured'
  | 'turn-context-captured'
  | 'assistant-output-captured'
  | 'tool-call-started'
  | 'tool-call-progress'
  | 'tool-call-metadata'
  | 'tool-call-completed'
  | 'task-created'
  | 'task-status-changed'
  | 'task-focus-changed'
  | 'plan-updated'
  | 'plan-step-updated'

export interface ExecutionEventRecord {
  id: string
  executionId: string
  kind: ExecutionEventKind
  severity: ExecutionEventSeverity
  title: string
  message: string
  timestamp: number
  taskId: Nullable<string>
  planStepId: Nullable<string>
  payload: Record<string, unknown>
}

export interface ExecutionTaskRecord {
  id: string
  kind: 'root' | 'delegated'
  title: string
  instruction: string
  roleId: Nullable<AgentRoleId>
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
  delegatedByRoleId: Nullable<AgentRoleId>
  delegation: Nullable<AgentDelegationContract>
  suggestedNextRoles: AgentRoleId[]
  executionPlan: ExecutionTaskPlanStep[]
  recommendedAction: Nullable<ExecutionTaskRecommendedAction>
  linkedPlanStepId: Nullable<string>
  parentTaskId: Nullable<string>
  status: ExecutionTaskStatus
  createdAt: number
  updatedAt: number
  startedAt: Nullable<number>
  completedAt: Nullable<number>
  result: Nullable<string>
  error: Nullable<string>
}

export interface ExecutionRecord {
  id: string
  sourceSessionId: string
  status: ExecutionStatus
  summary: string
  resourceId: Nullable<string>
  createdAt: number
  updatedAt: number
  roleId: Nullable<AgentRoleId>
  roleLabel: Nullable<string>
  roleDescription: Nullable<string>
  awaitingConfirmation: Nullable<ExecutionConfirmationRequest>
  awaitingInput: Nullable<ExecutionInputRequest>
  error: Nullable<string>
  currentTaskId: string
  tasks: ExecutionTaskRecord[]
  events: ExecutionEventRecord[]
}
