import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'

export type ContextAttentionOutcomeSignal =
  | 'recalled'
  | 'missing-context'
  | 'verification-pass'
  | 'verification-fail'
  | 'manual-pin'
  | 'manual-unpin'

export interface ContextAttentionOutcomeInput {
  routeId?: LooseOptional<string>
  blockId: string
  action: ChatContextDebugTraceEntry['action']
  signal: ContextAttentionOutcomeSignal
  timestamp?: LooseOptional<number>
  detail?: LooseOptional<Record<string, unknown>>
}

export interface ContextAttentionBlockOutcome {
  blockId: string
  lastAction: ChatContextDebugTraceEntry['action']
  recallCount: number
  missingContextCount: number
  verificationPasses: number
  verificationFailures: number
  manualPins: number
  manualUnpins: number
  retainedUtility: number
  lastUpdatedAt: number
}

export interface ContextAttentionOutcomeSnapshot {
  schemaVersion: 1
  blocks: ContextAttentionBlockOutcome[]
}

function clampUtility(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, Math.round(value * 1000) / 1000))
}

function createOutcome(input: ContextAttentionOutcomeInput): ContextAttentionBlockOutcome {
  return {
    blockId: input.blockId,
    lastAction: input.action,
    recallCount: 0,
    missingContextCount: 0,
    verificationPasses: 0,
    verificationFailures: 0,
    manualPins: 0,
    manualUnpins: 0,
    retainedUtility: 0,
    lastUpdatedAt: input.timestamp ?? Date.now(),
  }
}

function applySignal(
  outcome: ContextAttentionBlockOutcome,
  input: ContextAttentionOutcomeInput
): ContextAttentionBlockOutcome {
  let utilityDelta = 0

  switch (input.signal) {
    case 'recalled':
      outcome.recallCount += 1
      utilityDelta += input.action === 'handle' || input.action === 'summarize' ? 0.18 : 0.08
      break
    case 'missing-context':
      outcome.missingContextCount += 1
      utilityDelta -= 0.35
      break
    case 'verification-pass':
      outcome.verificationPasses += 1
      utilityDelta += 0.22
      break
    case 'verification-fail':
      outcome.verificationFailures += 1
      utilityDelta -= 0.24
      break
    case 'manual-pin':
      outcome.manualPins += 1
      utilityDelta += 0.3
      break
    case 'manual-unpin':
      outcome.manualUnpins += 1
      utilityDelta -= 0.18
      break
  }

  outcome.lastAction = input.action
  outcome.lastUpdatedAt = input.timestamp ?? Date.now()
  outcome.retainedUtility = clampUtility(outcome.retainedUtility + utilityDelta)
  return outcome
}

export class ContextAttentionOutcomeRecorder {
  private readonly outcomesByBlockId = new Map<string, ContextAttentionBlockOutcome>()

  public record(input: ContextAttentionOutcomeInput): ContextAttentionBlockOutcome {
    const outcome = this.outcomesByBlockId.get(input.blockId) ?? createOutcome(input)
    const nextOutcome = applySignal(outcome, input)
    this.outcomesByBlockId.set(input.blockId, nextOutcome)
    return { ...nextOutcome }
  }

  public snapshot(): ContextAttentionOutcomeSnapshot {
    return {
      schemaVersion: 1,
      blocks: [...this.outcomesByBlockId.values()]
        .map((outcome) => ({ ...outcome }))
        .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt || left.blockId.localeCompare(right.blockId)),
    }
  }
}
