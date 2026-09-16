
import { isEmpty, toNullable } from '@velaros-ai/core'
import { logRuntime } from '@velaros-ai/core/logger'

import type { ExecutionIdFactory } from '../../contract/requires.js'
import type { ConfirmationRequestDetail, ExecutionRecord, ExecutionTaskPlanStep, ExecutionTaskRecord, StreamTurnContextPayload, ToolExecutionPlanUpdate, UserActionCard } from '../../types/agent'
import type { CreateExecutionArgs, ExecutionResourceProvider } from '../../types/records.js'
import { requireCurrentTask } from '../../utils/records/execution-tasks'

import { ExecutionPlanLedgerHelper } from './ExecPlanLedger'
import { ExecutionRecordSeverityHelper } from './ExecRecordSeverity'
import { type ExecutionRoutingCoordinator } from './ExecRouting'
import { type ExecutionStateMachine } from './ExecStateMachine'
import { ExecutionTaskLedgerHelper } from './ExecTaskLedger'
import { ExecutionRecordSummaryHelper } from './ExecutionRecordSummaryHelper'
import type { ExecutionStoreApi } from './ExecutionStore'
import { MonotonicExecutionIdFactory } from './MonotonicExecutionIdFactory'

/**
 * 执行记录的写入口：`ExecutionService` 管生命周期编排，真正改 `ExecutionRecord` 的活全在这里——
 * 建执行与 root 任务、走状态迁移、任务的起止成败、角色与执行计划的更新，每一步该配的账本事件和调试快照都一并发掉。
 *
 * 自己不存数据（都在注入的 `ExecutionStore` 上），状态迁移合法性交给 `ExecutionStateMachine` 判，
 * 执行与任务 id 由注入的 `ExecutionIdFactory` 生成（宿主可以换成可复现实现）。
 * `currentTaskId` 指不到任务时抛 `INVARIANT`——那说明账本本身坏了，不是调用方用错。
 */
export interface ExecutionRecordsApi {
  /** 建一条新执行：连带建好 root 任务（标题「主执行」，指令取最后一条用户消息的摘要），落库后补 execution-created 与 task-created 两条事件，再推一次调试快照。 */
  createExecution(args: CreateExecutionArgs): ExecutionRecord
  /** 读一条执行记录；不存在时由 store 抛错，不返回 null。 */
  getExecution(executionId: string): ExecutionRecord
  /** 走一次执行状态迁移：状态没变就是幂等写入，不校验也不记事件；真变了才过状态机（非法迁移由状态机抛错）并补一条 execution-status-changed。 */
  transition(executionId: string, nextStatus: ExecutionRecord['status']): ExecutionRecord
  /** 在记录上标记「正在等用户确认」，把要显示的正文、动作卡、细节和这张卡的 `confirmationId` 一并存下，供界面重连后还原确认卡。 */
  setAwaitingConfirmation(executionId: string, message: string, userActionCards?: UserActionCard[], detail?: ConfirmationRequestDetail, confirmationId?: string): ExecutionRecord
  /** 清掉等待确认的标记；用户答完、或交互被中止时都要调，否则界面会残留一张点不动的卡。 */
  clearAwaitingConfirmation(executionId: string): ExecutionRecord
  /** 在记录上标记「正在等用户打字」，存下问题正文和发问时刻。 */
  setAwaitingInput(executionId: string, question: string): ExecutionRecord
  /** 清掉等待输入的标记。 */
  clearAwaitingInput(executionId: string): ExecutionRecord
  /** 把一句执行级错误写进记录；任务级的错误各自记在任务上，这里只放整次执行的失败原因。 */
  setExecutionError(executionId: string, error: string): ExecutionRecord
  /** 清掉执行级错误，用在重试前把上一次的失败抹掉。 */
  clearExecutionError(executionId: string): ExecutionRecord
  /** 把焦点切到某个任务并把它置 running：焦点真变了才补一条 task-focus-changed。这个任务挂在父任务的计划步骤上时，顺带把那一步也点成 running；否则改为点亮它自己的自执行步骤。 */
  startTask(executionId: string, taskId: string): void
  /** 任务成功收尾：写 completed 和结果，同步父任务里对应的计划步骤（没有就收掉自己的自执行步骤），最后把焦点还给父任务。`result` 不传就保留任务原有的结果。 */
  completeTask(executionId: string, taskId: string, result?: LooseOptional<string>): void
  /** 任务失败收尾：写 failed 和错误原因，父计划步骤同步标 failed，焦点还给父任务。 */
  failTask(executionId: string, taskId: string, error: string): void
  /** 任务被中断收尾：任务本身记 aborted，但父计划步骤按 failed 标——界面用同一条失败路径处理这两种情况。`reason` 是给用户看的中断原因。 */
  abortTask(executionId: string, taskId: string, reason: string): void
  /** 直接改任务状态，不动计划步骤、不还焦点：留给少数低层工具和计划同步场景，正常收尾请走 complete / fail / abort。置 running 时会补上首次的 `startedAt`。 */
  setTaskStatus(executionId: string, taskId: string, status: ExecutionTaskRecord['status']): void
  /** 按这一轮的 turn context 更新执行的角色，并把角色带来的 workflow 路线合进当前任务（已有步骤的状态一律保留），随后确认当前任务的自执行步骤已经开跑。 */
  updateRole(executionId: string, payload: StreamTurnContextPayload): void
  /** 读当前任务的执行计划；`currentTaskId` 指不到任务时抛 `INVARIANT`。 */
  getCurrentPlan(executionId: string): ExecutionTaskPlanStep[]
  /** 用模型或界面提交的计划覆盖当前任务的执行计划：保留同名步骤的状态，新增步骤归到当前角色，写一条 plan-updated 事件（有步骤被删时严重度记 warning），返回落好的新计划。 */
  updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate): ExecutionTaskPlanStep[]
  /** 在某个来源会话上找状态落在 `statuses` 里的最近一条执行；没有就返回 null。用来判断「这个会话现在是不是还有活着的执行」。 */
  findLatestBySourceSession(sourceSessionId: string, statuses: Array<ExecutionRecord['status']>): Nullable<ExecutionRecord>
}

