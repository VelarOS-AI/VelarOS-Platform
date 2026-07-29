import type { ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'

import { createInternalFollowUpMessage } from './history'

/**
 * 主面轮次上限收尾的**注入动作**（文案 + 日志）。触发判定与 margin 记账是护栏 1 机制，
 * 单源在 LoopSurface 的 LoopWindDownGuard——本文件只保留主 agent 面的装配差异（提醒措辞）。
 */

interface RunSoloTurnWindDownInput {
  turn: number
  hardCap: number
  history: ModelMessage[]
  log: Pick<ScopedLog, 'warn'>
}

function buildSoloTurnCapWindDownReminder(): string {
  return [
    '[系统] 本次执行已进行很多步，接近内部步数上限。',
    '请立即停止调用工具，基于现有进展给出结论或可交付结果；',
    '若确实受阻，请说明卡点并向用户提出下一步建议，然后结束本次回复。',
  ].join('\n')
}

/** guard 判定到点后由主面调用：注入收尾提醒并记日志。 */
function runSoloTurnWindDown(input: RunSoloTurnWindDownInput): void {
  input.history.push(createInternalFollowUpMessage(buildSoloTurnCapWindDownReminder()))
  input.log.warn('solo loop approaching hidden turn cap; injected wind-down', {
    turn: input.turn,
    hardCap: input.hardCap,
  })
}

export { buildSoloTurnCapWindDownReminder, runSoloTurnWindDown }
export type { RunSoloTurnWindDownInput }
