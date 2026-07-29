import type { LanguageModel } from 'ai'

import { resolveSummarizerLanguageModel, summarizeOlderHistory } from './ContextSemanticSummarizer'
import type { SemanticHistorySummarizeFn } from './LoopHistory'
import type {
  AgentModelProvider,
  AgentModelRequestOptions,
  ResolvedAgentModelRuntime,
} from './model'

function withSessionRuntimeContext(
  options: LooseOptional<AgentModelRequestOptions>,
  sessionId?: string
): AgentModelRequestOptions {
  return {
    ...(options ?? {}),
    runtimeContext: {
      ...(options?.runtimeContext ?? {}),
      sessionId,
    },
  }
}

interface SemanticSummarizerRoleRuntime {
  provider: AgentModelProvider
  model: string
  modelRequestOptions?: AgentModelRequestOptions
}

interface CreateSemanticHistorySummarizerInput {
  roleRuntime: SemanticSummarizerRoleRuntime
  sessionId?: string
  /** Optional product-owned resolver; Kernel never inspects provider config or auth. */
  resolveCandidate?: () => Promise<LooseOptional<ResolvedAgentModelRuntime>>
}

function createSemanticHistorySummarizer(
  input: CreateSemanticHistorySummarizerInput
): SemanticHistorySummarizeFn {
  const { roleRuntime, sessionId } = input
  return async (summaryInput) =>
    summarizeOlderHistory({
      model: await resolveSummarizerLanguageModel({
        mainModel: (): LanguageModel =>
          roleRuntime.provider(
            roleRuntime.model,
            withSessionRuntimeContext(roleRuntime.modelRequestOptions, sessionId)
          ),
        resolveCandidate: input.resolveCandidate,
      }),
      olderMessages: summaryInput.olderMessages,
      ruleSummary: summaryInput.ruleSummary,
      summaryGuidance: summaryInput.summaryGuidance,
      targetChars: summaryInput.targetChars,
      signal: summaryInput.signal,
      modelRequestOptions: roleRuntime.modelRequestOptions,
    })
}

export { createSemanticHistorySummarizer, withSessionRuntimeContext }
export type { CreateSemanticHistorySummarizerInput, SemanticSummarizerRoleRuntime }
