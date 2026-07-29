import type { ModelMessage } from 'ai'

import type { EstimateContextUsageOptions } from '@velaros-ai/core/utils/contextUsage'

import type { AgentHistoryToolContext } from './history'
import type {
  PrepareAgentLoopHistoryArgs,
  PrepareAgentLoopHistoryResult,
  SemanticCompactArgs,
  SemanticCompactResult,
  SemanticHistorySummarizeFn,
} from './LoopHistory'

interface SoloPromptHistoryHelper<TEvents, TToolContext extends AgentHistoryToolContext> {
  prepareHistory(
    input: PrepareAgentLoopHistoryArgs<TEvents, TToolContext>
  ): PrepareAgentLoopHistoryResult
  shouldAttemptSemanticCompaction(currentPercent: number, historyLength: number): boolean
  hasSemanticPreSummaryCache(history: ModelMessage[]): boolean
  warmSemanticPreSummary(input: SemanticCompactArgs<TEvents>): Promise<void>
  semanticCompact(input: SemanticCompactArgs<TEvents>): Promise<SemanticCompactResult>
}

interface PrepareSoloPromptHistoryInput<
  TEvents,
  TToolContext extends AgentHistoryToolContext,
> {
  loopHistory: SoloPromptHistoryHelper<TEvents, TToolContext>
  model: string
  systemPrompt: string
  history: ModelMessage[]
  turn: number
  events: TEvents
  contextUsageOptions: EstimateContextUsageOptions
  toolContext: TToolContext
  summarize: SemanticHistorySummarizeFn
  signal: AbortSignal
}

interface PrepareSoloPromptHistoryResult {
  preparedHistory: PrepareAgentLoopHistoryResult
  predictedInputTokens: number
}

async function prepareSoloPromptHistory<
  TEvents,
  TToolContext extends AgentHistoryToolContext,
>(
  input: PrepareSoloPromptHistoryInput<TEvents, TToolContext>
): Promise<PrepareSoloPromptHistoryResult> {
  const preparedHistory = input.loopHistory.prepareHistory({
    mode: 'solo',
    model: input.model,
    systemPrompt: input.systemPrompt,
    history: input.history,
    turn: input.turn,
    events: input.events,
    contextUsageOptions: input.contextUsageOptions,
    toolContext: input.toolContext,
  })

  let predictedInputTokens = preparedHistory.estimate.estimatedTokens

  if (preparedHistory.semanticPreSummaryArmed && !input.loopHistory.hasSemanticPreSummaryCache(input.history)) {
    void input.loopHistory
      .warmSemanticPreSummary({
        mode: 'solo',
        model: input.model,
        systemPrompt: input.systemPrompt,
        history: input.history,
        turn: input.turn,
        contextUsageOptions: input.contextUsageOptions,
        summarize: input.summarize,
        signal: input.signal,
      })
      .catch(() => undefined)
  }

  if (
    input.loopHistory.shouldAttemptSemanticCompaction(
      preparedHistory.estimate.percent,
      input.history.length
    )
  ) {
    const { loopHistory, ...semanticCompactInput } = input
    const semantic = await loopHistory.semanticCompact({
      ...semanticCompactInput,
      mode: 'solo',
    })
    if (semantic.compacted) {
      predictedInputTokens = semantic.estimatedTokensAfter
    }
  }

  return { preparedHistory, predictedInputTokens }
}

export { prepareSoloPromptHistory }
export type {
  PrepareSoloPromptHistoryInput,
  PrepareSoloPromptHistoryResult,
  SoloPromptHistoryHelper,
}
