import type { AgentRoleId, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStep, ExecutionTaskRecommendedAction, ExecutionTaskRecord } from '../../types/agent.js'
import { findFirstActionableSelfStep, refreshExecutionPlan, resolveExecutionAdvice, resolveRecommendedAction, selectPreferredActionableDelegatedStep } from '../../utils/records/plan-state'

/**
 * 执行计划状态辅助器。
 *
 * 提供两类纯函数：
 * 1. refreshExecutionPlan — 根据依赖关系刷新 actionable 标志，让调用方一眼看到“现在能跑哪些步骤”。
 * 2. resolveRecommendedAction / resolveExecutionAdvice — 综合 mode、status、角色，
 *    给出当前节点的下一步建议（继续自己跑 / 委派 / 等待 / 完成）。
 *
 * 规则本身住在 `utils/records/plan-state.ts`，这里只把它们收成一个可注入的件，`ExecRouting` 与
 * `ExecWorkflowRoute` 各持一份；类自己不存任何状态，每次都从传进来的计划重算。
 */
export interface ExecPlanStateApi {
  /** 重新推算整份计划里各步骤的 actionable（依赖都 completed/skipped 才算可动手），返回新数组，不改入参。 */
  refreshExecutionPlan(plan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[]
  /** 找出该由指定角色亲自动手的第一个待办步骤；角色为空或没有可动手的步骤时返回 null。 */
  findFirstActionableSelfStep(plan: ExecutionTaskPlanStep[], roleId: Nullable<AgentRoleId>): Nullable<ExecutionTaskPlanStep>
  /** 给界面一条「下一步建议做什么」：委派 / 自己跑 / 等前置 / 已完成；计划为空时返回 null。 */
  resolveRecommendedAction(task: ExecutionTaskRecord): Nullable<ExecutionTaskRecommendedAction>
  /** 把下一步建议翻成给模型看的执行提示（继续、交棒、等待还是收尾）；无建议时返回 null。 */
  resolveExecutionAdvice(task: ExecutionTaskRecord): Nullable<ExecutionTaskExecutionAdvice>
  /** 在可动手的委派步骤里挑一个先派：必做的优先，同级按计划原始顺序；一个都没有时返回 null。 */
  selectPreferredActionableDelegatedStep(plan: ExecutionTaskPlanStep[]): Nullable<ExecutionTaskPlanStep>
}

class ExecPlanState implements ExecPlanStateApi {
  public refreshExecutionPlan(plan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[] {
    return refreshExecutionPlan(plan)
  }

  public findFirstActionableSelfStep(
    plan: ExecutionTaskPlanStep[],
    roleId: Nullable<AgentRoleId>,
  ): Nullable<ExecutionTaskPlanStep> {
    return findFirstActionableSelfStep(plan, roleId)
  }

  public resolveRecommendedAction(task: ExecutionTaskRecord): Nullable<ExecutionTaskRecommendedAction> {
    return resolveRecommendedAction(task)
  }

  public resolveExecutionAdvice(task: ExecutionTaskRecord): Nullable<ExecutionTaskExecutionAdvice> {
    return resolveExecutionAdvice(task)
  }

  public selectPreferredActionableDelegatedStep(
    plan: ExecutionTaskPlanStep[],
  ): Nullable<ExecutionTaskPlanStep> {
    return selectPreferredActionableDelegatedStep(plan)
  }
}

export { ExecPlanState, ExecPlanState as ExecutionPlanStateHelper }

/** 建一份执行计划状态机。 */
export function createExecutionPlanState(): ExecPlanStateApi {
  return new ExecPlanState()
}
