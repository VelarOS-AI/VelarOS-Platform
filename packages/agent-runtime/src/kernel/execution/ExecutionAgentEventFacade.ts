import type { AgentEvent, ExecutionRecord, StreamTurnContextPayload } from '@velaros-ai/core/types'

import { chatStreamProtocol } from '../../chat/stream'
import {
  ExecutionAgentEventLedger,
  type ExecutionRecords,
  type ExecutionStore,
} from '../../execution'

import type { ExecutionAbortOptions } from './ExecutionStateFacade'

interface ExecutionAgentEventFacadeDependencies {
  records: ExecutionRecords
  store: ExecutionStore
  emitExecutionDebug: (executionId: string) => void
  getExecution: (executionId: string) => ExecutionRecord
  completeExecution: (executionId: string) => ExecutionRecord
  abortExecution: (
    executionId: string,
    reason: string,
    options?: ExecutionAbortOptions
  ) => ExecutionRecord
  failExecution: (executionId: string, error: string) => ExecutionRecord
}

class ExecutionAgentEventFacade {
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
