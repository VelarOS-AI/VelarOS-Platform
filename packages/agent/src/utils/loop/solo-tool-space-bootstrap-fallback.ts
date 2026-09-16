

import type { RunSoloToolSpaceBootstrapFallbackInput, SoloToolSpaceBootstrapFallbackEvents, SoloToolSpaceBootstrapFallbackResult } from '../../types/loop.js'
import { createInternalFollowUpMessage } from '../history/internal-messages'
import { streamTurnEnd } from '../wire/chat-runtime'

/**
 * 上一轮强制了 `tooling:map` 却被模型无视（这一轮压根没调工具）时的兜底：把那条侦察提醒重新压进 history，
 * 发出 turnEnd 并让主循环再跑一轮。
 *
 * 四个条件缺一就 `idle` 不干预——本轮没强制侦察、找不到 `tool-space-bootstrap-before-model` 那条提醒、
 * 宿主关掉了 ignored-tool-choice 兜底、或同一指纹的强制次数已经超过 `maxRetries`。
 * 最后一条是防死循环：模型铁了心不调，就放它按现有工具作答，而不是被无限推回侦察。
 */
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
  input.events.emitRuntime(streamTurnEnd(input.turn))
  input.log.debug('turn continued by tool-space bootstrap fallback', { turn: input.turn })
  return { status: 'continue', reason: 'ignored-tool-choice' }
}

export { runSoloToolSpaceBootstrapFallback }
