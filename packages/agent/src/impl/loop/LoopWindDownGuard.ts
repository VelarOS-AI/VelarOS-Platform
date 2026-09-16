import { isPresent } from '@velaros-ai/core'

import type { LoopWindDownGuardApi as LoopWindDownGuardContract, LoopWindDownTriggerReason } from '../../types/loop.js'
import { loopContinue, loopFinish } from '../../utils/loop/loop-wind-down-guard'
import { AgentTuning } from '../../utils/tuning'

/** 建 {@link LoopWindDownGuard} 时定死的两根轴（轮数、可选时间），建好后不再改。 */
interface LoopWindDownGuardOptions {
  /** 硬上限（轮数）；软上限 = 硬上限 - `AgentTuning.loop.turnCapWindDownMargin`。 */
  hardCapTurns: number
  /** 面装配可整体关闭轮次上限（如目标模式长任务）；时间软上限不受此开关影响。 */
  disabled?: boolean
  /** 可选时间软上限（epoch ms）——子 agent 面的 softDeadlineAt 轴；主面缺席。 */
  deadlineAt?: LooseOptional<number>
}

/**
 * 护栏 1 的状态机：一次运行「什么时候该开始收尾、什么时候不能再拖」。
 *
 * 谁建：两个面各在 `execute()` 开头建一个（主面 `SoloStreamLoop` 只有轮数轴，子面 `QueryLoop`
 * 还多一根 `softDeadlineAt` 时间轴），跟着这次运行活，跨轮记账在实例里。
 * 谁调：`runAgentLoop` 引擎每轮开头调 `tickTurnStart`，返回非 null 就由面注入收尾提醒；
 * 工具调用轮结束时面调 `recordToolUseTurn`，返回 true 表示 margin 用尽、必须强制收尾。
 * 本类只判定不执行：不抛错、不碰历史、不发事件，收尾怎么落地（主面返回 completed，子面带着进展文本
 * 回父 Agent）由各自的面决定。
 *
 * 它在 `AgentLoopSurface.windDown.guard` 上露面，因此这里接着 types/loop.ts 的最小形状写，两边不会走形。
 */
export interface LoopWindDownGuardApi extends LoopWindDownGuardContract {
  /**
   * 每轮开始时问一次：该触发软收尾了吗。步数到软上限或时间到 deadline 先到先算，
   * 返回触发原因（`turn-cap` / `time-deadline`）并就地记成「已注入」；未到点或已经触发过返回 null。
   */
  tickTurnStart(turn: number): Nullable<LoopWindDownTriggerReason>
  /**
   * 记一轮「收尾提醒之后模型仍在调工具」。返回 true = 宽限轮数用尽，面应当立刻强制收尾。
   * 提醒还没注入过时恒返回 false（不占宽限额度）。
   */
  recordToolUseTurn(): boolean
  /** 收尾提醒是否已经注入过。面据此避免重复注入，也用于日志归因。 */
  readonly windDownInjected: boolean
}

/**
 * 护栏 1：轮次上限（软收尾 wind-down）单源机制。
 *
 * 触发（turn-start）：步数到软上限或时间到 deadline，先到先触发、全程只注入一次收尾提醒；
 * 执行（tool-use 轮）：提醒注入后模型仍在调工具，最多再放行 `AgentTuning.loop.turnCapWindDownMargin` 轮
 * 即判强制收尾——收尾动作（返回状态 vs 带进展文本返回父）由面收敛。
 */
class LoopWindDownGuard implements LoopWindDownGuardApi {
  private injected = false
  private postWindDownToolTurns = 0

  constructor(private readonly options: LoopWindDownGuardOptions) {}

  /** 到点返回触发原因（并记账「已注入」）；未到点或已注入过返回 null。 */
  public tickTurnStart(turn: number): Nullable<LoopWindDownTriggerReason> {
    if (this.injected) return null

    const timeReached =
      isPresent(this.options.deadlineAt) && Date.now() >= this.options.deadlineAt
    const turnReached =
      !this.options.disabled &&
      turn >= this.options.hardCapTurns - AgentTuning.loop.turnCapWindDownMargin
    if (!timeReached && !turnReached) return null

    this.injected = true
    return turnReached ? 'turn-cap' : 'time-deadline'
  }

  /** 记一轮提醒后的工具调用；返回 true = margin 用尽，面应强制收尾。 */
  public recordToolUseTurn(): boolean {
    if (!this.injected) return false

    this.postWindDownToolTurns += 1
    return this.postWindDownToolTurns >= AgentTuning.loop.turnCapWindDownMargin
  }

  public get windDownInjected(): boolean {
    return this.injected
  }
}

export { loopContinue, loopFinish, LoopWindDownGuard }
export type { LoopWindDownGuardOptions }
