

import type { RunSoloToolSpaceBootstrapFallbackInput, SoloToolSpaceBootstrapFallbackEvents, SoloToolSpaceBootstrapFallbackResult } from '../../types/loop.js'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { ChatRuntimeEvents } from '../wire/chat-runtime.js'

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
