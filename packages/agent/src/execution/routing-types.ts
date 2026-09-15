import type { AgentTurnRouteIdentity } from '../protocol/types/agent'
import type { ExecutionTaskPlanStep } from '../protocol/types/execution'
import type {
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  WorkflowType,
} from '../protocol/types/system'

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
