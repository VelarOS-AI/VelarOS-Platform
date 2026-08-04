import type {
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  AgentTurnRouteIdentity,
  ExecutionTaskPlanStep,
  WorkflowType,
} from '@velaros-ai/agent/protocol'

interface ResolvedTaskRoute {
  workflowType: Nullable<WorkflowType>
  expectedOutput: Nullable<AgentRoleExpectedOutputKind>
  suggestedNextRoles: AgentRoleId[]
  executionPlan: ExecutionTaskPlanStep[]
}

export type {
  AgentTurnRouteIdentity,
  ResolvedTaskRoute,
}
