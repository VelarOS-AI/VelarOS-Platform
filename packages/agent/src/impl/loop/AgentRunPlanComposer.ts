import type { AgentRunPlan, BuildAgentRunPlanInput } from '../../types/loop.js'
import { buildAgentRunPlan } from '../../utils/loop/agent-run-planner'

/**
 * 一轮请求的总装配件：把意图、上下文预算、能力换入、恢复策略与提示词排成一份 AgentRunPlan。
 *
 * 装配规则本身是纯函数（`utils/loop/agent-run-planner.ts`），这里只把它收成一个可注入的装配件，
 * 让宿主换掉「一轮先算什么、后算什么」时不必改回合循环本身。无状态：这轮的历史、角色运行态与
 * 账本工厂都由入参带进来。
 */
export interface AgentRunPlanComposerApi {
  /**
   * 排这一轮的总计划：按意图 → 上下文预算 → 能力换入 → 恢复策略 → 提示词的顺序算一遍，
   * 连同记好的账目一起封成 AgentRunPlan 返回。纯计算，不落任何状态；工具不够用不抛错，
   * 改成计划里的缺页与恢复动作交给调用方处置。
   */
  build(input: BuildAgentRunPlanInput): AgentRunPlan
}

class AgentRunPlanComposer implements AgentRunPlanComposerApi {
  public build(input: BuildAgentRunPlanInput): AgentRunPlan {
    return buildAgentRunPlan(input)
  }
}

/** 回合总装配件的共享实例：无状态，全仓共用一份即可。 */
export const agentRunPlanComposer: AgentRunPlanComposerApi = new AgentRunPlanComposer()

export { AgentRunPlanComposer }
