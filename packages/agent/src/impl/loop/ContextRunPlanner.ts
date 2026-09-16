import type { ContextRunPlan, PlanContextRunInput } from '../../types/loop.js'
import { planContextRun } from '../../utils/loop/runtime-run-planner'

/**
 * 一轮请求的上下文预算规划件：定上下文窗口、分区预算与工具 schema 字符额度。
 *
 * 规则本身是纯函数（`utils/loop/runtime-run-planner.ts`），这里只把它收成一个可注入的规划件，
 * 让宿主换掉「这轮给多少预算、压力怎么判」时不必改回合装配本身。无状态，可重复调用。
 */
export interface ContextRunPlannerApi {
  /**
   * 排这一轮的上下文预算计划：返回窗口大小、分区分配、工具 schema 字符额度与这轮的压力口径。
   * 纯计算，不落任何状态；`contextWindow` 缺省按内置窗口算，工具 schema 字符数为空时不记分区账。
   */
  plan(input: PlanContextRunInput): ContextRunPlan
}

class ContextRunPlanner implements ContextRunPlannerApi {
  public plan(input: PlanContextRunInput): ContextRunPlan {
    return planContextRun(input)
  }
}

/** 上下文预算规划件的共享实例：无状态，全仓共用一份即可。 */
export const contextRunPlanner: ContextRunPlannerApi = new ContextRunPlanner()

export { ContextRunPlanner }
