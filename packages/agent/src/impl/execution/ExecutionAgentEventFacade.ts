import type { AgentEvent, ExecutionRecord, StreamTurnContextPayload } from '../../types/agent'
import type { ExecutionAbortOptions } from '../../types/execution.js'
import { chatStreamProtocol } from '../chat/ChatStreamProtocol'
import { ExecutionAgentEventLedger } from '../records/ExecAgentEvents'
import type { ExecutionRecords } from '../records/ExecutionRecords'
import type { ExecutionStoreApi } from '../records/ExecutionStore'

/**
 * `ExecutionAgentEventFacade` 的注入面，由 `ExecutionService` 在构造时填齐。
 * 四个终态流转一律回调服务本身而不是直接改记录：终态的唯一落点在 `ExecutionStateFacade`，这里只负责判定「该收尾了」。
 */
interface ExecutionAgentEventFacadeDependencies {
  /** 执行记录的高层读写口：本件用它按 sourceSession 找最近一次执行，并把 turn-context 里的角色同步进记录。 */
  records: ExecutionRecords
  /** 执行记录存储；交给事件账本，让每条 agent 事件先落进调试时间线。 */
  store: ExecutionStoreApi
  /** 通知「这条执行的调试快照变了」，由服务重建 debug payload 发给 renderer。账本每写一条事件就调一次。 */
  emitExecutionDebug: (executionId: string) => void
  /** 读一条执行记录的当前状态；收到完成类事件时先读它，确认还在 running 才真的收尾。 */
  getExecution: (executionId: string) => ExecutionRecord
  /** 把执行标记为完成。只在流已给出完成信号、且记录仍是 running 时调用。 */
  completeExecution: (executionId: string) => ExecutionRecord
  /** 把执行标记为中止，`reason` 取自 agent 的 aborted 事件。本件调用时一律 `emitStreamState: false`——状态事件流里已经有那条 aborted 了，再发一次会重复。 */
  abortExecution: (
    executionId: string,
    reason: string,
    options?: ExecutionAbortOptions
  ) => ExecutionRecord
  /** 把执行标记为失败，`error` 取自 agent 的 error 事件原文。 */
  failExecution: (executionId: string, error: string) => ExecutionRecord
}

/**
 * agent 事件到执行记录的单向桥：每条事件先进调试账本，再按事件类型决定要不要改执行状态。
 *
 * 两类事件有副作用：`turn-context` 缓存本轮真正送进模型的上下文并同步角色；runtime 的终态事件按协议
 * 映射成 complete / abort / fail 三条流转之一。其余事件只进账本。由 `ExecutionService` 持有一份。
 */
export interface ExecutionAgentEventFacadeApi {
  /**
   * 取某个会话最近一次真实送入模型的轮次上下文（连同那条执行记录），供外部 supervisor 调试用。
   * 只认本进程内缓存过的那一份：执行早于本次进程、或那一轮没发过 turn-context，都返回 null。
   */
  getLatestTurnContextForSourceSession(sourceSessionId: string): Nullable<{ execution: ExecutionRecord; turnContext: StreamTurnContextPayload }>
  /** 吃进一条 agent 事件：先写账本，再按类型决定副作用。终态映射只在记录尚未终结时生效，不会把已中止/已失败的执行改写成完成。 */
  handleAgentEvent(executionId: string, event: AgentEvent): void
}

class ExecutionAgentEventFacade implements ExecutionAgentEventFacadeApi {
  private readonly latestTurnContextByExecutionId = new Map<string, StreamTurnContextPayload>()
  private readonly agentEventLedger: ExecutionAgentEventLedger

  constructor(private readonly dependencies: ExecutionAgentEventFacadeDependencies) {
    this.agentEventLedger = new ExecutionAgentEventLedger(
      dependencies.store,
      (executionId) => dependencies.emitExecutionDebug(executionId)
    )
  }

  public getLatestTurnContextForSourceSession(
    sourceSessionId: string
  ): Nullable<{ execution: ExecutionRecord; turnContext: StreamTurnContextPayload }> {
    const execution = this.dependencies.records.findLatestBySourceSession(sourceSessionId, [
      'running',
      'awaiting_confirmation',
      'awaiting_input',
      'completed',
      'failed',
      'aborted',
    ])
    if (!execution) return null

    const turnContext = this.latestTurnContextByExecutionId.get(execution.id)
    return turnContext ? { execution, turnContext } : null
  }

  public handleAgentEvent(executionId: string, event: AgentEvent): void {
    this.agentEventLedger.appendAgentEvent(executionId, event)

    if (event.type === 'turn-context') {
      this.latestTurnContextByExecutionId.set(executionId, event.payload)
      this.dependencies.records.updateRole(executionId, event.payload)
      return
    }

    const terminalKind = chatStreamProtocol.readTerminalKindFromAgent(event)
    if (!terminalKind || event.type !== 'runtime') return

    switch (chatStreamProtocol.resolveExecutionAction(terminalKind)) {
      case 'complete': {
        const execution = this.dependencies.getExecution(executionId)
        if (execution.status === 'running') {
          this.dependencies.completeExecution(executionId)
        }
        return
      }
      case 'abort':
        if (event.payload.kind === 'aborted') {
          this.dependencies.abortExecution(executionId, event.payload.message, {
            emitStreamState: false,
          })
        }
        return
      case 'fail':
        if (event.payload.kind === 'error') {
          this.dependencies.failExecution(executionId, event.payload.message)
        }
        return
    }
  }
}

export { ExecutionAgentEventFacade }
export type { ExecutionAgentEventFacadeDependencies }
