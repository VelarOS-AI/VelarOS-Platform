import { existsSync, readFileSync, renameSync } from 'node:fs'

import { toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'
import { writeJsonFileAtomically } from '@velaros-ai/core/utils/FilePersistence'
import { type TimerLease, TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ExecutionEventRecord, ExecutionRecord, ExecutionTaskRecord, StreamStatePayload } from '../../types/agent.js'
import type { AppendExecutionEventInput, ExecutionDebugListener, ExecutionStateListener, ExecutionStoreOptions, PersistedExecutionStoreFile } from '../../types/records.js'
import { isExecutionRecord, isPersistedExecutionStoreFile, isTerminalExecutionStatus, isTerminalExecutionTaskStatus, resolveExecutionEventRetentionLimit, resolveExecutionRecordRetentionLimit } from '../../utils/records/execution-store-validation'
import { compareStableStrings } from '../../utils/residency/determinism'
import { AgentTuning } from '../../utils/tuning'

import { ExecDebugPayload } from './ExecDebugPayload'



/**
 * 执行记录的存放处：内存里一张 `executionId → ExecutionRecord` 的表，外加可选的磁盘持久化。
 * 同时替领域层保管每个执行的 state / debug 监听器，让领域层不必认识 renderer。
 *
 * 写盘是节流的（250ms 内的多次改动合成一次原子写），所以进程退出前必须 `await disposeAsync()`，否则最后几条事件会丢。
 * 每条执行的事件超过上限就从最旧的开始丢，终态执行的条数也有上限（running / awaiting_* / pending 永远不裁，界面还要读）。
 * 持久化文件读坏时隔离成 `.corrupt-*` 并清空内存表，不让启动失败。实现是 `ExecutionStore`。
 */
export interface ExecutionStoreApi {
  /** 整条覆盖保存一条执行记录：顺带裁掉超限事件、裁掉多余的终态记录，并排一次节流写盘。 */
  save(execution: ExecutionRecord): void
  /** 按 id 取执行记录，没有就返回 null。 */
  get(executionId: string): Nullable<ExecutionRecord>
  /** 按 id 取执行记录，没有就抛 `NOT_FOUND`。调用方确定它该存在时用这个，省掉判空。 */
  require(executionId: string): ExecutionRecord
  /** 登记这个执行的 state 监听器，界面据此收等待、完成等控制态；同一个 executionId 只留最后登记的那个。 */
  setStateListener(executionId: string, listener: ExecutionStateListener): void
  /** 注销这个执行的 state 监听器，界面断开时调。 */
  clearStateListener(executionId: string): void
  /** 登记这个执行的调试图监听器，只有调试面板打开时才有人登记。 */
  setDebugListener(executionId: string, listener: ExecutionDebugListener): void
  /** 注销这个执行的调试图监听器。 */
  clearDebugListener(executionId: string): void
  /** 把一条 state payload 发给这个执行的监听器；没人登记时静默丢弃。 */
  emitState(executionId: string, payload: StreamStatePayload): void
  /** 现算一份调试图快照发给这个执行的调试监听器；执行不存在时抛 `NOT_FOUND`，没人登记调试监听器时算白算一次。 */
  emitDebug(executionId: string): void
  /** 往执行的时间线追一条事件：这里补上 id 和 timestamp（`input.timestamp` 没给就取当前时刻），返回补齐后的完整记录。追加同时触发裁剪与节流写盘。 */
  appendEvent(executionId: string, input: AppendExecutionEventInput): ExecutionEventRecord
  /** 改一条执行记录的唯一入口：`updater` 拿到当前记录、返回新记录，落表前裁事件、裁终态记录，并排一次写盘。执行不存在时抛 `NOT_FOUND`。 */
  updateExecution(executionId: string, updater: (execution: ExecutionRecord) => ExecutionRecord): ExecutionRecord
  /** 改执行里的某一个任务，返回改完后的整条执行记录。任务不在记录里时抛 `INVARIANT`——那说明账本坏了，不是调用方传错。 */
  updateTask(executionId: string, taskId: string, updater: (task: ExecutionTaskRecord) => ExecutionTaskRecord): ExecutionRecord
  /** 在某个来源会话上，找状态落在 `statuses` 里、`updatedAt` 最新的那条执行；没有就返回 null。 */
  findLatestBySourceSession(sourceSessionId: string, statuses: Array<ExecutionRecord['status']>): Nullable<ExecutionRecord>
  /** 排一次节流写盘：250ms 内的多次改动只写一次。没开持久化、或已经 dispose 过时什么都不做。正常改动路径已经自动调它，外部一般不用直接调。 */
  schedulePersist(): void
  /** 收尾：取消待触发的节流定时器、立刻把积压的改动写完并等落盘，然后关掉定时器作用域。退出前必须 await，否则最后 250ms 内的事件会丢在内存里。 */
  disposeAsync(): Promise<void>
}

class ExecutionStore implements ExecutionStoreApi {
  /** 每条执行的事件保留条数缺省值。 */
  private static readonly DefaultEventRetentionLimit = AgentTuning.records.executionEventRetentionLimit
  /** 执行记录的保留条数缺省值。 */
  private static readonly DefaultRecordRetentionLimit = AgentTuning.records.executionRecordRetentionLimit
  /** 落盘文件的格式版本：版本不符的旧文件整份丢弃，不做迁移。 */
  private static readonly PersistedFileVersion = 1

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
      throw new Error('ExecutionStore 开了 persist 却没给 persistencePath：不知道往哪写盘，执行记录会在进程退出时全部丢失。要么补上 persistencePath，要么把 persist 关掉走纯内存模式。')
    }
    this.persistencePath = options.persist ? options.persistencePath! : null
    this.now = options.now ?? Date.now
    this.eventRetentionLimit = resolveExecutionEventRetentionLimit(options.eventRetentionLimit, ExecutionStore.DefaultEventRetentionLimit)
    this.recordRetentionLimit = resolveExecutionRecordRetentionLimit(options.recordRetentionLimit, ExecutionStore.DefaultRecordRetentionLimit)

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
      throw new AppError('NOT_FOUND', `找不到执行记录 ${executionId}：它可能已经被保留策略裁掉，也可能这个 id 根本不属于当前存储。`, undefined, {
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
        throw new AppError('INVARIANT', `执行 ${executionId} 里找不到任务 ${taskId}，无法更新它。任务 id 由本存储自己发放，找不到说明执行账本已经自相矛盾——这是实现缺陷，不是用户操作错误。`, undefined, {
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
      if (!isPersistedExecutionStoreFile(parsed, ExecutionStore.PersistedFileVersion)) return

      let changed = false

      parsed.executions
        .filter((execution): execution is ExecutionRecord => isExecutionRecord(execution))
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
      if (isTerminalExecutionStatus(execution.status)) {
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
        !isTerminalExecutionTaskStatus(task.status)
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

  /**
   * 只裁剪终态 execution：running / awaiting_* / pending 仍可能被 UI 或交互恢复路径读取。
   */
  private pruneRetainedExecutionRecords(): boolean {
    const terminalExecutions = [...this.executions.values()].filter((execution) =>
      isTerminalExecutionStatus(execution.status)
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

}

export { ExecutionStore }