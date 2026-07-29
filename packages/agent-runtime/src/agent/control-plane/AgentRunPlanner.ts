import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'
import type { RunProfileSelectionId } from '@velaros-ai/core/types'

import type { AgentRuntimeCapabilityPorts } from '../../capabilities'
import {
  detectAgentIntentSignals,
  extractLatestUserTextFromMessages,
  isLowSignalIntentText,
  normalizeIntentText,
} from '../IntentSignals'

import type {
  AgentIntentDomain,
  AgentIntentPlan,
  AgentRunPlan,
  AgentRunPlanLedgerEntry,
  AgentRuntimePlan,
  CapabilityRunPlan,
  ContextRunPlan,
  RecoveryRunPlan,
  ValidationRunPlan,
} from './AgentRunPlan'
import { agentRunPlanLedgerFactory } from './AgentRunPlanLedger'
import { capabilityRunPlanner, type PlanCapabilityRunInput } from './CapabilityRunPlanner'
import {
  type CapabilityEvidenceSnapshot,
  contextRunPlanner,
  promptRunPlanner,
  recoveryRunPlanner,
} from './RuntimeRunPlanner'

export interface PlanAgentIntentInput {
  messages: ModelMessage[]
  capabilityPorts?: AgentRuntimeCapabilityPorts
}

class AgentIntentPlanner {
  public plan(input: PlanAgentIntentInput): AgentIntentPlan {
    const latestUserText = normalizeIntentText(
      extractLatestUserTextFromMessages(input.messages) ?? ''
    )
    if (isLowSignalIntentText(latestUserText)) return this.createLowSignalIntent(latestUserText)

    const signals = detectAgentIntentSignals(latestUserText, input.capabilityPorts)
    const domains: AgentIntentDomain[] = signals.domains.map((domain) => domain.id)
    const requiresCapabilityEvidence =
      signals.requiresEvidence || signals.requiresMutation || signals.requiresValidation

    return {
      latestUserText,
      domains,
      complexity: this.resolveComplexity(domains),
      confidence: domains.includes('unknown') || isEmpty(domains) ? 'low' : 'medium',
      requiresEvidence: requiresCapabilityEvidence,
      requiresCapabilityEvidence,
      requiresToolDiscovery: !isEmpty(domains),
      requiresMutation: signals.requiresMutation,
      requiresValidation: signals.requiresValidation,
      minimumActionIds: signals.minimumActionIds,
    }
  }

  public buildLedger(intent: AgentIntentPlan): AgentRunPlanLedgerEntry[] {
    return [
      agentRunPlanLedgerFactory.createEntry({
        source: 'intent',
        action: 'classify',
        reason: intent.requiresToolDiscovery
          ? 'latest user request requires capability planning'
          : 'latest user request does not require tool discovery',
        details: {
          domains: intent.domains,
          complexity: intent.complexity,
          confidence: intent.confidence,
        },
      }),
    ]
  }

  private createLowSignalIntent(latestUserText: string): AgentIntentPlan {
    return {
      latestUserText,
      domains: [],
      complexity: 'low',
      confidence: 'low',
      requiresEvidence: false,
      requiresCapabilityEvidence: false,
      requiresToolDiscovery: false,
      requiresMutation: false,
      requiresValidation: false,
      minimumActionIds: [],
    }
  }

  private resolveComplexity(domains: readonly AgentIntentDomain[]): AgentIntentPlan['complexity'] {
    if (isEmpty(domains)) return 'low'
    return domains.length === 1 ? 'single-domain' : 'multi-domain'
  }
}

export interface BuildAgentRunPlanLedgerInput {
  intent: AgentIntentPlan
  context: ContextRunPlan
  capabilities: CapabilityRunPlan
  recovery: RecoveryRunPlan
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
}

