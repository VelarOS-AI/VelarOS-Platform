// QueryLoop 用到的纯函数（不碰实例状态）。
import type { ModelMessage } from 'ai'

import { isBlank } from '@velaros-ai/core'
import { type logRuntime } from '@velaros-ai/core/logger'

import { createInternalFollowUpMessage } from '../../utils/history/internal-messages'

/** 取一次转达给子 Agent 的引导，非空就作为内部跟进消息压进本轮历史。 */
export async function consumeQueryLoopRelayedGuidance(input: {
  turn: number
  history: ModelMessage[]
  consumeRelayedGuidance?: () => Nullable<string> | Promise<Nullable<string>>
  log: Pick<ReturnType<typeof logRuntime.tag>, 'info'>
}): Promise<void> {
  const relay = (await input.consumeRelayedGuidance?.())?.trim()
  if (!relay || isBlank(relay)) return

  input.history.push(
    createInternalFollowUpMessage(
      [
        '[主控 relay 引导]',
        '上级主 Agent 已理解用户追加引导，并将以下要点转交给你继续执行。',
        '请按主控表述行动；不要假设你能看到用户原文。',
        '',
        relay,
      ].join('\n')
    )
  )
  input.log.info('sub-agent relayed guidance consumed', { turn: input.turn })
}
