import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ExecutionPlanView, ExecutionRecord, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStepStatus, ExecutionTaskRecord, StreamExecutionGraphPayload } from '../../types/agent.js'

/**
 * 调试图载荷构造器。
 *
 * 把 ExecutionRecord 转成调试面板需要的扁平化结构：
 * - 计划视图选用「拥有执行计划的最具体祖先任务」作为视图，
 *   保证子任务运行时仍能看到父任务的整体计划。
 * - 活跃步骤标识优先采用绑定子任务的步骤，然后是推荐动作，最后才退化到运行或委派状态。
 * - 事件只取最近 80 条，避免长执行的调试载荷过大。
 */
class ExecDebugPayload {
  public build(execution: ExecutionRecord): StreamExecutionGraphPayload {
    const currentTaskId = execution.currentTaskId
    const currentTask = this.requireCurrentTask(execution)
    const currentExecutionAdvice = this.buildExecutionAdvice(currentTask)

    return {
      kind: 'execution-graph',
      executionId: execution.id,
      sourceSessionId: execution.sourceSessionId,
      status: execution.status,
      currentTaskId,
      currentRecommendedAction: (toNullable(currentTask.recommendedAction)),
      currentExecutionAdvice,
      planView: this.buildPlanView(execution, currentTask),
      roleId: execution.roleId,
      roleLabel: execution.roleLabel,
      tasks: execution.tasks,
      events: execution.events.slice(-80),
    }
  }

  private buildPlanView(
    execution: ExecutionRecord,
    currentTask: ExecutionTaskRecord
  ): Nullable<ExecutionPlanView> {
    const taskById = new Map(execution.tasks.map((task) => [task.id, task]))
    const planOwnerTask =
      toNullable(this.resolvePlanOwnerTask(currentTask, taskById) ??
      execution.tasks.find((task) => !isEmpty(task.executionPlan)))

    if (!planOwnerTask || isEmpty(planOwnerTask.executionPlan)) return null

    const statusById = new Map(planOwnerTask.executionPlan.map((step) => [step.id, step.status]))
    const activeStepId = this.resolveActiveStepId(planOwnerTask, currentTask)
    const steps = planOwnerTask.executionPlan.map((step) => {
      const linkedTask = step.taskId ? taskById.get(step.taskId)! : null
      const blockedBy = step.dependsOn.filter((dependencyId) => {
        const dependencyStatus = statusById.get(dependencyId)!
        return dependencyStatus !== 'completed' && dependencyStatus !== 'skipped'
      })

      return {
        ...step,
        active: step.id === activeStepId || (currentTask ? step.taskId === currentTask.id : false),
        blockedBy,
        linkedTaskTitle: (toNullable(linkedTask?.title)),
        linkedTaskStatus: (toNullable(linkedTask?.status)),
      }
    })

    return {
      taskId: planOwnerTask.id,
      taskTitle: planOwnerTask.title,
      activeStepId,
      steps,
      summary: {
        total: steps.length,
        pending: this.countStepsByStatus(steps, 'pending'),
        delegated: this.countStepsByStatus(steps, 'delegated'),
        running: this.countStepsByStatus(steps, 'running'),
        completed: this.countStepsByStatus(steps, 'completed'),
        failed: this.countStepsByStatus(steps, 'failed'),
        skipped: this.countStepsByStatus(steps, 'skipped'),
      },
      recommendedAction: planOwnerTask.recommendedAction,
      executionAdvice: this.buildExecutionAdvice(planOwnerTask),
    }
  }

  private resolvePlanOwnerTask(
    currentTask: ExecutionTaskRecord,
    taskById: Map<string, ExecutionTaskRecord>
  ): Nullable<ExecutionTaskRecord> {
    let cursor: Nullable<ExecutionTaskRecord> = currentTask
    while (cursor) {
      const isLinkedCurrentTask = currentTask.linkedPlanStepId && cursor.id === currentTask.id
      if (!isEmpty(cursor.executionPlan) && !isLinkedCurrentTask) return cursor

      if (!cursor.parentTaskId) {
        break
      }
      cursor = toNullable(taskById.get(cursor.parentTaskId))
    }

    return !isEmpty(currentTask.executionPlan) ? currentTask : null
  }

  private resolveActiveStepId(
    planOwnerTask: ExecutionTaskRecord,
    currentTask: ExecutionTaskRecord
  ): Nullable<string> {
    const currentLinkedStep =
      currentTask.parentTaskId === planOwnerTask.id ? currentTask.linkedPlanStepId : null

    return (
      toNullable(currentLinkedStep ??
      planOwnerTask.recommendedAction?.planStepId ??
      planOwnerTask.executionPlan.find((step) => step.status === 'running')?.id ??
      planOwnerTask.executionPlan.find((step) => step.status === 'delegated')?.id)
    )
  }

  private countStepsByStatus(
    steps: Array<{ status: ExecutionTaskPlanStepStatus }>,
    status: ExecutionTaskPlanStepStatus
  ): number {
    return steps.filter((step) => step.status === status).length
  }

  private buildExecutionAdvice(
    task: Nullable<ExecutionTaskRecord>
  ): Nullable<ExecutionTaskExecutionAdvice> {
    if (!task?.recommendedAction) return null

    const recommendedAction = task.recommendedAction

    return {
      mode:
        recommendedAction.kind === 'self'
          ? 'auto-continue'
          : recommendedAction.kind === 'delegate'
            ? 'prompt-delegation'
            : recommendedAction.kind === 'wait'
              ? 'wait'
              : 'completed',
      planStepId: recommendedAction.planStepId,
      roleId: recommendedAction.roleId,
      title: recommendedAction.title,
      objective: recommendedAction.objective,
      reason:
        recommendedAction.kind === 'self'
          ? '当前节点还有可由当前角色继续推进的步骤。'
          : recommendedAction.kind === 'delegate'
            ? '当前节点下一步应派发给下游角色处理。'
            : recommendedAction.kind === 'wait'
              ? '当前节点仍在等待前置步骤完成。'
              : '当前节点的执行计划已经全部完成。',
      blockingStepIds: recommendedAction.blockingStepIds,
    }
  }

  private requireCurrentTask(execution: ExecutionRecord): ExecutionTaskRecord {
    const currentTaskId = execution.currentTaskId
    const currentTask = execution.tasks.find((task) => task.id === currentTaskId)
    if (currentTask) return currentTask

    throw new AppError(
      'INVARIANT',
      `Execution current task not found: ${execution.id}/${currentTaskId}`,
      undefined,
      {
        executionId: execution.id,
        currentTaskId,
        operation: 'buildDebugPayload',
      }
    )
  }
}

export { ExecDebugPayload, ExecDebugPayload as ExecutionDebugPayloadBuilder }
