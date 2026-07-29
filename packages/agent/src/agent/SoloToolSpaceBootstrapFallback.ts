import type { ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'
import type { StreamTurnEndPayload } from '@velaros-ai/core/types'
import { ChatRuntimeEvents } from '@velaros-ai/core/types'

import { createInternalFollowUpMessage } from './history'
import type { ToolSpaceBootstrapState } from './ToolSpaceBootstrapPlanner'

interface SoloToolSpaceBootstrapFallbackEvents {
  emitRuntime(payload: StreamTurnEndPayload): void
}

interface SoloToolSpaceBootstrapFallbackToolChoice {
  type: 'tool'
  toolName: string
}

interface SoloToolSpaceBootstrapFallbackReminder {
  id: string
  text: string
}

interface RunSoloToolSpaceBootstrapFallbackInput<
  TEvents extends SoloToolSpaceBootstrapFallbackEvents = SoloToolSpaceBootstrapFallbackEvents,
> {
  turn: number
  history: ModelMessage[]
  bootstrapToolChoice: LooseOptional<SoloToolSpaceBootstrapFallbackToolChoice>
  internalReminders: readonly SoloToolSpaceBootstrapFallbackReminder[]
  ignoredToolChoice: {
    enabled: boolean
    maxRetries: number
  }
  getBootstrapState(): ToolSpaceBootstrapState
  events: TEvents
  log: Pick<ScopedLog, 'debug'>
}

type SoloToolSpaceBootstrapFallbackResult =
  | { status: 'continue'; reason: 'ignored-tool-choice' }
  | { status: 'idle' }

function runSoloToolSpaceBootstrapFallback<
  TEvents extends SoloToolSpaceBootstrapFallbackEvents = SoloToolSpaceBootstrapFallbackEvents,
>(
  input: RunSoloToolSpaceBootstrapFallbackInput<TEvents>
): SoloToolSpaceBootstrapFallbackResult {
  const fallbackReminder = input.internalReminders.find(
    (entry) => entry.id === 'tool-space-bootstrap-before-model'
  )?.text

  if (
    !input.bootstrapToolChoice ||
    !fallbackReminder ||
    !input.ignoredToolChoice.enabled ||
    (input.getBootstrapState().forcedDiscoveryCount ?? 0) > input.ignoredToolChoice.maxRetries
  ) return { status: 'idle' }

  input.history.push(
    createInternalFollowUpMessage(
      ['[系统] 上一轮未执行必需的工具空间侦察。', fallbackReminder].join('\n')
    )
  )
  input.events.emitRuntime(ChatRuntimeEvents.turnEnd(input.turn))
  input.log.debug('turn continued by tool-space bootstrap fallback', { turn: input.turn })
  return { status: 'continue', reason: 'ignored-tool-choice' }
}

export { runSoloToolSpaceBootstrapFallback }
export type {
  RunSoloToolSpaceBootstrapFallbackInput,
  SoloToolSpaceBootstrapFallbackEvents,
  SoloToolSpaceBootstrapFallbackResult,
}
