import type { ExecutionRecord, StreamStatePayload } from '../../types/agent.js'
import type { ExecutionAbortOptions } from '../../types/execution.js'
import { chatRuntimeEvents } from '../records/ChatRuntimeEvents'
import type { ExecutionInteractions } from '../records/ExecutionInteractions'
import type { ExecutionRecords } from '../records/ExecutionRecords'

/**
 * 执行终态的唯一落点：completed / aborted / failed 三条流转，以及它们各自要做的清理副作用。
 *
 * 由 `ExecutionService` 持有一份。三条路径的共同约定：先按状态机流转记录，再同步当前 task 的终态，
 * 清掉 awaiting_confirmation / awaiting_input（否则重启后会看到一个永远在等用户的执行），最后发 debug 事件。
 */
export interface ExecutionStateFacadeApi {
  /** 标记执行与当前 task 失败：错误原因同时写进记录、当前 task 和所有在等的交互（等待方以该原因 reject）。返回写完错误的记录。 */
  failExecution(executionId: string, error: string): ExecutionRecord
  /** 标记执行与当前 task 中止：清理同 fail，另外默认向 renderer 发一条 aborted 状态事件；已由别处发过事件时传 `emitStreamState: false` 避免重复。 */
  abortExecution(executionId: string, reason: string, options?: ExecutionAbortOptions): ExecutionRecord
  /** 正常完成执行与 root task，并清掉 awaiting 状态。只有仍在 running 的执行才该走到这里，终态改写由调用方先行拦住。 */
  completeExecution(executionId: string): ExecutionRecord
}

class ExecutionStateFacade implements ExecutionStateFacadeApi {
  constructor(
    private readonly records: ExecutionRecords,
    private readonly interactions: ExecutionInteractions,
    private readonly emitExecutionDebug: (executionId: string) => void,
    private readonly emitExecutionState: (executionId: string, payload: StreamStatePayload) => void
  ) {}

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
      this.emitExecutionState(executionId, chatRuntimeEvents.aborted(reason, executionId))
    }
    return abortedExecution
  }

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
