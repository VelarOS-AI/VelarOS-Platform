import type { ModelMessage } from 'ai'

import type { StreamTurnEndPayload } from '@velaros-ai/agent/protocol'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import type { ScopedLog } from '@velaros-ai/core/logger'

import { createInternalFollowUpMessage } from './history'
import {
  markToolSpaceBootstrapDiscoverySatisfied,
  type ToolSpaceBootstrapState,
} from './ToolSpaceBootstrapPlanner'

interface SoloToolUseContinuationEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

interface SoloToolUseContinuationToolChoice {
  type: 'tool'
  toolName: string
}

interface SoloToolUseContinuationToolResult {
  toolName: string
  error?: LooseOptional<string>
}

interface RunSoloToolUseContinuationInput<
  TExecutor,
  TToolContext,
  TEvents extends SoloToolUseContinuationEvents = SoloToolUseContinuationEvents,
> {
  turn: number
  history: ModelMessage[]
  executor: TExecutor
  bootstrapToolChoice: LooseOptional<SoloToolUseContinuationToolChoice>
  getBootstrapState(): ToolSpaceBootstrapState
  setBootstrapState(state: ToolSpaceBootstrapState): void
  appendToolResultsToHistory(
    history: ModelMessage[],
    executor: TExecutor
  ): Promise<SoloToolUseContinuationToolResult[]>
  toolContext: TToolContext
  tickLoopReminders(input: {
    mode: 'solo'
    phase: 'after-tool'
    toolContext: TToolContext
  }): Promise<string[]>
  /**
   * 护栏 1（轮次上限）margin 记账：本轮是收尾提醒后的又一次工具调用时返回 true = 强制收尾。
   * 机制单源在 LoopWindDownGuard（面装配为 guard.recordToolUseTurn）。
   */
  shouldForceStopAfterToolTurn(): boolean
  hardCap: number
  events: TEvents
  log: Pick<ScopedLog, 'debug' | 'warn'>
}

type SoloToolUseContinuationResult =
  | { status: 'continue'; toolResults: SoloToolUseContinuationToolResult[] }
  | {
      status: 'completed'
      reason: 'wind-down-cap'
      toolResults: SoloToolUseContinuationToolResult[]
    }

async function runSoloToolUseContinuation<
  TExecutor,
  TToolContext,
  TEvents extends SoloToolUseContinuationEvents = SoloToolUseContinuationEvents,
>(
  input: RunSoloToolUseContinuationInput<TExecutor, TToolContext, TEvents>
): Promise<SoloToolUseContinuationResult> {
  if (input.bootstrapToolChoice) {
    input.setBootstrapState(
      markToolSpaceBootstrapDiscoverySatisfied(input.getBootstrapState())
    )
  }

  const toolResults = await input.appendToolResultsToHistory(input.history, input.executor)

  const afterToolReminders = await input.tickLoopReminders({
    mode: 'solo',
    phase: 'after-tool',
    toolContext: input.toolContext,
  })
  for (const reminder of afterToolReminders) {
    input.history.push(createInternalFollowUpMessage(reminder))
  }

  if (input.shouldForceStopAfterToolTurn()) {
    input.log.warn('solo loop hit hidden turn cap; forcing stop', {
      turn: input.turn,
      hardCap: input.hardCap,
    })
    input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
    return { status: 'completed', reason: 'wind-down-cap', toolResults }
  }

  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('turn end', { turn: input.turn })
  return { status: 'continue', toolResults }
}

export { runSoloToolUseContinuation }
export type {
  RunSoloToolUseContinuationInput,
  SoloToolUseContinuationEvents,
  SoloToolUseContinuationResult,
}
