import type { RunProfileId } from '@velaros-ai/agent/protocol'
import { isEmpty,isFiniteNumber } from '@velaros-ai/core'

import {
  ContextWorkingSetBudgetGovernor,
  type ContextWorkingSetBudgetLedgerEntry,
  estimateBlockTokens,
  type ProviderRequestPressureKind,
} from '../context'
import {
  contextDegradeStaircaseLength,
  resolveContextDegradeAction,
} from '../ContextDegradeLadder'
import { RunProfileDefinitions } from '../RunProfile'

import type { ContextRunPlan, PromptRunPlan, RecoveryRunPlan, ToolPageFault } from './AgentRunPlan'

const DefaultAgentContextWindow = 128_000

export interface PlanContextRunInput {
  model: string
  contextWindow?: number
  toolSchemaChars?: Readonly<Record<string, number>>
  toolSchemaBudgetScale?: number
}

class ContextRunPlanner {
  public plan(input: PlanContextRunInput): ContextRunPlan {
    const contextWindow = input.contextWindow ?? DefaultAgentContextWindow
    const zoneAllocation = ContextWorkingSetBudgetGovernor.allocate({
      contextWindow,
      ledger: this.buildContextLedger(input),
    })
    const toolSchemaBudgetScale = this.resolveToolSchemaBudgetScale(input.toolSchemaBudgetScale)
    const baseToolSchemaCharBudget = ContextWorkingSetBudgetGovernor.resolveZoneCharBudget(
      zoneAllocation,
      'tool-schemas'
    )

    return {
      contextWindow,
      usableContextWindow: zoneAllocation.usableContextWindow,
      zoneAllocation,
      toolSchemaCharBudget: Math.floor(baseToolSchemaCharBudget * toolSchemaBudgetScale),
      toolSchemaBudgetScale,
      payloadPolicy: 'dedupe-and-reference',
      pressure: this.resolvePlanPressure(zoneAllocation),
    }
  }

  private buildContextLedger(input: PlanContextRunInput): ContextWorkingSetBudgetLedgerEntry[] {
    const toolSchemaChars = this.sumPositive(Object.values(input.toolSchemaChars ?? {}))
    if (toolSchemaChars <= 0) return []

    return [
      {
        zone: 'tool-schemas',
        estimatedTokens: estimateBlockTokens(toolSchemaChars),
      },
    ]
  }

  private sumPositive(values: Iterable<number>): number {
    let total = 0

    for (const value of values) {
      total += Math.max(0, value)
    }

    return total
  }

  private resolveToolSchemaBudgetScale(value: unknown): number {
    if (!isFiniteNumber(value)) return 1
    return Math.min(1, Math.max(0.25, value))
  }

  private resolvePlanPressure(
    allocation: ContextRunPlan['zoneAllocation']
  ): ProviderRequestPressureKind {
    if (allocation.totalOverBudgetTokens <= 0) return 'none'

    const toolSchemaOverBudget = allocation.zones['tool-schemas'].overBudgetTokens > 0
    if (
      toolSchemaOverBudget &&
      allocation.totalOverBudgetTokens > allocation.zones['tool-schemas'].overBudgetTokens
    ) return 'mixed'

    return toolSchemaOverBudget ? 'tool-schema' : 'tokens'
  }
}

export interface PlanRecoveryRunInput {
  forcedToolChoice?: { type: 'tool'; toolName: string }
  pageFaults?: readonly ToolPageFault[]
  requiresCapabilityEvidence?: boolean
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
}

export interface CapabilityEvidenceSnapshot {
  hasEvidence: boolean
  isStale: boolean
}

class RecoveryRunPlanner {
  public plan(input: PlanRecoveryRunInput): RecoveryRunPlan {
    const forced = Boolean(input.forcedToolChoice)
    return {
      ignoredToolChoice: forced
        ? {
            enabled: true,
            maxRetries: 1,
            fallbackReminderId: 'tool-space-bootstrap-ignored-tool-choice',
          }
        : {
            enabled: false,
            maxRetries: 0,
          },
      contextOverflow: {
        ladder: Array.from({ length: contextDegradeStaircaseLength('solo') }, (_value, index) =>
          resolveContextDegradeAction('solo', index)
        ),
      },
      missingCapability: {
        action: this.resolveMissingCapabilityAction(input.pageFaults),
      },
      staleEvidence: {
        action: this.resolveStaleEvidenceAction(input),
      },
    }
  }

  public resolveContextOverflowAction(
    recovery: RecoveryRunPlan,
    attempt: number
  ): RecoveryRunPlan['contextOverflow']['ladder'][number] {
    const ladder = recovery.contextOverflow.ladder
    const index = Math.max(0, Math.floor(attempt))

    return ladder[index] ?? ladder[ladder.length - 1] ?? { kind: 'surrender', level: 1 }
  }

