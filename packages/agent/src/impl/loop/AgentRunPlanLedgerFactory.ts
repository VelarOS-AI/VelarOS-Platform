// 域：运行计划账本（control-plane ledger）的条目工厂。接口 `AgentRunPlanLedgerFactoryApi` 在本文件的类上方。
import type { AgentRunPlanLedgerEntry, AgentRunPlanLedgerSource } from '../../types/loop.js'

/**
 * 每轮 run plan 的取舍记账：意图分类、工具面收窄、预算裁剪、缺页恢复各写一条，汇成
 * `AgentRunPlan.ledger` 随 turn context 投给界面的调试面板，用来事后解释「这轮为什么只给了这些工具」。
 *
 * 进程内单实例（本文件末尾的 `agentRunPlanLedgerFactory`，由 `src/utils/loop/agent-run-planner.ts` 直接用），
 * 自增序号是实例状态、不落盘：只保证同一进程内条目 id 不撞，重启后从头计数。
 */
export interface AgentRunPlanLedgerFactoryApi {
  /**
   * 记一条决策并返回条目；规划器在做出取舍的当下同步调用，不做 IO 也不抛错。
   * id 按「来源:动作:自增序号」拼，同一轮里多条同名动作靠序号区分先后。
   */
  createEntry(input: {
    /** 哪个规划面写的（intent / capability / context / prompt / recovery），也是条目 id 的第一段。 */
    source: AgentRunPlanLedgerSource
    /** 这条记的动作名，如 `classify`、`narrow-tools`；id 的第二段，面板按它归类。 */
    action: string
    /** 为什么这么定，一句给人读的话，原样显示在调试面板上。 */
    reason: string
    /** 佐证这次取舍的结构化数据（候选数、预算、被淘汰项等）；不传就不写 details 字段。 */
    details?: Record<string, unknown>
  }): AgentRunPlanLedgerEntry
}

class AgentRunPlanLedgerFactory implements AgentRunPlanLedgerFactoryApi {
  private nextEntryId = 0

  public createEntry(input: {
    source: AgentRunPlanLedgerSource
    action: string
    reason: string
    details?: Record<string, unknown>
  }): AgentRunPlanLedgerEntry {
    this.nextEntryId += 1
    const entry: AgentRunPlanLedgerEntry = {
      id: `${input.source}:${input.action}:${this.nextEntryId}`,
      source: input.source,
      action: input.action,
      reason: input.reason,
    }

    if (input.details) {
      entry.details = input.details
    }

    return entry
  }
}

const agentRunPlanLedgerFactory = new AgentRunPlanLedgerFactory()

export { AgentRunPlanLedgerFactory,agentRunPlanLedgerFactory }
