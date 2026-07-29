import type { ExecutionRecord, StreamStatePayload } from '@velaros-ai/core/types'
import { ChatRuntimeEvents } from '@velaros-ai/core/types'

import type { ExecutionInteractions, ExecutionRecords } from '../../execution'

interface ExecutionAbortOptions {
  emitStreamState?: boolean
}

/** 负责终态执行状态流转（completed/aborted/failed）及相关清理副作用。 */
class ExecutionStateFacade {
  constructor(
    private readonly records: ExecutionRecords,
    private readonly interactions: ExecutionInteractions,
    private readonly emitExecutionDebug: (executionId: string) => void,
    private readonly emitExecutionState: (executionId: string, payload: StreamStatePayload) => void
  ) {}

  /** 标记 execution + 当前 task 失败，清理 pending 交互并 emit debug。 */
  public failExecution(executionId: string, error: string): ExecutionRecord {
    const transitionedExecution = this.records.transition(executionId, 'failed')
    this.records.failTask(transitionedExecution.id, transitionedExecution.currentTaskId, error)
    this.interactions.failPending(executionId, error)
    this.records.clearAwaitingConfirmation(executionId)
    this.records.clearAwaitingInput(executionId)
    const failedExecution = this.records.setExecutionError(executionId, error)
    this.emitExecutionDebug(executionId)
    return failedExecution
  }

  /** 标记 execution + 当前 task 中止，emit aborted 状态事件。 */
  public abortExecution(
    executionId: string,
    reason: string,
    options: ExecutionAbortOptions = {}
  ): ExecutionRecord {
    const transitionedExecution = this.records.transition(executionId, 'aborted')
    this.records.abortTask(transitionedExecution.id, transitionedExecution.currentTaskId, reason)

    this.interactions.failPending(executionId, reason)
    this.records.clearAwaitingConfirmation(executionId)
    this.records.clearAwaitingInput(executionId)
    const abortedExecution = this.records.setExecutionError(executionId, reason)
    this.emitExecutionDebug(executionId)
    if (options.emitStreamState ?? true) {
      this.emitExecutionState(executionId, ChatRuntimeEvents.aborted(reason, executionId))
    }
    return abortedExecution
  }

  /** 正常完成 execution + root task，清理 awaiting 状态。 */
  public completeExecution(executionId: string): ExecutionRecord {
    const transitionedExecution = this.records.transition(executionId, 'completed')
    this.records.completeTask(transitionedExecution.id, transitionedExecution.currentTaskId)

    this.records.clearAwaitingConfirmation(executionId)
    const completedExecution = this.records.clearAwaitingInput(executionId)
    this.emitExecutionDebug(executionId)
    return completedExecution
  }
}

export { ExecutionStateFacade }
export type { ExecutionAbortOptions }
