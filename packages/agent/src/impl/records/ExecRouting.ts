import type { AgentRoleId, AgentTurnRouteIdentity, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecommendedAction, ExecutionTaskRecord, StreamTurnContextPayload } from '../../types/agent'
import type { ExecutionRouteProvider, ResolvedTaskRoute } from '../../types/records.js'

import { ExecPlanState } from './ExecPlanState'
import { ExecWorkflowRoute, resolveTurnRouteIdentity } from './ExecWorkflowRoute'

/**
 * 任务路由门面：把「这一回合属于哪个角色 / 哪条工作流」翻成一条可执行路线（期望产出、下一步推荐角色、执行计划），
 * 并把计划状态相关的推算一并收口，调用方只认这一个入口。
 *
 * 自己不存状态，路线由构造时注入的 `ExecutionRouteProvider` 提供；没有 provider 时给一条空路线，不抛错。
 * 实现是 `ExecRouting`（对外别名 `ExecutionRoutingCoordinator`），`ExecutionService` 建一份传给各账本。
 */
export interface ExecRoutingApi {
  /** 从流式回合上下文取出角色与工作流标识，再解析路线；界面开一轮新回合时走这里。 */
  resolveFromTurnContext(payload: StreamTurnContextPayload): ResolvedTaskRoute
  /** 已经有角色/工作流标识时直接解析路线；返回的执行计划已按当前状态刷新过。 */
  resolveFromRouteIdentity(identity: AgentTurnRouteIdentity): ResolvedTaskRoute
  /** 重新推算整份执行计划里各步骤的状态（谁该 running、谁已经 completed），返回新数组，不改入参。 */
  refreshExecutionPlan(plan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[]
  /** 找出该由本角色亲自动手的第一个待办步骤；`roleId` 为空表示不限角色。没有可动手的步骤时返回 null。 */
  findFirstActionableSelfStep(plan: ExecutionTaskPlanStep[], roleId: Nullable<AgentRoleId>): Nullable<ExecutionTaskPlanStep>
  /** 根据任务当前的计划状态，给界面一条「下一步建议做什么」；无从建议时返回 null。 */
  resolveRecommendedAction(task: ExecutionTaskRecord): Nullable<ExecutionTaskRecommendedAction>
  /** 根据任务当前的计划状态，给模型一条执行提示（该继续、该交棒还是该收尾）；无提示时返回 null。 */
  resolveExecutionAdvice(task: ExecutionTaskRecord): Nullable<ExecutionTaskExecutionAdvice>
}

class ExecRouting implements ExecRoutingApi {
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

/** 建一台执行路由器：按回合身份解出下一步交给谁。 */
export function createExecutionRouting(provider?: ExecutionRouteProvider): ExecRoutingApi {
  return new ExecRouting(provider)
}
