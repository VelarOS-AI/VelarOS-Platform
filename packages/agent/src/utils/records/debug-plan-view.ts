import { isEmpty, toNullable } from '@velaros-ai/core'

import type { ExecutionPlanView, ExecutionRecord, ExecutionTaskExecutionAdvice, ExecutionTaskPlanStepStatus, ExecutionTaskRecord } from '../../types/agent.js'

/**
 * 找「计划视图该拿谁的计划来画」：从当前任务往父任务一路上溯，取第一个自己带执行计划的祖先。
 *
 * 当前任务本身是被父计划某一步派出来的（有 `linkedPlanStepId`）时跳过它，
 * 这样子任务在跑的时候，面板上看到的仍是父任务那盘完整的计划，而不是子任务自己的一小段。
 * 一路上溯都没有计划时，退回当前任务自己的计划；它也没有就返回 null。
 */
export function resolvePlanOwnerTask(
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

/**
 * 判定计划视图里该高亮哪一步。
 *
 * 优先级从高到低：当前任务绑定的那一步（仅当它确实是这份计划派出去的子任务）、这份计划的推荐动作指向的那一步、
 * 第一个 running 的步骤、第一个 delegated 的步骤。都没有时返回 null，表示这份计划眼下没有活跃步骤。
 */
export function resolveActiveStepId(
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

/** 数一份计划里处于某个状态的步骤有几个，用来拼计划视图顶部那行汇总。 */
export function countStepsByStatus(
  steps: Array<{ status: ExecutionTaskPlanStepStatus }>,
  status: ExecutionTaskPlanStepStatus
): number {
  return steps.filter((step) => step.status === status).length
}

/**
 * 把任务的推荐动作翻成给模型看的执行建议：动作类型决定 mode（self=继续自己做、delegate=该派下去、wait=还得等、其余=已完成），
 * 并配上一句中文理由。任务没有推荐动作时返回 null，表示这一轮没有建议可给。
 */
export function buildExecutionAdvice(
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

/**
 * 拼出调试面板要的计划视图：选定计划归属任务后，给每一步标上是否活跃、被哪些未完成的前置步骤卡着、
 * 以及它绑定的子任务的标题与状态，最后附一行各状态计数和这份计划的推荐动作、执行建议。
 *
 * 谁都没有执行计划时返回 null，面板据此不画计划区。
 */
export function buildPlanView(
  execution: ExecutionRecord,
  currentTask: ExecutionTaskRecord
): Nullable<ExecutionPlanView> {
  const taskById = new Map(execution.tasks.map((task) => [task.id, task]))
  const planOwnerTask =
    toNullable(resolvePlanOwnerTask(currentTask, taskById) ??
    execution.tasks.find((task) => !isEmpty(task.executionPlan)))

  if (!planOwnerTask || isEmpty(planOwnerTask.executionPlan)) return null

  const statusById = new Map(planOwnerTask.executionPlan.map((step) => [step.id, step.status]))
  const activeStepId = resolveActiveStepId(planOwnerTask, currentTask)
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
      pending: countStepsByStatus(steps, 'pending'),
      delegated: countStepsByStatus(steps, 'delegated'),
      running: countStepsByStatus(steps, 'running'),
      completed: countStepsByStatus(steps, 'completed'),
      failed: countStepsByStatus(steps, 'failed'),
      skipped: countStepsByStatus(steps, 'skipped'),
    },
    recommendedAction: planOwnerTask.recommendedAction,
    executionAdvice: buildExecutionAdvice(planOwnerTask),
  }
}
