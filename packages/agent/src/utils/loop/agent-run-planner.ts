
import { isEmpty } from '@velaros-ai/core'

import type { AgentIntentDomain, AgentIntentPlan, AgentRunPlan, AgentRunPlanLedgerEntry, AgentRunPlanLedgerRecorder, BuildAgentRunPlanInput,BuildAgentRunPlanLedgerInput, PlanAgentIntentInput } from '../../types/loop.js'

import { planCapabilityRun } from './capability-run-planner'
import {
  detectAgentIntentSignals,
  extractLatestUserTextFromMessages,
  isLowSignalIntentText,
  normalizeIntentText,
} from './intent-signals'
import { buildPromptRunPlan, planContextRun, planRecoveryRun } from './runtime-run-planner'

/** 从这轮历史里认最后一条用户消息的意图：命中哪些领域、要不要证据、要不要发现工具；话太短或没信息量就直接判低信号。 */
function planAgentIntent(input: PlanAgentIntentInput): AgentIntentPlan {
  const latestUserText = normalizeIntentText(
    extractLatestUserTextFromMessages(input.messages) ?? ''
  )
  if (isLowSignalIntentText(latestUserText)) return createLowSignalAgentIntent(latestUserText)

  const signals = detectAgentIntentSignals(latestUserText, input.capabilityPorts, {
    scopeId: input.capabilityScopeId,
  })
  const domains: AgentIntentDomain[] = signals.domains.map((domain) => domain.id)
  const requiresCapabilityEvidence =
    signals.requiresEvidence || signals.requiresMutation || signals.requiresValidation

  return {
    latestUserText,
    domains,
    complexity: resolveAgentIntentComplexity(domains),
    confidence: domains.includes('unknown') || isEmpty(domains) ? 'low' : 'medium',
    requiresCapabilityEvidence,
    requiresToolDiscovery: !isEmpty(domains),
  }
}

/** 把一次意图判定写成一条账目；账目由入参的账本工厂建，这里只填来源、动作、理由与细节。 */
function buildAgentIntentLedger(
  intent: AgentIntentPlan,
  ledgerFactory: AgentRunPlanLedgerRecorder
): AgentRunPlanLedgerEntry[] {
  return [
    ledgerFactory.createEntry({
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

/** 低信号意图的定型结果：不认领域、不要证据、也不发现工具。 */
function createLowSignalAgentIntent(latestUserText: string): AgentIntentPlan {
  return {
    latestUserText,
    domains: [],
    complexity: 'low',
    confidence: 'low',
    requiresCapabilityEvidence: false,
    requiresToolDiscovery: false,
  }
}

/** 按命中的领域数判复杂度：没有是 low，一个是单领域，多个是跨领域。 */
function resolveAgentIntentComplexity(domains: readonly AgentIntentDomain[]): AgentIntentPlan['complexity'] {
  if (isEmpty(domains)) return 'low'
  return domains.length === 1 ? 'single-domain' : 'multi-domain'
}

/** 把这轮各家计划记成一串账目：意图、上下文分区、能力换入各一条，有缺页或证据过期时再各补一条恢复账。 */
function buildAgentRunPlanLedger(input: BuildAgentRunPlanLedgerInput): AgentRunPlanLedgerEntry[] {
  return [
    ...buildAgentIntentLedger(input.intent, input.ledgerFactory),
    input.ledgerFactory.createEntry({
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
    input.ledgerFactory.createEntry({
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
          input.ledgerFactory.createEntry({
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
          input.ledgerFactory.createEntry({
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

/** 排这一轮的总计划：意图 → 上下文预算 → 能力换入 → 恢复策略 → 提示词，最后连同账目一起封成 AgentRunPlan。 */
function buildAgentRunPlan(input: BuildAgentRunPlanInput): AgentRunPlan {
  const intent = planAgentIntent({
    messages: input.history,
    capabilityPorts: input.capabilityPorts,
    capabilityScopeId: input.capabilityScopeId,
  })
  const context = planContextRun({
    model: input.roleRuntime.model,
    contextWindow: input.roleRuntime.contextWindow,
    toolSchemaChars: input.toolSchemaChars,
    toolSchemaBudgetScale: input.toolSchemaBudgetScale,
  })
  const capabilities = planCapabilityRun({
    ...input,
    messages: input.history,
    runProfile: input.roleRuntime.runProfile,
    toolSchemaCharBudget: context.toolSchemaCharBudget,
  })
  const recovery = planRecoveryRun({
    forcedToolChoice: capabilities.forcedToolChoice,
    pageFaults: capabilities.pageFaults,
    requiresCapabilityEvidence: intent.requiresCapabilityEvidence,
    capabilityEvidenceSnapshot: input.capabilityEvidenceSnapshot,
  })
  const prompt = buildPromptRunPlan({
    runProfile: input.roleRuntime.runProfile,
    bootstrapReminder: capabilities.bootstrapReminder,
    pageFaults: capabilities.pageFaults,
    recovery,
  })
  const ledger = buildAgentRunPlanLedger({
    intent,
    context,
    capabilities,
    recovery,
    capabilityEvidenceSnapshot: input.capabilityEvidenceSnapshot,
    ledgerFactory: input.ledgerFactory,
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
    ledger,
  }
}

export {
  buildAgentIntentLedger,
  buildAgentRunPlan,
  buildAgentRunPlanLedger,
  planAgentIntent,
}
