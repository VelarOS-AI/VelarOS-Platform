import { toNullable } from '@velaros-ai/core'

import type { ExecutionRecord, ExecutionTaskPlanStep, ExecutionTaskRecord } from '../../types/agent.js'
import type { ExecutionTaskLedgerStore } from '../../types/records.js'
import { findCurrentSelfStep } from '../../utils/records/plan-steps'

import { type ExecRecordSeverity } from './ExecRecordSeverity'
import { type ExecRouting } from './ExecRouting'
export function hasRunningOwnSelfStep(
  plan: readonly ExecutionTaskPlanStep[],
  roleId: string
): boolean {
  return plan.some(
    (step) => step.mode === 'self' && step.roleId === roleId && step.status === 'running'
  )
}


/**
 * 任务与计划步骤的写入口：改任务、改步骤都从这里走，顺带把该配的事件
 * （task-status-changed / plan-step-updated / task-focus-changed）一并追进账本，调用方不用自己记得补事件。
 *
 * 自己不存数据，读写都落在构造时注入的 `ExecutionTaskLedgerStore` 上；事件严重度问 `ExecRecordSeverity`，
 * 计划状态推算问 `ExecRouting`。实现是 `ExecTaskLedger`（对外别名 `ExecutionTaskLedgerHelper`）。
 */
export interface ExecTaskLedgerApi {
  /** 在这次执行里按 id 找一个任务；没有就返回 null。下面几个方法都假定调用方已经确认任务存在。 */
  findTask(executionId: string, taskId: string): Nullable<ExecutionTaskRecord>
  /** 改一个任务：`updater` 返回的新任务会先补齐计划状态与推荐动作再落库；状态真的变了才追一条 task-status-changed。`emitDebug` 传 false 表示这次改动还没完（外层会连着改下一处），暂不推调试快照。 */
  updateTask(executionId: string, taskId: string, updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord, emitDebug?: boolean): ExecutionTaskRecord
  /** 改一个计划步骤的状态和它绑定的子任务：状态或绑定真的变了才追一条 plan-step-updated。`promoteSelfStep` 传 false 可以不顺手接着点亮下一个自执行步骤，用在「这步刚失败」这类不该往下走的场合。 */
  updatePlanStep(executionId: string, taskId: string, planStepId: string, patch: {
    /** 这个步骤改成什么状态。 */
    status: ExecutionTaskPlanStep['status']
    /** 这个步骤绑到哪个子任务上；不绑（自己做或还没派出去）时传 null。 */
    taskId: Nullable<string>
  }, promoteSelfStep?: boolean): void
  /** 把「本角色亲自做」的第一个待办步骤点成 running。已经绑了步骤的任务、没有角色的任务一律跳过；已经有一个自执行步骤在跑时也跳过——每一轮都会刷新角色，那不是「开始下一步」的信号，否则连只读的计划查询都会把步骤一个个点亮。 */
  startOwnSelfStepIfNeeded(executionId: string, taskId: string): void
  /** 把当前那个自执行步骤记成 completed，并接着点亮下一个；找不到在跑的自执行步骤时什么都不做。 */
  completeOwnSelfStep(executionId: string, taskId: string): void
  /** 把当前那个自执行步骤记成 failed；失败后不再自动点亮下一步，要不要继续由上层决定。 */
  failOwnSelfStep(executionId: string, taskId: string): void
  /** 子任务收尾后把执行的 `currentTaskId` 交还给父任务，并追一条 task-focus-changed。没有父任务、或焦点已经不在这个子任务上时什么都不做。执行记录本体的改写由传进来的 `patchExecution` 完成。 */
  restoreParentTaskFocus(executionId: string, taskId: string, patchExecution: (executionId: string, updater: (execution: ExecutionRecord) => ExecutionRecord) => ExecutionRecord): void
  /** 给一份任务快照补齐派生字段：按当前状态刷新执行计划，再算出推荐动作。返回新对象，不改入参；每次写任务前都会过一遍。 */
  hydrateTaskWorkflow(task: ExecutionTaskRecord): ExecutionTaskRecord
}

class ExecTaskLedger implements ExecTaskLedgerApi {
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
    // 每个 turn 都会刷新角色记录；这不是“开始下一步”的信号。已有自执行步骤运行时必须保持原状，
    // 否则连续流式 turn 会把所有无依赖步骤逐个点成 running，连只读 plan 查询也表现为写操作。
    if (hasRunningOwnSelfStep(task.executionPlan, task.roleId)) return

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

    const step = findCurrentSelfStep(task)
    if (!step) return

    this.updatePlanStep(executionId, taskId, step.id, {
      status: 'completed',
      taskId: null,
    })
  }

  public failOwnSelfStep(executionId: string, taskId: string): void {
    const task = this.findTask(executionId, taskId)!
    if (task.linkedPlanStepId || !task.roleId) return

    const step = findCurrentSelfStep(task)
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

}

export { ExecTaskLedger }
export { ExecTaskLedger as ExecutionTaskLedgerHelper }
