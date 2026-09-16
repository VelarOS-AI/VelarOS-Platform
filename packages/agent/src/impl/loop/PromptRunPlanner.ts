import type { BuildPromptRunPlanInput, PromptRunPlan } from '../../types/loop.js'
import { buildPromptRunPlan } from '../../utils/loop/runtime-run-planner'

/**
 * 一轮请求的提示词规划件：按运行档位定系统提示预算，并排好这轮要插的内部提醒。
 *
 * 规则本身是纯函数（`utils/loop/runtime-run-planner.ts`），这里只把它收成一个可注入的规划件，
 * 让宿主换掉「这轮提醒模型什么、系统提示给多少字符」时不必改回合装配本身。无状态，可重复调用。
 */
export interface PromptRunPlannerApi {
  /**
   * 排这一轮的提示词计划：返回运行档位、系统提示字符预算（档位没设上限时不带这一项），
   * 以及按引导、工具缺页、证据过期依次排好的内部提醒。纯计算，不落任何状态，也不改提示词本身。
   */
  build(input: BuildPromptRunPlanInput): PromptRunPlan
}

class PromptRunPlanner implements PromptRunPlannerApi {
  public build(input: BuildPromptRunPlanInput): PromptRunPlan {
    return buildPromptRunPlan(input)
  }
}

/** 提示词规划件的共享实例：无状态，全仓共用一份即可。 */
export const promptRunPlanner: PromptRunPlannerApi = new PromptRunPlanner()

export { PromptRunPlanner }
