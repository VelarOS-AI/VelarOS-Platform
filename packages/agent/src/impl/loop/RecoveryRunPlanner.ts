import type { PlanRecoveryRunInput, RecoveryRunPlan } from '../../types/loop.js'
import { planRecoveryRun, resolveRecoveryContextOverflowAction } from '../../utils/loop/runtime-run-planner'

/**
 * 一轮请求的恢复规划件：这轮出岔子（强制工具被无视、上下文溢出、缺能力、证据过期）各走哪条路。
 *
 * 规则本身是纯函数（`utils/loop/runtime-run-planner.ts`），这里只把它们收成一个可注入的规划件，
 * 让宿主换掉「怎么退、退几步」时不必改回合循环本身。无状态：降级进度由调用方按重试次数带进来。
 */
export interface RecoveryRunPlannerApi {
  /**
   * 排这一轮的恢复计划：强制工具被无视的重试上限、上下文溢出的降级梯子、缺能力与证据过期的动作。
   * 纯计算，不落任何状态；这轮没有强制工具时重试面直接关掉。
   */
  plan(input: PlanRecoveryRunInput): RecoveryRunPlan
  /**
   * 按第几次重试在降级梯子上取一档动作；`attempt` 越界就停在最后一档，梯子为空时兜底成投降。
   * 调用方每次上下文溢出重试前调一次，自己不记进度。
   */
  resolveContextOverflowAction(
    recovery: RecoveryRunPlan,
    attempt: number
  ): RecoveryRunPlan['contextOverflow']['ladder'][number]
}

class RecoveryRunPlanner implements RecoveryRunPlannerApi {
  public plan(input: PlanRecoveryRunInput): RecoveryRunPlan {
    return planRecoveryRun(input)
  }

  public resolveContextOverflowAction(
    recovery: RecoveryRunPlan,
    attempt: number
  ): RecoveryRunPlan['contextOverflow']['ladder'][number] {
    return resolveRecoveryContextOverflowAction(recovery, attempt)
  }
}

/** 恢复规划件的共享实例：无状态，全仓共用一份即可。 */
export const recoveryRunPlanner: RecoveryRunPlannerApi = new RecoveryRunPlanner()

export { RecoveryRunPlanner }
