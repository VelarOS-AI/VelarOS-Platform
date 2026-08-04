import type {
  AgentRoleId,
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStep,
  ExecutionTaskRecommendedAction,
  ExecutionTaskRecord,
} from '@velaros-ai/agent/protocol'
import { isEmpty,toNullable } from '@velaros-ai/core'

/**
 * 执行计划状态辅助器。
 *
 * 提供两类纯函数：
 * 1. refreshExecutionPlan — 根据依赖关系刷新 actionable 标志，让调用方一眼看到“现在能跑哪些步骤”。
 * 2. resolveRecommendedAction / resolveExecutionAdvice — 综合 mode、status、角色，
 *    给出当前节点的下一步建议（继续自己跑 / 委派 / 等待 / 完成）。
 */
class ExecPlanState {
  /** 重新计算 actionable：步骤要么待运行，要么已经在跑，且依赖都已 completed/skipped。 */
  public refreshExecutionPlan(plan: ExecutionTaskPlanStep[]): ExecutionTaskPlanStep[] {
    const statusById = new Map(plan.map((step) => [step.id, step.status]))

    return plan.map((step) => ({
      ...step,
      actionable:
        (step.status === 'pending' || step.status === 'running')
        && step.dependsOn.every((dependencyId) => {
          const dependencyStatus = statusById.get(dependencyId)!
          return dependencyStatus === 'completed' || dependencyStatus === 'skipped'
        }),
    }))
  }

  public findFirstActionableSelfStep(
    plan: ExecutionTaskPlanStep[],
    roleId: Nullable<AgentRoleId>,
  ): Nullable<ExecutionTaskPlanStep> {
    if (!roleId) return null

    return toNullable(this.refreshExecutionPlan(plan).find((step) =>
      step.mode === 'self'
      && step.roleId === roleId
      && step.actionable
      && step.status === 'pending'
    ))
  }

  public resolveRecommendedAction(task: ExecutionTaskRecord): Nullable<ExecutionTaskRecommendedAction> {
    const plan = this.refreshExecutionPlan(task.executionPlan)
    if (isEmpty(plan)) return null

    const actionableDelegatedStep = this.selectPreferredActionableDelegatedStep(plan)
    if (actionableDelegatedStep) return {
        kind: 'delegate',
        planStepId: actionableDelegatedStep.id,
        roleId: actionableDelegatedStep.roleId,
        title: actionableDelegatedStep.title,
        objective: actionableDelegatedStep.objective,
        blockingStepIds: [],
      }

    const actionableSelfStep = plan.find((step) =>
      step.mode === 'self'
      && step.actionable
      && (step.status === 'pending' || step.status === 'running')
    )
    if (actionableSelfStep) return {
        kind: 'self',
        planStepId: actionableSelfStep.id,
        roleId: actionableSelfStep.roleId,
        title: actionableSelfStep.title,
        objective: actionableSelfStep.objective,
        blockingStepIds: [],
      }

    const pendingStep = plan.find((step) =>
      step.status === 'pending' || step.status === 'delegated' || step.status === 'running'
    )
    if (pendingStep) return {
        kind: 'wait',
        planStepId: pendingStep.id,
        roleId: pendingStep.roleId,
        title: pendingStep.title,
        objective: pendingStep.objective,
        blockingStepIds: pendingStep.dependsOn,
      }

    const completedOrSkipped = plan.every((step) =>
      step.status === 'completed' || step.status === 'skipped'
    )
    if (completedOrSkipped) return {
        kind: 'done',
        planStepId: null,
        roleId: task.roleId,
        title: '当前节点已完成',
        objective: '该任务节点的计划步骤已经全部结束。',
        blockingStepIds: [],
      }

    return null
  }

  public resolveExecutionAdvice(task: ExecutionTaskRecord): Nullable<ExecutionTaskExecutionAdvice> {
    const recommendedAction = this.resolveRecommendedAction(task)
    if (!recommendedAction) return null

    switch (recommendedAction.kind) {
      case 'self':
        return {
          mode: 'auto-continue',
          planStepId: recommendedAction.planStepId,
          roleId: recommendedAction.roleId,
          title: recommendedAction.title,
          objective: recommendedAction.objective,
          reason: '当前节点还有可由当前角色继续推进的步骤。',
          blockingStepIds: [],
        }
      case 'delegate':
        return {
          mode: 'prompt-delegation',
          planStepId: recommendedAction.planStepId,
          roleId: recommendedAction.roleId,
          title: recommendedAction.title,
          objective: recommendedAction.objective,
          reason: '当前节点下一步应派发给下游角色处理。',
          blockingStepIds: [],
        }
      case 'wait':
        return {
          mode: 'wait',
          planStepId: recommendedAction.planStepId,
          roleId: recommendedAction.roleId,
          title: recommendedAction.title,
          objective: recommendedAction.objective,
          reason: '当前节点仍在等待前置步骤完成。',
          blockingStepIds: recommendedAction.blockingStepIds,
        }
      case 'done':
        return {
          mode: 'completed',
          planStepId: recommendedAction.planStepId,
          roleId: recommendedAction.roleId,
          title: recommendedAction.title,
          objective: recommendedAction.objective,
          reason: '当前节点的执行计划已经全部完成。',
          blockingStepIds: [],
        }
    }
  }

  public selectPreferredActionableDelegatedStep(
    plan: ExecutionTaskPlanStep[],
  ): Nullable<ExecutionTaskPlanStep> {
    const actionableSteps = plan.filter((step) =>
      step.mode === 'delegated'
      && step.actionable
      && step.status === 'pending'
    )

    if (isEmpty(actionableSteps)) return null

    return toNullable(actionableSteps
      .sort((left, right) => {
        if (left.required !== right.required) return left.required ? -1 : 1

        return plan.findIndex((step) => step.id === left.id)
          - plan.findIndex((step) => step.id === right.id)
      })[0])
  }
}

export { ExecPlanState }
export { ExecPlanState as ExecutionPlanStateHelper }
