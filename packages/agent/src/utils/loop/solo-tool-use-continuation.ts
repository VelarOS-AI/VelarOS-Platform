

import type { RunSoloToolUseContinuationInput, SoloToolUseContinuationEvents, SoloToolUseContinuationResult } from '../../types/loop.js'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

import { markToolSpaceBootstrapDiscoverySatisfied } from './tool-space-bootstrap-planner'

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
