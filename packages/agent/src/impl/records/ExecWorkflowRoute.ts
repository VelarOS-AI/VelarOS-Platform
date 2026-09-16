import type { AgentTurnRouteIdentity, StreamTurnContextPayload } from '../../types/agent'
import type { ExecutionRouteProvider,ResolvedTaskRoute } from '../../types/records.js'
import { ExecPlanState } from '../../utils/records/plan-state'

function emptyRoute(identity: AgentTurnRouteIdentity): ResolvedTaskRoute {
  return {
    workflowType: identity.workflowType,
    expectedOutput: identity.expectedOutput,
    suggestedNextRoles: [],
    executionPlan: [],
  }
}

class ExecWorkflowRoute {
  constructor(
    private readonly provider?: ExecutionRouteProvider,
    private readonly planStateHelper = new ExecPlanState()
  ) {}

  public resolveFromTurnContext(payload: StreamTurnContextPayload): ResolvedTaskRoute {
    return this.resolveFromRouteIdentity(resolveTurnRouteIdentity(payload))
  }

  public resolveFromRouteIdentity(identity: AgentTurnRouteIdentity): ResolvedTaskRoute {
    const route = this.provider?.resolve(identity) ?? emptyRoute(identity)
    return {
      ...route,
      executionPlan: this.planStateHelper.refreshExecutionPlan(route.executionPlan),
    }
  }
}


function resolveTurnRouteIdentity(
  payload: Pick<StreamTurnContextPayload, 'roleId' | 'workflowType' | 'roleExpectedOutput'>
): AgentTurnRouteIdentity {
  return {
    roleId: payload.roleId,
    workflowType: payload.workflowType,
    expectedOutput: payload.roleExpectedOutput,
  }
}

export { ExecWorkflowRoute as ExecutionWorkflowRouteHelper, ExecWorkflowRoute, type ResolvedTaskRoute, resolveTurnRouteIdentity }