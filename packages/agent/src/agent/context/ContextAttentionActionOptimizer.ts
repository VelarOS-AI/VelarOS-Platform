import { isNumber,isPresent } from '@velaros-ai/core'

import type {
  ContextAttentionActionCandidate,
  ContextAttentionDecision,
  ContextAttentionLedgerAction,
  ContextAttentionRouterMode,
  ContextAttentionTraceAction,
} from './ContextAttentionPolicyEngine'

export interface ContextAttentionRouteOptimization {
  mode: ContextAttentionRouterMode
  strategy: 'trace-only' | 'guarded-policy' | 'active-budget-greedy'
  budgetTokens: Nullable<number>
  estimatedTokens: number
  overBudgetTokens: number
  selectedDowngrades: number
}

export interface ContextAttentionActionOptimizerInput {
  decisions: readonly ContextAttentionDecision[]
  mode: ContextAttentionRouterMode
  budgetTokens?: LooseOptional<number>
}

export interface ContextAttentionActionOptimizerResult {
  decisions: ContextAttentionDecision[]
  optimization: ContextAttentionRouteOptimization
}

interface ContextAttentionDowngradeCandidate {
  index: number
  decision: ContextAttentionDecision
  savingTokens: number
  expectedValue: number
}

function estimateActionTokens(action: ContextAttentionTraceAction, chars: number): number {
  switch (action) {
    case 'drop':
    case 'skip':
      return 0
    case 'handle':
      return 180
    case 'summarize':
      return Math.min(Math.max(1, Math.ceil(chars / 12)), 220)
    default:
      return Math.max(1, Math.ceil(chars / 4))
  }
}

function estimateDecisionTokens(decision: ContextAttentionDecision): number {
  return estimateActionTokens(decision.action, decision.chars)
}

function isDowngradeAction(decision: ContextAttentionDecision): boolean {
  return decision.action === 'handle' || decision.action === 'summarize' || decision.action === 'drop'
}

function resolveStrategy(mode: ContextAttentionRouterMode): ContextAttentionRouteOptimization['strategy'] {
  switch (mode) {
    case 'shadow':
      return 'trace-only'
    case 'active':
      return 'active-budget-greedy'
    case 'guarded':
      return 'guarded-policy'
  }
}

function canSafelyDowngrade(decision: ContextAttentionDecision): boolean {
  return (
    !decision.hardRetained &&
    !decision.features.toolFailureReason &&
    !decision.features.statefulToolResult &&
    !decision.features.currentTaskEvidence &&
    !decision.features.explicitlyMentioned
  )
}

function withOptimizedAction(input: {
  decision: ContextAttentionDecision
  action: ContextAttentionTraceAction
  ledgerAction: ContextAttentionLedgerAction
  reason: string
}): ContextAttentionDecision {
  return {
    ...input.decision,
    action: input.action,
    ledgerAction: input.ledgerAction,
    reason: `${input.reason}; ${input.decision.reason}`,
  }
}

function estimateActionRisk(
  decision: ContextAttentionDecision,
  action: ContextAttentionTraceAction
): number {
  if (action === 'inline' || action === 'retain') return 0
  if (!canSafelyDowngrade(decision)) return 1
  if (action === 'handle' && !decision.features.recoverable) return 1
  const informationLoss = 1 - retainFactor(action)
  const unsafeDrop =
    action === 'drop' &&
    decision.zone !== 'retrieval-index' &&
    decision.zone !== 'diagnostics' &&
    decision.zone !== 'recall'
  const baseRisk =
    unsafeDrop
      ? 0.7
      : action === 'summarize'
        ? 0.2
        : action === 'drop'
          ? 0.35
          : 0.15
  const evidenceLoss = decision.routingScores.evidenceScore * informationLoss * 0.45
  const exactnessLoss = decision.routingScores.exactnessRiskScore * informationLoss * 0.65
  const safetyDiscount = decision.routingScores.demotionSafetyScore * 0.25
  const staleDiscount = decision.routingScores.stalenessScore * 0.12

  return Math.max(
    0,
    Math.min(1, baseRisk + evidenceLoss + exactnessLoss - safetyDiscount - staleDiscount)
  )
}

function retainFactor(action: ContextAttentionTraceAction): number {
  switch (action) {
    case 'retain':
    case 'inline':
      return 1
    case 'summarize':
      return 0.72
    case 'handle':
      return 0.42
    case 'drop':
    case 'skip':
      return 0
    case 'estimate':
      return 0.2
  }
}

function buildActionCandidate(
  decision: ContextAttentionDecision,
  action: ContextAttentionTraceAction,
  ledgerAction: ContextAttentionLedgerAction,
  reason: string
): ContextAttentionActionCandidate {
  const estimatedTokens = estimateActionTokens(action, decision.chars)
  const utility =
    decision.routingScores.needScore * retainFactor(action) +
    decision.routingScores.evidenceScore * retainFactor(action) * 0.35 +
    decision.routingScores.demotionSafetyScore * (1 - retainFactor(action)) * 0.12 +
    (action === 'handle' && decision.features.recoverable ? 0.08 : 0)
  const risk = estimateActionRisk(decision, action)
  const expectedValue = utility - risk - estimatedTokens / 20_000

  return {
    action,
    ledgerAction,
    estimatedTokens,
    utility: Math.round(utility * 1000) / 1000,
    risk: Math.round(risk * 1000) / 1000,
    expectedValue: Math.round(expectedValue * 1000) / 1000,
    reason,
  }
}

