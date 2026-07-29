import type { AgentRunPlanLedgerEntry, AgentRunPlanLedgerSource } from './AgentRunPlan'

/** control-plane ledger 条目工厂；维护递增 id，保证条目稳定可追踪。 */
class AgentRunPlanLedgerFactory {
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
