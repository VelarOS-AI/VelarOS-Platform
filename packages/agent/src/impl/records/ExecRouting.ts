import type { AgentTurnRouteIdentity, StreamTurnContextPayload } from '../../types/agent'
import type { AgentRoleId, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecommendedAction, ExecutionTaskRecord } from '../../types/agent.js'
import type { ExecutionRouteProvider, ResolvedTaskRoute } from '../../types/records.js'
import { ExecPlanState } from '../../utils/records/plan-state'

import { ExecWorkflowRoute, resolveTurnRouteIdentity } from './ExecWorkflowRoute'

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

export { ExecRouting, ExecRouting as ExecutionRoutingCoordinator }