class ExecutionRecords implements ExecutionRecordsApi {
  private readonly log = logRuntime.tag('ExecutionRecords')
  /** 根据消息生成执行摘要。 */
  private readonly summaryHelper = new ExecutionRecordSummaryHelper()
  /** 根据状态决定事件 severity。 */
  private readonly severityHelper = new ExecutionRecordSeverityHelper()
  /** 计划步骤合并、手工计划构建和计划 diff。 */
  private readonly planLedgerHelper: ExecutionPlanLedgerHelper
  /** 任务和任务内计划步骤的底层更新 helper。 */
  private readonly taskLedgerHelper: ExecutionTaskLedgerHelper

  constructor(
    /** 执行记录存储。 */
    private readonly store: ExecutionStoreApi,
    /** 状态机校验合法状态迁移。 */
    private readonly stateMachine: ExecutionStateMachine,
    /** 创建 execution 时读取当前 resourceId。 */
    private readonly resourceIdService: ExecutionResourceProvider,
    /** 根据角色/委派解析 workflow plan。 */
    private readonly routingCoordinator: ExecutionRoutingCoordinator,
    /** 执行实例私有的 ID 工厂；宿主可注入可复现实现。 */
    private readonly idFactory: ExecutionIdFactory = new MonotonicExecutionIdFactory(),
  ) {
    this.planLedgerHelper = new ExecutionPlanLedgerHelper(routingCoordinator, idFactory)
    this.taskLedgerHelper = new ExecutionTaskLedgerHelper(
      store,
      routingCoordinator,
      this.severityHelper
    )
  }