  private resolveMissingCapabilityAction(
    pageFaults: readonly ToolPageFault[] = []
  ): RecoveryRunPlan['missingCapability']['action'] {
    if (pageFaults.some((fault) => fault.recoveryHint === 'stop')) return 'stop'

    if (pageFaults.some((fault) => fault.recoveryHint === 'request-user-action')) return 'request-user-action'

    if (pageFaults.some((fault) => fault.recoveryHint === 'request-approval')) return 'request-user-action'

    if (pageFaults.some((fault) => fault.recoveryHint === 'page-out-other-tools')) return 'discover'

    return 'discover'
  }

  private resolveStaleEvidenceAction(input: {
    requiresCapabilityEvidence?: boolean
    capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
  }): RecoveryRunPlan['staleEvidence']['action'] {
    if (!input.requiresCapabilityEvidence || !input.capabilityEvidenceSnapshot?.hasEvidence) return 'none'

    return input.capabilityEvidenceSnapshot.isStale ? 'refresh-capability-context' : 'none'
  }
}

export interface BuildPromptRunPlanInput {
  runProfile: RunProfileId
  bootstrapReminder?: string
  pageFaults?: readonly ToolPageFault[]
  recovery?: RecoveryRunPlan
}

class PromptRunPlanner {
  public build(input: BuildPromptRunPlanInput): PromptRunPlan {
    const runProfileDefinition = RunProfileDefinitions[input.runProfile]
    const maxSystemPromptChars = runProfileDefinition.budget.maxSystemPromptChars
    const internalReminders: PromptRunPlan['internalReminders'] = []
    if (input.bootstrapReminder) {
      internalReminders.push({
        id: 'tool-space-bootstrap-before-model',
        phase: 'before-model',
        reason: 'capability planner requires tool-space discovery',
        text: input.bootstrapReminder,
        dedupeKey: 'tool-space-bootstrap',
      })
    }

    const pageFaultReminder = this.buildCapabilityPageFaultReminder({
      pageFaults: input.pageFaults ?? [],
      recovery: input.recovery,
    })
    if (pageFaultReminder) {
      internalReminders.push({
        id: 'capability-page-fault-before-model',
        phase: 'before-model',
        reason: 'capability planner detected an unrecovered page fault',
        text: pageFaultReminder,
        dedupeKey: 'capability-page-fault',
      })
    }
    const staleEvidenceReminder = this.buildStaleEvidenceReminder(input.recovery)
    if (staleEvidenceReminder) {
      internalReminders.push({
        id: 'stale-capability-evidence-before-model',
        phase: 'before-model',
        reason: 'recovery planner detected stale capability evidence',
        text: staleEvidenceReminder,
        dedupeKey: 'stale-capability-evidence',
      })
    }

    const prompt: PromptRunPlan = {
      runProfile: input.runProfile,
      internalReminders,
    }

    if (isFiniteNumber(maxSystemPromptChars)) {
      prompt.promptBudget = {
        profile: input.runProfile,
        maxChars: maxSystemPromptChars,
      }
    }

    return prompt
  }

  private buildStaleEvidenceReminder(recovery?: RecoveryRunPlan): Nullable<string> {
    if (recovery?.staleEvidence.action !== 'refresh-capability-context') return null

    return '[system] Capability evidence is stale after later activity. Refresh the owning capability context before relying on earlier evidence.'
  }

  private buildCapabilityPageFaultReminder(input: {
    pageFaults: readonly ToolPageFault[]
    recovery?: RecoveryRunPlan
  }): Nullable<string> {
    if (isEmpty(input.pageFaults) || !input.recovery) return null

    const faultText = input.pageFaults
      .map((fault) => {
        const categoryText = fault.categoryId ? `，category=${fault.categoryId}` : ''
        return `${fault.toolName}(${fault.reason}${categoryText}, recovery=${fault.recoveryHint})`
      })
      .join('；')
    const action = input.recovery.missingCapability.action
    const needsToolSpaceAdjustment = input.pageFaults.some(
      (fault) => fault.recoveryHint === 'page-out-other-tools'
    )
    const actionText =
      action === 'stop'
        ? '当前角色或工具边界无法恢复该缺页。不要用现有工具凑答案；直接说明无法继续，并指出需要调整角色允许工具或工具空间边界。'
        : action === 'request-user-action'
          ? '需要用户动作或授权后再继续。'
          : action === 'read-page'
            ? '先读取对应工具页确认依赖和 schema。'
            : needsToolSpaceAdjustment
              ? '先用 tooling:replace page-out 暂时不需要的工具腾出工具空间，再重新 page-in 或发现目标能力。'
              : '先重新发现或调整工具空间后再继续。'

    return `[系统] Capability page fault：${faultText}。恢复策略：${action}。${actionText}`
  }
}

const contextRunPlanner = new ContextRunPlanner()
const recoveryRunPlanner = new RecoveryRunPlanner()
const promptRunPlanner = new PromptRunPlanner()

export {
  ContextRunPlanner,
  contextRunPlanner,
  PromptRunPlanner,
  promptRunPlanner,
  RecoveryRunPlanner,
  recoveryRunPlanner,
}
