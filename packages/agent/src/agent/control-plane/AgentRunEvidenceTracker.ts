import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { isEmpty } from '@velaros-ai/core'

import type { ValidationRunPlan } from './AgentRunPlan'

interface AgentRunActionResult {
  toolName: string
  categoryId?: ToolCategoryId
  succeeded: boolean
}

interface AgentRunEvidenceGateResult {
  allowed: boolean
  evidenceRequired: boolean
  observedActionIds: string[]
  missingActionIds: string[]
}

/**
 * One tracker belongs to one user execution, never to a persisted conversation.
 * Historical tool results therefore cannot satisfy a new task's evidence gate.
 */
class AgentRunEvidenceTracker {
  private evidenceRequired = false
  private readonly evidenceCategoryIds = new Set<ToolCategoryId>()
  private readonly minimumActionIds = new Set<string>()
  private readonly observedActionIds = new Set<string>()
  private readonly observedEvidenceActionIds = new Set<string>()

  public require(plan: ValidationRunPlan): void {
    if (plan.finishingGate === 'none') return
    this.evidenceRequired ||= plan.evidenceRequired
    for (const categoryId of plan.evidenceCategoryIds) this.evidenceCategoryIds.add(categoryId)
    for (const actionId of plan.minimumActionIds) this.minimumActionIds.add(actionId)
  }

  public record(results: readonly AgentRunActionResult[]): void {
    for (const result of results) {
      if (!result.succeeded) continue
      const actionId = result.toolName.trim()
      if (!actionId) continue
      this.observedActionIds.add(actionId)
      if (
        this.evidenceCategoryIds.size === 0 ||
        (result.categoryId && this.evidenceCategoryIds.has(result.categoryId))
      ) {
        this.observedEvidenceActionIds.add(actionId)
      }
    }
  }

  public evaluate(): AgentRunEvidenceGateResult {
    const observedActionIds = [...this.observedActionIds]
    const missingActionIds = [...this.minimumActionIds].filter(
      (actionId) => !this.observedActionIds.has(actionId)
    )
    const hasRequiredEvidence =
      !this.evidenceRequired || this.observedEvidenceActionIds.size > 0
    return {
      allowed: hasRequiredEvidence && isEmpty(missingActionIds),
      evidenceRequired: this.evidenceRequired,
      observedActionIds,
      missingActionIds,
    }
  }
}

export { AgentRunEvidenceTracker }
export type { AgentRunActionResult, AgentRunEvidenceGateResult }
