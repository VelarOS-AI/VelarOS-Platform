import type {
  ExecutionEventSeverity,
  ExecutionRecord,
  ExecutionTaskPlanStep,
  ExecutionTaskPlanStepStatus,
  ExecutionTaskRecord,
} from '@velaros-ai/agent/protocol'
import { toNullable } from '@velaros-ai/core'

import { type ExecRouting } from './routing'
import type { ExecutionTaskLedgerStore } from './store-types'

class ExecRecordSeverity {
  public getExecutionStatusSeverity(status: ExecutionRecord['status']): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'aborted':
      case 'awaiting_confirmation':
      case 'awaiting_input':
        return 'warning'
      case 'pending':
      case 'running':
        return 'info'
    }
  }

  public getTaskStatusSeverity(status: ExecutionTaskRecord['status']): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'aborted':
      case 'awaiting_confirmation':
      case 'awaiting_input':
        return 'warning'
      case 'pending':
      case 'running':
        return 'info'
    }
  }

  public getPlanStepStatusSeverity(status: ExecutionTaskPlanStepStatus): ExecutionEventSeverity {
    switch (status) {
      case 'completed':
        return 'success'
      case 'failed':
        return 'error'
      case 'skipped':
        return 'warning'
      case 'pending':
      case 'delegated':
      case 'running':
        return 'info'
    }
  }
}

/**
 * 任务账本辅助器。
 *
 * 把任务/计划步骤的底层写入与事件追加封装在一起：
 * - updateTask / updatePlanStep 会自动写 task-status-changed、plan-step-updated 事件。
 * - startOwnSelfStepIfNeeded / completeOwnSelfStep / failOwnSelfStep 维护“本任务自己执行”的隐含步骤。
 * - restoreParentTaskFocus 在子任务结束后把 currentTaskId 还给父任务。
 */
class ExecTaskLedger {
  constructor(
    private readonly store: ExecutionTaskLedgerStore,
    private readonly routingCoordinator: ExecRouting,
    private readonly severityHelper: ExecRecordSeverity,
  ) {}

  public findTask(executionId: string, taskId: string): Nullable<ExecutionTaskRecord> {
    return toNullable(this.store.require(executionId).tasks.find((task) => task.id === taskId))
  }

  public updateTask(
    executionId: string,
    taskId: string,
    updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord,
    emitDebug = true,
  ): ExecutionTaskRecord {
    const previousTask = this.findTask(executionId, taskId)!
    const nextExecution = this.store.updateTask(executionId, taskId, (task) =>
      this.hydrateTaskWorkflow(updater(task))
    )
    const nextTask = nextExecution.tasks.find((task) => task.id === taskId)!

    if (previousTask.status !== nextTask.status) {
      this.store.appendEvent(executionId, {
        kind: 'task-status-changed',
        severity: this.severityHelper.getTaskStatusSeverity(nextTask.status),
        title: '任务状态已更新',
        message: `${nextTask.title}: ${previousTask.status} -> ${nextTask.status}`,
        taskId: nextTask.id,
        planStepId: nextTask.linkedPlanStepId,
        payload: {
          title: nextTask.title,
          previousStatus: previousTask.status,
          status: nextTask.status,
          roleId: nextTask.roleId,
          parentTaskId: nextTask.parentTaskId,
        },
      })
    }

    if (emitDebug) {
      this.store.emitDebug(executionId)
    }

    return nextTask
  }

