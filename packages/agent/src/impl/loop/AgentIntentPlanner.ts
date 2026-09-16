import type { AgentIntentPlan, AgentRunPlanLedgerEntry, AgentRunPlanLedgerRecorder, PlanAgentIntentInput } from '../../types/loop.js'
import { buildAgentIntentLedger, planAgentIntent } from '../../utils/loop/agent-run-planner'

/**
 * 回合意图判定件：从这轮历史里认最后一条用户消息要干什么。
 *
 * 判定规则本身是纯函数（`utils/loop/agent-run-planner.ts`），这里只把它们收成一个可注入的判定件，
 * 让宿主换掉「怎么认领域、什么算低信号」时不必改回合装配本身。无状态：历史与能力面都由入参带进来。
 */
export interface AgentIntentPlannerApi {
  /**
   * 判这轮的意图：返回归一化后的用户原话、命中的领域、复杂度与置信度，以及要不要证据、要不要发现工具。
   * 纯计算，不落任何状态；话太短或没信息量时直接给低信号结果，不猜领域。
   */
  plan(input: PlanAgentIntentInput): AgentIntentPlan
  /**
   * 把一次意图判定写成账目，账目由入参的账本工厂建（工厂从外面注入，便于宿主换 id 与时钟）。
   * 只记账不改计划，返回的永远是一条。
   */
  buildLedger(
    intent: AgentIntentPlan,
    ledgerFactory: AgentRunPlanLedgerRecorder
  ): AgentRunPlanLedgerEntry[]
}

class AgentIntentPlanner implements AgentIntentPlannerApi {
  public plan(input: PlanAgentIntentInput): AgentIntentPlan {
    return planAgentIntent(input)
  }

  public buildLedger(
    intent: AgentIntentPlan,
    ledgerFactory: AgentRunPlanLedgerRecorder
  ): AgentRunPlanLedgerEntry[] {
    return buildAgentIntentLedger(intent, ledgerFactory)
  }
}

/** 意图判定件的共享实例：无状态，全仓共用一份即可。 */
export const agentIntentPlanner: AgentIntentPlannerApi = new AgentIntentPlanner()

export { AgentIntentPlanner }