  /** 创建新的 ExecutionRecord，并初始化 root task 与两条 ledger 事件。 */
  public createExecution(args: CreateExecutionArgs): ExecutionRecord {
    const now = Date.now()
    const rootTask: ExecutionTaskRecord = {
      id: this.generateTaskId(),
      kind: 'root',
      title: '主执行',
      instruction: this.summaryHelper.buildExecutionSummary(args.messages),
      roleId: null,
      workflowType: null,
      expectedOutput: null,
      delegatedByRoleId: null,
      delegation: null,
      suggestedNextRoles: [],
      executionPlan: [],
      recommendedAction: null,
      linkedPlanStepId: null,
      parentTaskId: null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
    }
    const execution: ExecutionRecord = {
      id: this.generateExecutionId(),
      sourceSessionId: args.sourceSessionId,
      status: 'pending',
      summary: rootTask.instruction,
      resourceId: this.resourceIdService.getActiveResourceId(args.sourceSessionId),
      createdAt: now,
      updatedAt: now,
      roleId: null,
      roleLabel: null,
      roleDescription: null,
      awaitingConfirmation: null,
      awaitingInput: null,
      error: null,
      currentTaskId: rootTask.id,
      tasks: [rootTask],
      events: [],
    }

    this.store.save(execution)
    // execution-created 和 task-created 分开写，方便调试面板按事件类型展示。
    this.store.appendEvent(execution.id, {
      kind: 'execution-created',
      severity: 'info',
      title: '执行已创建',
      message: rootTask.instruction,
      taskId: rootTask.id,
      planStepId: null,
      payload: {
        sourceSessionId: execution.sourceSessionId,
        resourceId: execution.resourceId,
      },
    })
    this.store.appendEvent(execution.id, {
      kind: 'task-created',
      severity: 'info',
      title: '任务已创建',
      message: rootTask.title,
      taskId: rootTask.id,
      planStepId: null,
      payload: {
        kind: rootTask.kind,
        roleId: rootTask.roleId,
        parentTaskId: rootTask.parentTaskId,
      },
    })
    this.store.emitDebug(execution.id)
    this.log.info('execution created', {
      executionId: execution.id,
      sourceSessionId: execution.sourceSessionId,
    })
    return execution
  }

  /** 读取执行记录，不存在时由 store 抛错。 */
  public getExecution(executionId: string): ExecutionRecord {
    return this.store.require(executionId)
  }

  /** 更新 execution 状态，并记录状态变更事件。 */
  public transition(executionId: string, nextStatus: ExecutionRecord['status']): ExecutionRecord {
    const execution = this.getExecution(executionId)
    const previousStatus = execution.status

    if (execution.status !== nextStatus) {
      // 同状态写入是幂等的；只有真正变化时才做状态机校验。
      this.stateMachine.assertCanTransition(execution.status, nextStatus)
    }

    const nextExecution = this.patchExecution(executionId, (current) => ({
      ...current,
      status: nextStatus,
      updatedAt: Date.now(),
    }))
    if (previousStatus !== nextStatus) {
      this.store.appendEvent(executionId, {
        kind: 'execution-status-changed',
        severity: this.severityHelper.getExecutionStatusSeverity(nextStatus),
        title: '执行状态已更新',
        message: `${previousStatus} -> ${nextStatus}`,
        taskId: nextExecution.currentTaskId,
        planStepId: null,
        payload: {
          previousStatus,
          status: nextStatus,
        },
      })
    }

    return nextExecution
  }

