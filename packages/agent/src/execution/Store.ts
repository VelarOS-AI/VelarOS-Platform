import { existsSync, readFileSync, renameSync } from 'node:fs'

import type {
  ExecutionEventRecord,
  ExecutionPlanView,
  ExecutionRecord,
  ExecutionTaskExecutionAdvice,
  ExecutionTaskPlanStepStatus,
  ExecutionTaskRecord,
  StreamExecutionGraphPayload,
  StreamStatePayload,
} from '@velaros-ai/agent/protocol'
import { isArray, isEmpty, isFiniteNumber,isNull, isObject, isPlainObject,isPresent, isString, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { compareStableStrings } from '../agent/context/residency/determinism'

type ExecutionStateListener = (payload: StreamStatePayload) => void
type ExecutionDebugListener = (payload: StreamExecutionGraphPayload) => void

type AppendExecutionEventInput = Omit<ExecutionEventRecord, 'id' | 'executionId' | 'timestamp'> & {
  /** 允许调用方传入事件时间；不传则使用 store.now()。 */
  timestamp?: number
}

const DEFAULT_EXECUTION_EVENT_RETENTION_LIMIT = 500
const DEFAULT_EXECUTION_RECORD_RETENTION_LIMIT = 200
const PERSISTED_EXECUTION_STORE_VERSION = 1
const ExecutionStatuses = new Set<ExecutionRecord['status']>([
  'pending',
  'awaiting_confirmation',
  'running',
  'awaiting_input',
  'aborted',
  'completed',
  'failed',
])
const ExecutionTaskStatuses = new Set<ExecutionTaskRecord['status']>([
  'pending',
  'running',
  'awaiting_confirmation',
  'awaiting_input',
  'aborted',
  'completed',
  'failed',
])
const ExecutionEventSeverities = new Set<ExecutionEventRecord['severity']>([
  'info',
  'success',
  'warning',
  'error',
])

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

interface ExecutionStoreOptions {
  /** 是否将执行记录写入磁盘。 */
  persist?: boolean
  /** 自定义持久化文件路径，测试可覆盖。 */
  persistencePath?: string
  /** 启动时是否把未完成执行恢复为 aborted。 */
  recoverInterruptedExecutions?: boolean
  /** 可注入时间函数，方便测试稳定 id/timestamp。 */
  now?: () => number
  /** 每个 execution 最多保留的事件数；超出后保留最新事件。 */
  eventRetentionLimit?: number
  /** 最多保留的终态 execution 数；非终态记录永远保留。 */
  recordRetentionLimit?: number
}

interface PersistedExecutionStoreFile {
  version: 1
  savedAt: number
  executions: ExecutionRecord[]
}

/**
 * 执行记录存储。
 *
 * 这是 ExecutionRecord 的内存源和可选磁盘持久化层。
 * 它还保存 executionId 级别的 state/debug listener，让领域层不直接依赖 renderer。
 */
class ExecutionStore {
  private readonly persistThrottleMs = 250

  /** executionId -> record。 */
  private readonly executions = new Map<string, ExecutionRecord>()
  /** executionId -> state stream listener。 */
  private readonly executionStateListeners = new Map<string, ExecutionStateListener>()
  /** executionId -> debug graph listener。 */
  private readonly executionDebugListeners = new Map<string, ExecutionDebugListener>()
  /** 把 ExecutionRecord 转成 renderer 调试图 payload。 */
  private readonly debugPayloadBuilder = new ExecDebugPayload()
  /** persist=false 时为空。 */
  private readonly persistencePath: Nullable<string>
  /** 当前时间函数。 */
  private readonly now: () => number
  /** 每个 execution 内存与持久化事件保留上限。 */
  private readonly eventRetentionLimit: number
  /** 内存与持久化中最多保留的终态 execution 记录数。 */
  private readonly recordRetentionLimit: number
  /** 节流写盘的定时器；存在表示有挂起的 persist 任务。 */
  private pendingPersistTimer: Nullable<TimerLease> = null
  /** 存储级 timer 作用域，用于托管节流持久化任务。 */
  private readonly timers = new TimerScope({ name: 'ExecutionStore' })
  /** 当前在途写盘任务，用于 disposeAsync flush。 */
  private persistPromise: Nullable<Promise<void>> = null
  /** 写盘任务运行期间又发生变更时置脏，当前 writer 结束后立即写最新快照。 */
  private persistDirty = false
  /** 标记是否已 dispose；dispose 之后拒绝再排新的 persist 任务。 */
  private disposed = false
  private readonly log = logRuntime.tag('ExecutionStore')
  private executionEventCounter = 0

  constructor(options: ExecutionStoreOptions = {}) {
    if (options.persist && !options.persistencePath) {
      throw new Error('ExecutionStore persistencePath is required when persist is enabled.')
    }
    this.persistencePath = options.persist ? options.persistencePath! : null
    this.now = options.now ?? Date.now
    this.eventRetentionLimit = this.resolveEventRetentionLimit(options.eventRetentionLimit)
    this.recordRetentionLimit = this.resolveRecordRetentionLimit(options.recordRetentionLimit)

    if (this.persistencePath) {
      // 先加载历史记录，再把未完成记录统一恢复成 aborted。
      this.loadPersistedExecutions()
      if (options.recoverInterruptedExecutions ?? true) {
        this.recoverInterruptedExecutions()
      }
    }
  }

  /** 保存完整执行记录。 */
  public save(execution: ExecutionRecord): void {
    this.executions.set(execution.id, this.trimExecutionEvents(execution))
    this.pruneRetainedExecutionRecords()
    this.schedulePersist()
  }

  /** 可空读取执行记录。 */
  public get(executionId: string): Nullable<ExecutionRecord> {
    return toNullable(this.executions.get(executionId))
  }

  /** 必须存在的读取，不存在时抛错。 */
  public require(executionId: string): ExecutionRecord {
    const execution = this.executions.get(executionId)
    if (!execution) {
      throw new AppError('NOT_FOUND', `Execution not found: ${executionId}`, undefined, {
        executionId,
        operation: 'requireExecution',
      })
    }

    return execution
  }

  /** 注册 state listener。 */
  public setStateListener(executionId: string, listener: ExecutionStateListener): void {
    this.executionStateListeners.set(executionId, listener)
  }

  /** 清理 state listener。 */
  public clearStateListener(executionId: string): void {
    this.executionStateListeners.delete(executionId)
  }

  /** 注册 debug listener。 */
  public setDebugListener(executionId: string, listener: ExecutionDebugListener): void {
    this.executionDebugListeners.set(executionId, listener)
  }

  /** 清理 debug listener。 */
  public clearDebugListener(executionId: string): void {
    this.executionDebugListeners.delete(executionId)
  }

  /** 发送 state payload。 */
  public emitState(executionId: string, payload: StreamStatePayload): void {
    this.executionStateListeners.get(executionId)?.(payload)
  }

  /** 构建并发送最新 debug graph。 */
  public emitDebug(executionId: string): void {
    const execution = this.require(executionId)
    this.executionDebugListeners.get(executionId)?.(this.debugPayloadBuilder.build(execution))
  }

  /** 追加执行事件，并返回补齐 id/timestamp 后的事件记录。 */
  public appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord {
    this.executionEventCounter += 1
    const event: ExecutionEventRecord = {
      id: `execution-event-${this.now()}-${this.executionEventCounter}`,
      executionId,
      timestamp: input.timestamp ?? this.now(),
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      message: input.message,
      taskId: input.taskId,
      planStepId: input.planStepId,
      payload: input.payload,
    }

    this.updateExecution(executionId, (execution) => ({
      ...execution,
      events: [...execution.events, event],
    }))

    return event
  }

  /** 原子更新 execution record 并持久化。 */
  public updateExecution(
    executionId: string,
    updater: (execution: ExecutionRecord) => ExecutionRecord
  ): ExecutionRecord {
    const nextExecution = this.trimExecutionEvents(updater(this.require(executionId)))
    this.executions.set(executionId, nextExecution)
    this.pruneRetainedExecutionRecords()
    this.schedulePersist()
    return nextExecution
  }

  /** 更新指定 task；task 缺失说明执行账本已损坏，直接抛错。 */
  public updateTask(
    executionId: string,
    taskId: string,
    updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord
  ): ExecutionRecord {
    return this.updateExecution(executionId, (execution) => {
      const taskIndex = execution.tasks.findIndex((task) => task.id === taskId)
      if (taskIndex < 0) {
        throw new AppError('INVARIANT', `Execution task not found: ${executionId}/${taskId}`, undefined, {
          executionId,
          taskId,
          operation: 'updateTask',
        })
      }

      const tasks = [...execution.tasks]
      tasks[taskIndex] = updater(tasks[taskIndex]!)
      return {
        ...execution,
        tasks,
        updatedAt: Date.now(),
      }
    })
  }

  /** 按 source session 和状态集合找最近更新的 execution。 */
  public findLatestBySourceSession(
    sourceSessionId: string,
    statuses: Array<ExecutionRecord['status']>
  ): Nullable<ExecutionRecord> {
    return (
      toNullable([...this.executions.values()]
        .filter(
          (record) =>
            record.sourceSessionId === sourceSessionId &&
            statuses.includes(record.status)
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)[0])
    )
  }

  /** 从磁盘恢复 execution records；文件损坏时清空内存记录，避免启动失败。 */
  private loadPersistedExecutions(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return

    try {
      const raw = readFileSync(this.persistencePath, 'utf-8').trim()
      if (!raw) return

      const parsed = JSON.parse(raw) as unknown
      if (!this.isPersistedExecutionStoreFile(parsed)) return

      let changed = false

      parsed.executions
        .filter((execution): execution is ExecutionRecord => this.isExecutionRecord(execution))
        .forEach((execution) => {
          const trimmedExecution = this.trimExecutionEvents(execution)
          if (trimmedExecution.events.length !== execution.events.length) {
            changed = true
          }
          this.executions.set(execution.id, trimmedExecution)
        })

      if (this.pruneRetainedExecutionRecords()) {
        changed = true
      }

      if (changed) {
        this.schedulePersist()
      }
    } catch (error) {
      try {
        const quarantinePath = this.quarantineUnreadablePersistenceFile()
        if (quarantinePath) {
          this.log.warn('读取已持久化执行记录失败，已隔离损坏文件并清空内存记录', {
            error,
            quarantinePath,
          })
        } else {
          this.log.warn('读取已持久化执行记录失败，清空内存记录', { error })
        }
      } catch (quarantineError) {
        this.log.warn('读取已持久化执行记录失败，隔离损坏文件失败并清空内存记录', {
          error,
          quarantineError,
        })
      }
      this.executions.clear()
    }
  }

  private quarantineUnreadablePersistenceFile(): Nullable<string> {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return null

    const quarantinePath = this.resolvePersistenceQuarantinePath()
    renameSync(this.persistencePath, quarantinePath)
    return quarantinePath
  }

  private resolvePersistenceQuarantinePath(): string {
    const basePath = `${this.persistencePath}.corrupt-${this.now()}`
    if (!existsSync(basePath)) return basePath

    for (let index = 1; index <= 100; index += 1) {
      const candidate = `${basePath}-${index}`
      if (!existsSync(candidate)) return candidate
    }

    return `${basePath}-${Math.random().toString(36).slice(2, 8)}`
  }

  /** 应用重启后，任何未进入终态的执行都标记为 aborted。 */
  private recoverInterruptedExecutions(): void {
    let changed = false
    for (const execution of [...this.executions.values()]) {
      if (this.isTerminalStatus(execution.status)) {
        continue
      }

      this.executions.set(execution.id, this.markExecutionInterrupted(execution))
      changed = true
    }

    if (this.pruneRetainedExecutionRecords()) {
      changed = true
    }

    if (changed) {
      this.schedulePersist()
    }
  }

  /** 把单条未完成 execution 改写成 interrupted/aborted 形态。 */
  private markExecutionInterrupted(execution: ExecutionRecord): ExecutionRecord {
    const now = this.now()
    const message = '应用重启后，上一轮未结束的执行已标记为中断。'
    return this.trimExecutionEvents({
      ...execution,
      status: 'aborted',
      awaitingConfirmation: null,
      awaitingInput: null,
      error: message,
      updatedAt: now,
      tasks: execution.tasks.map((task) =>
        !this.isTerminalTaskStatus(task.status)
          ? {
              ...task,
              status: 'aborted',
              executionPlan: task.executionPlan.map((step) =>
                step.status === 'running' || step.status === 'delegated'
                  ? {
                      ...step,
                      status: 'failed',
                      updatedAt: now,
                    }
                  : step
              ),
              error: message,
              completedAt: now,
              updatedAt: now,
            }
          : task
      ),
      events: [...execution.events, this.createRecoveryEvent(execution, message, now)],
    })
  }

  /** 为恢复中断执行创建一条 warning 事件。 */
  private createRecoveryEvent(
    execution: ExecutionRecord,
    message: string,
    timestamp: number
  ): ExecutionEventRecord {
    this.executionEventCounter += 1
    return {
      id: `execution-event-${timestamp}-${this.executionEventCounter}`,
      executionId: execution.id,
      timestamp,
      kind: 'execution-status-changed',
      severity: 'warning',
      title: '执行已从持久化记录恢复',
      message: `${execution.status} -> aborted`,
      taskId: execution.currentTaskId,
      planStepId: null,
      payload: {
        previousStatus: execution.status,
        status: 'aborted',
        reason: message,
      },
    }
  }

  /**
   * 节流持久化：合并 persistThrottleMs 内的多次变更只写一次磁盘。
   *
   * 高频路径（appendEvent / updateTask）每次都触发同步写入会成为热点；
   * 这里改为合并写入并通过共享原子写 helper 保护磁盘内容完整性。
   * disposeAsync 会 await 在途的 persistPromise，保证退出前数据落盘。
   */
  public schedulePersist(): void {
    if (!this.persistencePath || this.disposed) return

    if (this.pendingPersistTimer) return

    this.pendingPersistTimer = this.timers.after(this.persistThrottleMs, () => {
      this.pendingPersistTimer = null
      this.requestPersistFlush('failed to persist executions')
    }, { unref: true })
  }

  /**
   * 立刻把节流缓冲里的 persist flush 到磁盘并等待完成。
   *
   * 退出前必须 await：否则 250ms 定时器还没触发，磁盘上可能丢最后几条事件。
   */
  public async disposeAsync(): Promise<void> {
    this.disposed = true
    if (this.pendingPersistTimer) {
      this.pendingPersistTimer.cancel()
      this.pendingPersistTimer = null
      // 节流期间已积累变更，需要在退出前立即写一次。
      this.requestPersistFlush('failed to flush executions on dispose')
    }

    if (this.persistPromise) {
      await this.persistPromise
      this.persistPromise = null
    }
    this.timers.dispose()
  }

  private requestPersistFlush(errorMessage: string): void {
    this.persistDirty = true
    if (this.persistPromise) return

    this.persistPromise = this.flushPersistQueue(errorMessage).finally(() => {
      this.persistPromise = null
    })
  }

  private async flushPersistQueue(errorMessage: string): Promise<void> {
    while (this.persistDirty) {
      this.persistDirty = false
      try {
        await this.persistExecutions()
      } catch (error) {
        // 持久化失败不应阻塞进程，但要让运维通过日志感知。
        this.log.warn(errorMessage, { error })
      }
    }
  }

  /** 真正的磁盘写入：通过共享 helper 做原子落盘。 */
  private async persistExecutions(): Promise<void> {
    if (!this.persistencePath) return

    this.pruneRetainedExecutionRecords()
    const payload: PersistedExecutionStoreFile = {
      version: 1,
      savedAt: this.now(),
      executions: [...this.executions.values()].map((execution) =>
        this.trimExecutionEvents(execution)
      ),
    }
    await writeJsonFileAtomically(this.persistencePath, payload, { space: 2, trailingNewline: true })
  }

  private trimExecutionEvents(execution: ExecutionRecord): ExecutionRecord {
    const events = this.trimEvents(execution.events)
    if (events === execution.events) return execution

    return {
      ...execution,
      events,
    }
  }

  private trimEvents(events: ExecutionEventRecord[]): ExecutionEventRecord[] {
    if (events.length <= this.eventRetentionLimit) return events

    return events.slice(-this.eventRetentionLimit)
  }

  private resolveEventRetentionLimit(limit: Optional<number>): number {
    if (!isPresent(limit)) return DEFAULT_EXECUTION_EVENT_RETENTION_LIMIT
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error('ExecutionStore eventRetentionLimit must be a positive number.')
    }

    return Math.floor(limit)
  }

  private resolveRecordRetentionLimit(limit: Optional<number>): number {
    if (!isPresent(limit)) return DEFAULT_EXECUTION_RECORD_RETENTION_LIMIT
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error('ExecutionStore recordRetentionLimit must be a positive number.')
    }

    return Math.floor(limit)
  }

  /**
   * 只裁剪终态 execution：running / awaiting_* / pending 仍可能被 UI 或交互恢复路径读取。
   */
  private pruneRetainedExecutionRecords(): boolean {
    const terminalExecutions = [...this.executions.values()].filter((execution) =>
      this.isTerminalStatus(execution.status)
    )
    if (terminalExecutions.length <= this.recordRetentionLimit) return false

    const retainedTerminalIds = new Set(
      terminalExecutions
        .sort((left, right) => {
          const updatedAtDelta = right.updatedAt - left.updatedAt
          if (updatedAtDelta !== 0) return updatedAtDelta

          const createdAtDelta = right.createdAt - left.createdAt
          if (createdAtDelta !== 0) return createdAtDelta

          return compareStableStrings(right.id, left.id)
        })
        .slice(0, this.recordRetentionLimit)
        .map((execution) => execution.id)
    )

    let changed = false
    for (const execution of terminalExecutions) {
      if (retainedTerminalIds.has(execution.id)) continue

      this.executions.delete(execution.id)
      this.executionStateListeners.delete(execution.id)
      this.executionDebugListeners.delete(execution.id)
      changed = true
    }

    return changed
  }

  private isPersistedExecutionStoreFile(value: unknown): value is PersistedExecutionStoreFile {
    if (!isPlainObject(value)) return false
    const record = value
    return (
      record.version === PERSISTED_EXECUTION_STORE_VERSION &&
      this.isFiniteNumber(record.savedAt) &&
      isArray(record.executions)
    )
  }

  /** 校验持久化对象是否能安全进入恢复和调试图投影。 */
  private isExecutionRecord(value: unknown): value is ExecutionRecord {
    if (!isPlainObject(value)) return false
    const record = value
    const executionId = record.id
    const currentTaskId = record.currentTaskId
    if (
      !isString(executionId) ||
      !isString(record.sourceSessionId) ||
      !this.isExecutionStatus(record.status) ||
      !isString(record.summary) ||
      !this.isNullableString(record.resourceId) ||
      !this.isFiniteNumber(record.createdAt) ||
      !this.isFiniteNumber(record.updatedAt) ||
      !isString(currentTaskId) ||
      !isArray(record.tasks) ||
      isEmpty(record.tasks) ||
      !isArray(record.events)
    ) return false

    const tasks = record.tasks
    if (!tasks.every((task) => this.isExecutionTaskRecord(task))) return false
    if (!tasks.some((task) => task.id === currentTaskId)) return false

    return record.events.every((event) => this.isExecutionEventRecord(event, executionId))
  }

  private isExecutionTaskRecord(value: unknown): value is ExecutionTaskRecord {
    if (!isPlainObject(value)) return false
    const task = value
    return (
      isString(task.id) &&
      (task.kind === 'root' || task.kind === 'delegated') &&
      isString(task.title) &&
      isString(task.instruction) &&
      isArray(task.executionPlan) &&
      this.isExecutionTaskStatus(task.status) &&
      this.isFiniteNumber(task.createdAt) &&
      this.isFiniteNumber(task.updatedAt) &&
      (isNull(task.startedAt) || this.isFiniteNumber(task.startedAt)) &&
      (isNull(task.completedAt) || this.isFiniteNumber(task.completedAt)) &&
      this.isNullableString(task.result) &&
      this.isNullableString(task.error)
    )
  }

  private isExecutionEventRecord(
    value: unknown,
    executionId: string
  ): value is ExecutionEventRecord {
    if (!isPlainObject(value)) return false
    const event = value
    return (
      isString(event.id) &&
      event.executionId === executionId &&
      isString(event.kind) &&
      this.isExecutionEventSeverity(event.severity) &&
      isString(event.title) &&
      isString(event.message) &&
      this.isFiniteNumber(event.timestamp) &&
      this.isNullableString(event.taskId) &&
      this.isNullableString(event.planStepId) &&
      isObject(event.payload)
    )
  }

  private isExecutionStatus(value: unknown): value is ExecutionRecord['status'] {
    return isString(value) && ExecutionStatuses.has(value as ExecutionRecord['status'])
  }

  private isExecutionTaskStatus(value: unknown): value is ExecutionTaskRecord['status'] {
    return isString(value) && ExecutionTaskStatuses.has(value as ExecutionTaskRecord['status'])
  }

  private isExecutionEventSeverity(value: unknown): value is ExecutionEventRecord['severity'] {
    return isString(value) && ExecutionEventSeverities.has(value as ExecutionEventRecord['severity'])
  }

  private isNullableString(value: unknown): value is Nullable<string> {
    return isNull(value) || isString(value)
  }

  private isFiniteNumber(value: unknown): value is number {
    return isFiniteNumber(value)
  }

  /** execution 终态判断。 */
  private isTerminalStatus(status: ExecutionRecord['status']): boolean {
    return status === 'aborted' || status === 'completed' || status === 'failed'
  }

  /** task 终态判断。 */
  private isTerminalTaskStatus(status: ExecutionTaskRecord['status']): boolean {
    return status === 'aborted' || status === 'completed' || status === 'failed'
  }
}

export {
  ExecDebugPayload,
  ExecDebugPayload as ExecutionDebugPayloadBuilder,
  ExecutionStore,
}
export type { AppendExecutionEventInput, ExecutionStoreOptions }