function dedupeCandidates(
  candidates: readonly ContextAttentionActionCandidate[]
): ContextAttentionActionCandidate[] {
  const byAction = new Map<ContextAttentionTraceAction, ContextAttentionActionCandidate>()
  candidates.forEach((candidate) => {
    const current = byAction.get(candidate.action)
    if (!current || candidate.expectedValue > current.expectedValue) byAction.set(candidate.action, candidate)
  })

  return [...byAction.values()].sort(
    (left, right) => right.expectedValue - left.expectedValue || left.estimatedTokens - right.estimatedTokens
  )
}

function buildActionCandidates(decision: ContextAttentionDecision): ContextAttentionActionCandidate[] {
  const candidates: ContextAttentionActionCandidate[] = [
    buildActionCandidate(decision, decision.action, decision.ledgerAction, 'current policy action'),
  ]

  if (decision.action !== 'inline' && decision.action !== 'retain') {
    candidates.push(buildActionCandidate(decision, 'inline', 'inline', 'full inline resident action'))
  }

  if (canSafelyDowngrade(decision)) {
    if (decision.features.recoverable && decision.zone === 'tool-payloads') {
      candidates.push(
        buildActionCandidate(decision, 'handle', 'reference', 'recoverable handle action')
      )
    }

    if (decision.zone === 'recent-turns' && decision.chars >= 1_200) {
      candidates.push(
        buildActionCandidate(decision, 'summarize', 'summary', 'conversation summary action')
      )
    }

    if (
      decision.zone === 'retrieval-index' ||
      decision.zone === 'diagnostics' && decision.features.expired ||
      decision.zone === 'recall'
    ) {
      candidates.push(buildActionCandidate(decision, 'drop', 'drop', 'safe evict action'))
    }
  }

  return dedupeCandidates(candidates)
}

function withActionCandidates(decision: ContextAttentionDecision): ContextAttentionDecision {
  return {
    ...decision,
    actionCandidates: buildActionCandidates(decision),
  }
}

function selectDowngradeDecision(decision: ContextAttentionDecision): Nullable<{
  decision: ContextAttentionDecision
  savingTokens: number
  expectedValue: number
}> {
  if (!canSafelyDowngrade(decision)) return null

  const currentTokens = estimateDecisionTokens(decision)
  const candidate = (decision.actionCandidates ?? [])
    .filter((entry) => entry.estimatedTokens < currentTokens)
    .sort(
      (left, right) =>
        right.expectedValue - left.expectedValue ||
        currentTokens - right.estimatedTokens - (currentTokens - left.estimatedTokens)
    )[0]
  if (!candidate) return null

  return {
    decision: withOptimizedAction({
      decision,
      action: candidate.action,
      ledgerAction: candidate.ledgerAction,
      reason: `active optimizer selected ${candidate.action} by expected value`,
    }),
    savingTokens: currentTokens - candidate.estimatedTokens,
    expectedValue: candidate.expectedValue,
  }
}

function collectDowngradeCandidates(
  decisions: readonly ContextAttentionDecision[]
): ContextAttentionDowngradeCandidate[] {
  return decisions
    .map((decision, index): Nullable<ContextAttentionDowngradeCandidate> => {
      const downgraded = selectDowngradeDecision(decision)
      if (!downgraded) return null

      const savingTokens = downgraded.savingTokens
      if (savingTokens <= 0) return null

      return {
        index,
        decision: downgraded.decision,
        savingTokens,
        expectedValue: downgraded.expectedValue,
      }
    })
    .filter(isPresent)
    .sort(
      (left, right) =>
        right.savingTokens - left.savingTokens ||
        right.expectedValue - left.expectedValue ||
        left.decision.score - right.decision.score
    )
}

export class ContextAttentionActionOptimizer {
  public optimize(input: ContextAttentionActionOptimizerInput): ContextAttentionActionOptimizerResult {
    const decisions = input.decisions.map(withActionCandidates)
    const initialEstimatedTokens = decisions.reduce(
      (total, decision) => total + estimateDecisionTokens(decision),
      0
    )
    const budgetTokens = isNumber(input.budgetTokens) ? Math.max(0, input.budgetTokens) : null
    let overBudgetTokens = isNumber(budgetTokens)
      ? Math.max(0, initialEstimatedTokens - budgetTokens)
      : 0

    if (input.mode === 'active' && overBudgetTokens > 0) {
      for (const candidate of collectDowngradeCandidates(decisions)) {
        if (overBudgetTokens <= 0) break
        decisions[candidate.index] = candidate.decision
        overBudgetTokens = Math.max(0, overBudgetTokens - candidate.savingTokens)
      }
    }

    const estimatedTokens = decisions.reduce(
      (total, decision) => total + estimateDecisionTokens(decision),
      0
    )

    return {
      decisions,
      optimization: {
        mode: input.mode,
        strategy: resolveStrategy(input.mode),
        budgetTokens,
        estimatedTokens,
        overBudgetTokens: isNumber(budgetTokens) ? Math.max(0, estimatedTokens - budgetTokens) : 0,
        selectedDowngrades: decisions.filter(isDowngradeAction).length,
      },
    }
  }
}
