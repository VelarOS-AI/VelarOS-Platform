import type { AgentRunPlanLedgerEntry, BuildAgentRunPlanLedgerInput } from '../../types/loop.js'
import { buildAgentRunPlanLedger } from '../../utils/loop/agent-run-planner'

/**
 * 回合计划的账目装配件：把这轮各家计划（意图、上下文、能力、恢复）记成一串可复盘的账目。
 *
 * 记账规则本身是纯函数（`utils/loop/agent-run-planner.ts`），这里只把它收成一个可注入的装配件，
 * 让宿主换掉「这轮记哪几条账」时不必改回合装配本身。无状态：账目 id 与时钟走入参的账本工厂。
 */
export interface AgentRunPlanLedgerComposerApi {
  /**
   * 把这轮的计划记成账目：意图、上下文分区、能力换入各一条；有工具缺页或证据过期时再各补一条恢复账。
   * 纯计算，不落任何状态，也不改传进来的计划。
   */
  build(input: BuildAgentRunPlanLedgerInput): AgentRunPlanLedgerEntry[]
}

class AgentRunPlanLedgerComposer implements AgentRunPlanLedgerComposerApi {
  public build(input: BuildAgentRunPlanLedgerInput): AgentRunPlanLedgerEntry[] {
    return buildAgentRunPlanLedger(input)
  }
}

/** 账目装配件的共享实例：无状态，全仓共用一份即可。 */
export const agentRunPlanLedgerComposer: AgentRunPlanLedgerComposerApi = new AgentRunPlanLedgerComposer()

export { AgentRunPlanLedgerComposer }
