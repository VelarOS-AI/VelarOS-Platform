import { isPresent } from '@velaros-ai/core'

import type { LoopTurnVerdict, LoopWindDownTriggerReason } from '../../types/loop.js'

const AgentTurnCapWindDownMargin = 2

/**
 * Loop 装配面契约（B5 单引擎双面）。
 *
 * `AgentLoop`（runAgentLoop）是全内核唯一的 agent 循环引擎；主 agent 面（SoloStreamLoop）与
 * 子 agent 面（QueryLoop）都只是对这份契约的装配：
 * - 主面 = UI 投影 / turn 轴 / goal 生命周期 / handoff 信号 / 自动验证收尾门；
 * - 子面 = 无 UI / turn:null 轴 / 结构化输出 / 软上限（时间轴）/ usage 回传。
 *
 * 四类护栏（轮次上限 / 上下文治理触发 / 中止 / 异常收敛）机制单源在引擎侧
 * （本文件的 {@link LoopWindDownGuard} + AgentLoop 的溢出恢复与 turn span 收敛），
 * 面只提供文案、日志与收敛动作——装配差异是真差异要保，机制分裂是形态债要禁。
 */

function loopContinue<TFinish>(): LoopTurnVerdict<TFinish> {
  return { kind: 'continue' }
}

function loopFinish<TFinish>(value: TFinish): LoopTurnVerdict<TFinish> {
  return { kind: 'finish', value }
}

interface LoopWindDownGuardOptions {
  /** 硬上限（轮数）；软上限 = 硬上限 - AgentTurnCapWindDownMargin。 */
  hardCapTurns: number
  /** 面装配可整体关闭轮次上限（如目标模式长任务）；时间软上限不受此开关影响。 */
  disabled?: boolean
  /** 可选时间软上限（epoch ms）——子 agent 面的 softDeadlineAt 轴；主面缺席。 */
  deadlineAt?: LooseOptional<number>
}

/**
 * 护栏 1：轮次上限（软收尾 wind-down）单源机制。
 *
 * 触发（turn-start）：步数到软上限或时间到 deadline，先到先触发、全程只注入一次收尾提醒；
 * 执行（tool-use 轮）：提醒注入后模型仍在调工具，最多再放行 AgentTurnCapWindDownMargin 轮
 * 即判强制收尾——收尾动作（返回状态 vs 带进展文本返回父）由面收敛。
 */
class LoopWindDownGuard {
  private injected = false
  private postWindDownToolTurns = 0

  constructor(private readonly options: LoopWindDownGuardOptions) {}

  /** 到点返回触发原因（并记账「已注入」）；未到点或已注入过返回 null。 */
  public tickTurnStart(turn: number): Nullable<LoopWindDownTriggerReason> {
    if (this.injected) return null

    const timeReached =
      isPresent(this.options.deadlineAt) && Date.now() >= this.options.deadlineAt
    const turnReached =
      !this.options.disabled && turn >= this.options.hardCapTurns - AgentTurnCapWindDownMargin
    if (!timeReached && !turnReached) return null

    this.injected = true
    return turnReached ? 'turn-cap' : 'time-deadline'
  }

  /** 记一轮提醒后的工具调用；返回 true = margin 用尽，面应强制收尾。 */
  public recordToolUseTurn(): boolean {
    if (!this.injected) return false

    this.postWindDownToolTurns += 1
    return this.postWindDownToolTurns >= AgentTurnCapWindDownMargin
  }

  public get windDownInjected(): boolean {
    return this.injected
  }
}

export { loopContinue, loopFinish, LoopWindDownGuard }
export type { LoopWindDownGuardOptions }