  /** 标记执行正在等待用户确认。 */
  public setAwaitingConfirmation(
    executionId: string,
    message: string,
    userActionCards?: UserActionCard[],
    detail?: ConfirmationRequestDetail,
    confirmationId?: string
  ): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      awaitingConfirmation: {
        confirmationId,
        message,
        askedAt: Date.now(),
        userActionCards,
        detail,
      },
      updatedAt: Date.now(),
    }))
  }

  /** 清理等待确认状态。 */
  public clearAwaitingConfirmation(executionId: string): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      awaitingConfirmation: null,
      updatedAt: Date.now(),
    }))
  }

  /** 标记执行正在等待用户输入。 */
  public setAwaitingInput(executionId: string, question: string): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      awaitingInput: {
        question,
        askedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }))
  }

  /** 清理等待输入状态。 */
  public clearAwaitingInput(executionId: string): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      awaitingInput: null,
      updatedAt: Date.now(),
    }))
  }

  /** 写入 execution 级错误。 */
  public setExecutionError(executionId: string, error: string): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      error,
      updatedAt: Date.now(),
    }))
  }

  /** 清理 execution 级错误。 */
  public clearExecutionError(executionId: string): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      error: null,
      updatedAt: Date.now(),
    }))
  }

  /** 切换当前任务并标记任务 running。 */
  public startTask(executionId: string, taskId: string): void {
    const previousTaskId = this.getExecution(executionId).currentTaskId
    this.patchExecution(executionId, (execution) => ({
      ...execution,
      currentTaskId: taskId,
      updatedAt: Date.now(),
    }))
    if (previousTaskId !== taskId) {
      // 任务焦点变化会影响 debug 面板和后续工具写入的 currentTask。
      this.store.appendEvent(executionId, {
        kind: 'task-focus-changed',
        severity: 'info',
        title: '当前任务已切换',
        message: taskId,
        taskId,
        planStepId: null,
        payload: {
          previousTaskId,
          taskId,
        },
      })
    }
    const task = this.taskLedgerHelper.updateTask(executionId, taskId, (task) => ({
      ...task,
      status: 'running',
      startedAt: task.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      error: null,
    }))
    if (task.parentTaskId && task.linkedPlanStepId) {
      // 子任务开始时，同步父任务里对应计划步骤状态。
      this.taskLedgerHelper.updatePlanStep(executionId, task.parentTaskId, task.linkedPlanStepId, {
        status: 'running',
        taskId,
      })
    } else {
      // root/current task 没有父计划步骤时，启动自己的 self step。
      this.taskLedgerHelper.startOwnSelfStepIfNeeded(executionId, taskId)
    }
  }

  /** 完成任务，并同步父计划步骤或 own self step。 */
  public completeTask(executionId: string, taskId: string, result?: LooseOptional<string>): void {
    const task = this.taskLedgerHelper.updateTask(executionId, taskId, (task) => ({
      ...task,
      status: 'completed',
      result: result ?? task.result,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    }))
    if (task.parentTaskId && task.linkedPlanStepId) {
      this.taskLedgerHelper.updatePlanStep(executionId, task.parentTaskId, task.linkedPlanStepId, {
        status: 'completed',
        taskId,
      })
    } else {
      this.taskLedgerHelper.completeOwnSelfStep(executionId, taskId)
    }
    this.taskLedgerHelper.restoreParentTaskFocus(
      executionId,
      taskId,
      this.patchExecution.bind(this)
    )
  }

  /** 标记任务失败，并恢复父任务焦点。 */
  public failTask(executionId: string, taskId: string, error: string): void {
    const task = this.taskLedgerHelper.updateTask(executionId, taskId, (task) => ({
      ...task,
      status: 'failed',
      error,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    }))
    if (task.parentTaskId && task.linkedPlanStepId) {
      this.taskLedgerHelper.updatePlanStep(executionId, task.parentTaskId, task.linkedPlanStepId, {
        status: 'failed',
        taskId,
      })
    } else {
      this.taskLedgerHelper.failOwnSelfStep(executionId, taskId)
    }
    this.taskLedgerHelper.restoreParentTaskFocus(
      executionId,
      taskId,
      this.patchExecution.bind(this)
    )
  }

  /** 标记任务中断；计划步骤层面按 failed 展示，便于 UI 用同一失败路径处理。 */
  public abortTask(executionId: string, taskId: string, reason: string): void {
    const task = this.taskLedgerHelper.updateTask(executionId, taskId, (task) => ({
      ...task,
      status: 'aborted',
      error: reason,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    }))
    if (task.parentTaskId && task.linkedPlanStepId) {
      this.taskLedgerHelper.updatePlanStep(executionId, task.parentTaskId, task.linkedPlanStepId, {
        status: 'failed',
        taskId,
      })
    } else {
      this.taskLedgerHelper.failOwnSelfStep(executionId, taskId)
    }
    this.taskLedgerHelper.restoreParentTaskFocus(
      executionId,
      taskId,
      this.patchExecution.bind(this)
    )
  }

  /** 直接设置任务状态，供少量低层工具/计划同步场景使用。 */
  public setTaskStatus(
    executionId: string,
    taskId: string,
    status: ExecutionTaskRecord['status']
  ): void {
    this.taskLedgerHelper.updateTask(executionId, taskId, (task) => ({
      ...task,
      status,
      startedAt: status === 'running' ? (task.startedAt ?? Date.now()) : task.startedAt,
      updatedAt: Date.now(),
    }))
  }

  /** 根据本轮 turn context 更新 execution 当前角色和任务 workflow。 */
  public updateRole(executionId: string, payload: StreamTurnContextPayload): void {
    const resolvedWorkflow = this.routingCoordinator.resolveFromTurnContext(payload)
    const execution = this.patchExecution(executionId, (current) => ({
      ...current,
      roleId: payload.roleId,
      roleLabel: payload.roleLabel,
      roleDescription: payload.roleDescription,
      updatedAt: Date.now(),
    }))
    const currentTaskId = execution.currentTaskId
    requireCurrentTask(execution, 'update role')
    this.taskLedgerHelper.updateTask(execution.id, currentTaskId, (task) => ({
      ...task,
      roleId: payload.roleId,
      workflowType: resolvedWorkflow.workflowType,
      expectedOutput: resolvedWorkflow.expectedOutput,
      suggestedNextRoles: resolvedWorkflow.suggestedNextRoles,
      executionPlan: this.planLedgerHelper.mergeExecutionPlan(
        task.executionPlan,
        resolvedWorkflow.executionPlan
      ),
      updatedAt: Date.now(),
    }))
    // 角色上下文进入后，确保当前任务自己的 self step 已开始。
    this.taskLedgerHelper.startOwnSelfStepIfNeeded(executionId, currentTaskId)
    this.store.emitDebug(executionId)
  }

  /** 读取当前任务的执行计划。 */
  public getCurrentPlan(executionId: string): ExecutionTaskPlanStep[] {
    const execution = this.getExecution(executionId)
    const task = requireCurrentTask(execution, 'read current plan')
    return task.executionPlan
  }

  /** 用工具传入的计划更新当前任务执行计划，并写入 plan-updated 事件。 */
  public updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate): ExecutionTaskPlanStep[] {
    const execution = this.getExecution(executionId)
    const task = requireCurrentTask(execution, 'update current plan')

    const now = Date.now()
    const roleId = task.roleId ?? execution.roleId ?? 'chat'
    const kind = this.planLedgerHelper.resolveManualPlanStepKind(task)
    const previousPlan = task.executionPlan
    // 手工计划更新会保留已有步骤状态，并把新增/更新步骤归到当前角色。
    const nextPlan = this.planLedgerHelper.buildManualExecutionPlan(task.executionPlan, input, {
      now,
      roleId,
      kind,
    })

    this.taskLedgerHelper.updateTask(
      executionId,
      task.id,
      (currentTask) => ({
        ...currentTask,
        executionPlan: nextPlan,
        updatedAt: now,
      }),
      false
    )
    const planChange = this.planLedgerHelper.buildPlanChangePayload(previousPlan, nextPlan)
    this.store.appendEvent(executionId, {
      kind: 'plan-updated',
      severity: !isEmpty(planChange.removedStepIds) ? 'warning' : 'info',
      title: '执行计划已更新',
      message: input.explanation ?? `当前计划包含 ${nextPlan.length} 个步骤。`,
      taskId: task.id,
      planStepId: null,
      payload: planChange,
    })
    this.log.debug('execution plan updated', {
      executionId,
      taskId: task.id,
      explanation: (toNullable(input.explanation)),
      stepCount: nextPlan.length,
    })
    this.store.emitDebug(executionId)

    return this.getCurrentPlan(executionId)
  }

  /** 按 source session 找最近的指定状态 execution。 */
  public findLatestBySourceSession(
    sourceSessionId: string,
    statuses: Array<ExecutionRecord['status']>
  ): Nullable<ExecutionRecord> {
    return this.store.findLatestBySourceSession(sourceSessionId, statuses)
  }

  /** 生成 execution id；进程内 counter 只用于同毫秒内去重。 */
  private generateExecutionId(): string {
    return this.idFactory.createExecutionId()
  }

  /** 生成 task id；进程内 counter 只用于同毫秒内去重。 */
  private generateTaskId(): string {
    return this.idFactory.createTaskId()
  }

  /** 原子更新 execution record 的统一入口。 */
  private patchExecution(
    executionId: string,
    updater: (execution: ExecutionRecord) => ExecutionRecord
  ): ExecutionRecord {
    return this.store.updateExecution(executionId, updater)
  }

}

export { ExecutionRecords }
