import type { AgentTurnRouteIdentity } from './agent'
import type { ExecutionTaskPlanStep } from './execution'
import type {
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  WorkflowType,
} from './system'

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