class AgentRunPlanLedgerComposer {
  public build(input: BuildAgentRunPlanLedgerInput): AgentRunPlanLedgerEntry[] {
    return [
      ...agentIntentPlanner.buildLedger(input.intent),
      agentRunPlanLedgerFactory.createEntry({
        source: 'context',
        action: 'allocate-zones',
        reason: 'ContextOS zone allocation created for this turn',
        details: {
          contextWindow: input.context.contextWindow,
          usableContextWindow: input.context.usableContextWindow,
          toolSchemaCharBudget: input.context.toolSchemaCharBudget,
          toolSchemaBudgetScale: input.context.toolSchemaBudgetScale,
        },
      }),
      agentRunPlanLedgerFactory.createEntry({
        source: 'capability',
        action: input.capabilities.forcedToolChoice ? 'force-discovery' : 'resolve-resident-tools',
        reason: input.capabilities.forcedToolChoice
          ? 'capability planner selected a discovery tool'
          : 'capability planner resolved resident tools without forced discovery',
        details: {
          forcedToolChoice: input.capabilities.forcedToolChoice,
          requestedCategories: input.capabilities.requestedCategories,
          residentToolCount: input.capabilities.residentToolNames.length,
          droppedToolCount: input.capabilities.droppedToolNames.length,
          pageFaultCount: input.capabilities.pageFaults.length,
          pageFaults: input.capabilities.pageFaults,
        },
      }),
      ...(!isEmpty(input.capabilities.pageFaults)
        ? [
            agentRunPlanLedgerFactory.createEntry({
              source: 'recovery',
              action: `missing-capability-${input.recovery.missingCapability.action}`,
              reason: 'recovery planner selected a missing capability action',
              details: {
                action: input.recovery.missingCapability.action,
                pageFaults: input.capabilities.pageFaults,
              },
            }),
          ]
        : []),
      ...(input.recovery.staleEvidence.action === 'refresh-capability-context'
        ? [
            agentRunPlanLedgerFactory.createEntry({
              source: 'recovery',
              action: 'stale-evidence-refresh-capability-context',
              reason: 'capability evidence is stale after later capability activity',
              details: {
                action: input.recovery.staleEvidence.action,
                capabilityEvidenceSnapshot: input.capabilityEvidenceSnapshot,
              },
            }),
          ]
        : []),
    ]
  }
}

export interface BuildValidationRunPlanInput {
  requiresEvidence: boolean
  requiresValidation: boolean
  minimumActionIds: readonly string[]
}

export interface BuildAgentRunPlanInput
  extends Omit<PlanCapabilityRunInput, 'messages' | 'runProfile' | 'toolSchemaCharBudget'> {
  history: ModelMessage[]
  roleRuntime: AgentRuntimePlan
  requestedRunProfile: RunProfileSelectionId
  capabilityEvidenceSnapshot?: CapabilityEvidenceSnapshot
  toolSchemaBudgetScale?: number
}

class AgentRunPlanComposer {
  public buildValidation(input: BuildValidationRunPlanInput): ValidationRunPlan {
    return {
      evidenceRequired: input.requiresEvidence,
      minimumActionIds: [...new Set(input.minimumActionIds)],
      finishingGate: input.requiresValidation ? 'validate' : 'none',
    }
  }

  public build(input: BuildAgentRunPlanInput): AgentRunPlan {
    const intent = agentIntentPlanner.plan({
      messages: input.history,
      capabilityPorts: input.capabilityPorts,
    })
    const context = contextRunPlanner.plan({
      model: input.roleRuntime.model,
      contextWindow: input.roleRuntime.contextWindow,
      toolSchemaChars: input.toolSchemaChars,
      toolSchemaBudgetScale: input.toolSchemaBudgetScale,
    })
    const capabilities = capabilityRunPlanner.plan({
      ...input,
      messages: input.history,
      runProfile: input.roleRuntime.runProfile,
      toolSchemaCharBudget: context.toolSchemaCharBudget,
    })
    const recovery = recoveryRunPlanner.plan({
      forcedToolChoice: capabilities.forcedToolChoice,
      pageFaults: capabilities.pageFaults,
      requiresCapabilityEvidence: intent.requiresCapabilityEvidence,
      capabilityEvidenceSnapshot: input.capabilityEvidenceSnapshot,
    })
    const prompt = promptRunPlanner.build({
      runProfile: input.roleRuntime.runProfile,
      bootstrapReminder: capabilities.bootstrapReminder,
      pageFaults: capabilities.pageFaults,
      recovery,
    })
    const validation = this.buildValidation(intent)
    const ledger = agentRunPlanLedgerComposer.build({
      intent,
      context,
      capabilities,
      recovery,
      capabilityEvidenceSnapshot: input.capabilityEvidenceSnapshot,
    })

    return {
      id: `agent-run-plan:${input.turn}`,
      turn: input.turn,
      intent,
      runtime: input.roleRuntime,
      capabilities,
      context,
      prompt,
      recovery,
      validation,
      ledger,
    }
  }
}

const agentRunPlanComposer = new AgentRunPlanComposer()
const agentIntentPlanner = new AgentIntentPlanner()
const agentRunPlanLedgerComposer = new AgentRunPlanLedgerComposer()

export {
  AgentIntentPlanner,
  agentIntentPlanner,
  AgentRunPlanComposer,
  agentRunPlanComposer,
  AgentRunPlanLedgerComposer,
  agentRunPlanLedgerComposer,
}