  public updatePlanStep(
    executionId: string,
    taskId: string,
    planStepId: string,
    patch: {
      status: ExecutionTaskPlanStep['status']
      taskId: Nullable<string>
    },
    promoteSelfStep = true,
  ): void {
    const previousTask = this.findTask(executionId, taskId)!
    const previousStep = previousTask.executionPlan.find((step) => step.id === planStepId)!
    this.updateTask(executionId, taskId, (task) => ({
      ...task,
      executionPlan: this.routingCoordinator.refreshExecutionPlan(
        task.executionPlan.map((step) =>
          step.id === planStepId
            ? {
              ...step,
              status: patch.status,
              taskId: patch.taskId,
              updatedAt: Date.now(),
            }
            : step
        )
      ),
      updatedAt: Date.now(),
    }), false)
    const nextTask = this.findTask(executionId, taskId)!
    const nextStep = nextTask.executionPlan.find((step) => step.id === planStepId)!
    if (previousStep.status !== nextStep.status || previousStep.taskId !== nextStep.taskId) {
      this.store.appendEvent(executionId, {
        kind: 'plan-step-updated',
        severity: this.severityHelper.getPlanStepStatusSeverity(nextStep.status),
        title: '计划步骤已更新',
        message: `${nextStep.title}: ${previousStep.status} -> ${nextStep.status}`,
        taskId,
        planStepId,
        payload: {
          title: nextStep.title,
          previousStatus: previousStep.status,
          status: nextStep.status,
          previousLinkedTaskId: previousStep.taskId,
          linkedTaskId: nextStep.taskId,
        },
      })
    }
    promoteSelfStep && this.startOwnSelfStepIfNeeded(executionId, taskId)
    this.store.emitDebug(executionId)
  }

  public startOwnSelfStepIfNeeded(executionId: string, taskId: string): void {
    const task = this.findTask(executionId, taskId)!
    if (task.linkedPlanStepId || !task.roleId) return

    const step = this.routingCoordinator.findFirstActionableSelfStep(task.executionPlan, task.roleId)
    if (!step || step.status !== 'pending') return

    this.updatePlanStep(executionId, taskId, step.id, {
      status: 'running',
      taskId: null,
    }, false)
  }

  public completeOwnSelfStep(executionId: string, taskId: string): void {
    const task = this.findTask(executionId, taskId)!
    if (task.linkedPlanStepId || !task.roleId) return

    const step = this.findCurrentSelfStep(task)
    if (!step) return

    this.updatePlanStep(executionId, taskId, step.id, {
      status: 'completed',
      taskId: null,
    })
  }

  public failOwnSelfStep(executionId: string, taskId: string): void {
    const task = this.findTask(executionId, taskId)!
    if (task.linkedPlanStepId || !task.roleId) return

    const step = this.findCurrentSelfStep(task)
    if (!step) return

    this.updatePlanStep(executionId, taskId, step.id, {
      status: 'failed',
      taskId: null,
    }, false)
  }

  public restoreParentTaskFocus(
    executionId: string,
    taskId: string,
    patchExecution: (
      executionId: string,
      updater: (execution: ExecutionRecord) => ExecutionRecord
    ) => ExecutionRecord,
  ): void {
    const task = this.findTask(executionId, taskId)!
    const parentTaskId = task.parentTaskId
    if (!parentTaskId) return

    const execution = this.store.require(executionId)
    if (execution.currentTaskId !== taskId) return

    patchExecution(executionId, (current) => ({
      ...current,
      currentTaskId: parentTaskId,
      updatedAt: Date.now(),
    }))
    this.store.appendEvent(executionId, {
      kind: 'task-focus-changed',
      severity: 'info',
      title: '当前任务已切换',
      message: parentTaskId,
      taskId: parentTaskId,
      planStepId: null,
      payload: {
        previousTaskId: taskId,
        taskId: parentTaskId,
      },
    })
    this.store.emitDebug(executionId)
  }

  public hydrateTaskWorkflow(task: ExecutionTaskRecord): ExecutionTaskRecord {
    const executionPlan = this.routingCoordinator.refreshExecutionPlan(task.executionPlan)
    const nextTask = {
      ...task,
      executionPlan,
    }

    return {
      ...nextTask,
      recommendedAction: this.routingCoordinator.resolveRecommendedAction(nextTask),
    }
  }

  private findCurrentSelfStep(task: ExecutionTaskRecord): Nullable<ExecutionTaskPlanStep> {
    return toNullable(task.executionPlan.find((item) =>
      item.mode === 'self'
      && item.roleId === task.roleId
      && (item.status === 'running' || (item.status === 'pending' && item.actionable))
    ))
  }
}

export { ExecRecordSeverity, ExecTaskLedger,ExecRecordSeverity as ExecutionRecordSeverityHelper }
export { ExecTaskLedger as ExecutionTaskLedgerHelper }
