import type {
  AgentRoleId,
  AgentTurnRouteIdentity,
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStep,
  ExecutionTaskRecommendedAction,
  ExecutionTaskRecord,
  StreamTurnContextPayload,
} from '@velaros-ai/agent/protocol'

import { ExecPlanState } from './plan-state'
import type { ResolvedTaskRoute } from './routing-types'

interface ExecutionRouteProvider {
  resolve(identity: AgentTurnRouteIdentity): ResolvedTaskRoute
}

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

class ExecRouting {
  private readonly planStateHelper = new ExecPlanState()
  private readonly workflowRouteHelper: ExecWorkflowRoute

  constructor(provider?: ExecutionRouteProvider) {
    this.workflowRouteHelper = new ExecWorkflowRoute(provider, this.planStateHelper)
  }

  public resolveFromTurnContext(payload: StreamTurnContextPayload): ResolvedTaskRoute {
    return this.resolveFromRouteIdentity(resolveTurnRouteIdentity(payload))
  }

  public resolveFromRouteIdentity(identity: AgentTurnRouteIdentity): ResolvedTaskRoute {
    return this.workflowRouteHelper.resolveFromRouteIdentity(identity)
  }

  public refreshExecutionPlan(plan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[] {
    return this.planStateHelper.refreshExecutionPlan(plan)
  }

  public findFirstActionableSelfStep(
    plan: ExecutionTaskPlanStep[],
    roleId: Nullable<AgentRoleId>
  ): Nullable<ExecutionTaskPlanStep> {
    return this.planStateHelper.findFirstActionableSelfStep(plan, roleId)
  }

  public resolveRecommendedAction(
    task: ExecutionTaskRecord
  ): Nullable<ExecutionTaskRecommendedAction> {
    return this.planStateHelper.resolveRecommendedAction(task)
  }

  public resolveExecutionAdvice(
    task: ExecutionTaskRecord
  ): Nullable<ExecutionTaskExecutionAdvice> {
    return this.planStateHelper.resolveExecutionAdvice(task)
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

export {
  ExecRouting,
  type ExecutionRouteProvider,
  ExecRouting as ExecutionRoutingCoordinator,
  ExecWorkflowRoute as ExecutionWorkflowRouteHelper,
  ExecWorkflowRoute,
  type ResolvedTaskRoute,
  resolveTurnRouteIdentity,
}
