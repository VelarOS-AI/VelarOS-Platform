import type { ModelMessage } from 'ai'

import type {
  ExecutionRecord,
  ExecutionTaskPlanStep,
  ExecutionTaskRecord,
  StreamTurnContextPayload,
  ToolExecutionPlanUpdate,
  UserActionCard,
} from '@velaros-ai/agent/protocol'
import { isArray, isBlank, isEmpty,isObject, isPresent, isString, toNullable, truncate } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  type ExecutionIdFactory,
  MonotonicExecutionIdFactory,
} from './ExecutionIdFactory'
import { ExecutionPlanLedgerHelper } from './plan-ledger'
import { type ExecutionRoutingCoordinator } from './routing'
import { type ExecutionStateMachine } from './state-machine'
import { type ExecutionStore } from './Store'
import {
  ExecutionRecordSeverityHelper,
  ExecutionTaskLedgerHelper,
} from './task-ledger'

interface ExecutionResourceProvider {
  getActiveResourceId: (sessionId: string) => Nullable<string>
}

interface CreateExecutionArgs {
  /** 宿主来源会话 id（member=session）。 */
  sourceSessionId: string
  /** 创建执行摘要时使用的原始消息。 */
  messages: ModelMessage[]
}

/** 从模型消息序列提取最近一条用户消息作为 execution summary。 */
class ExecutionRecordSummaryHelper {
  public buildExecutionSummary(messages: ModelMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user') {
        continue
      }

      if (isString(message.content)) return truncate(message.content.trim(), 80) || '执行任务'

      if (!isArray(message.content)) {
        continue
      }

      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => {
          if (!isObject(part) || !isPresent(part)) return false
          const record = part as { type?: unknown; text?: unknown }
          return record.type === 'text' && isString(record.text)
        })
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim()

      if (!isBlank(text)) return truncate(text, 80)
    }

    return '执行任务'
  }
}

/**
 * 执行记录管理器。
 *
 * ExecutionService 负责生命周期编排；本类负责具体修改 ExecutionRecord：
 * - 创建 execution/root task。
 * - 执行状态转移。
 * - 创建/启动/完成/失败任务。
 * - 更新角色和执行计划。
 * - 写入事件 ledger 并触发 debug 刷新。
 */
class ExecutionRecords {
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
    private readonly store: ExecutionStore,
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
    userActionCards?: UserActionCard[]
  ): ExecutionRecord {
    return this.patchExecution(executionId, (current) => ({
      ...current,
      awaitingConfirmation: {
        message,
        askedAt: Date.now(),
        userActionCards,
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
    this.requireCurrentTask(execution, 'update role')
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
    const task = this.requireCurrentTask(execution, 'read current plan')
    return task.executionPlan
  }

  /** 用工具传入的计划更新当前任务执行计划，并写入 plan-updated 事件。 */
  public updateCurrentPlan(executionId: string, input: ToolExecutionPlanUpdate): ExecutionTaskPlanStep[] {
    const execution = this.getExecution(executionId)
    const task = this.requireCurrentTask(execution, 'update current plan')

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

  /** currentTaskId 必须指向现存 task；否则执行账本已损坏，抛出可诊断的领域错误。 */
  private requireCurrentTask(
    execution: ExecutionRecord,
    operation: string
  ): ExecutionTaskRecord {
    const currentTaskId = execution.currentTaskId
    const task = execution.tasks.find((item) => item.id === currentTaskId)
    if (task) return task

    throw new AppError(
      'INVARIANT',
      `Execution current task not found: ${execution.id}/${currentTaskId}`,
      undefined,
      {
        executionId: execution.id,
        currentTaskId,
        operation,
      }
    )
  }
}

export { ExecutionRecords, ExecutionRecordSummaryHelper }
export type { ExecutionResourceProvider }
export { ExecutionRecordSummaryHelper as ExecRecordSummary }
