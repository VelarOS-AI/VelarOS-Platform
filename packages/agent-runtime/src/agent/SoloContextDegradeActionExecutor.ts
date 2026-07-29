import type { ModelMessage } from 'ai'

import type { ScopedLog } from '@velaros-ai/core/logger'
import type { ToolDescriptor } from '@velaros-ai/core/types'
import type { EstimateContextUsageOptions } from '@velaros-ai/core/utils/contextUsage'

import { type ContextWorkingSetBudgetAllocation, ContextWorkingSetBudgetGovernor } from './context'
import type { ContextDegradeAction } from './ContextDegradeLadder'
import type {
  DropHistoryToFallbackArgs,
  DropHistoryToFallbackResult,
  EmergencyCompactArgs,
  EmergencyCompactResult,
  SemanticCompactArgs,
  SemanticCompactResult,
  SemanticHistorySummarizeFn,
} from './LoopHistory'
import { applyRunProfileToolExposure } from './RunProfile'

interface SoloContextDegradeToolContext {
  setCurrentVisibleToolNames: (toolNames: string[]) => void
  codingSession: {
    getToolUsageScores?: () => Readonly<Record<string, number>>
  }
}

interface SoloContextDegradeToolRegistry<TContext> {
  estimateToolSerializedCharsByName?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => Record<string, number>
}

interface SoloContextDegradeHistoryHelper<TEvents> {
  emergencyCompact(input: EmergencyCompactArgs<TEvents>): EmergencyCompactResult
  semanticCompact(input: SemanticCompactArgs<TEvents>): Promise<SemanticCompactResult>
  dropHistoryToFallback(input: DropHistoryToFallbackArgs): DropHistoryToFallbackResult
}

interface ApplySoloContextDegradeActionContext<
  TContext extends SoloContextDegradeToolContext = SoloContextDegradeToolContext,
  TEvents = unknown,
> {
  loopHistory: SoloContextDegradeHistoryHelper<TEvents>
  toolRegistry: SoloContextDegradeToolRegistry<TContext>
  log: Pick<ScopedLog, 'warn'>
  roleRuntime: { model: string }
  systemPrompt: string
  history: ModelMessage[]
  turn: number
  events: TEvents
  contextUsageOptions: EstimateContextUsageOptions
  baseAllowedTools: string[]
  protectedTools: string[]
  enabledToolDescriptors: ToolDescriptor[]
  zoneAllocation: ContextWorkingSetBudgetAllocation
  toolContext: TContext
  currentAllowedTools: string[]
  summarize: SemanticHistorySummarizeFn
  signal: AbortSignal
  onToolsNarrowed: (next: string[]) => void
}

/**
 * 执行一级 solo 缺页降级动作；返回 true 表示该级真正改变了状态（可以重试本轮），
 * 返回 false 表示该级无法腾出空间，调用方应继续走下一级阶梯。
 */
async function applySoloContextDegradeAction<
  TContext extends SoloContextDegradeToolContext,
  TEvents,
>(
  action: ContextDegradeAction,
  ctx: ApplySoloContextDegradeActionContext<TContext, TEvents>
): Promise<boolean> {
  switch (action.kind) {
    case 'compact-soft':
    case 'compact-hard': {
      const recovery = ctx.loopHistory.emergencyCompact({
        mode: 'solo',
        model: ctx.roleRuntime.model,
        systemPrompt: ctx.systemPrompt,
        history: ctx.history,
        turn: ctx.turn,
        events: ctx.events,
        contextUsageOptions: ctx.contextUsageOptions,
        targetPercent: action.targetPercent,
      })
      if (recovery.recovered) {
        ctx.log.warn('solo loop recovered context overflow via compaction', {
          turn: ctx.turn,
          level: action.level,
          targetPercent: action.targetPercent,
          removedMessages: recovery.removedMessages,
          percentBefore: recovery.percentBefore,
          percentAfter: recovery.percentAfter,
        })
      }
      return recovery.recovered
    }
    case 'semantic-compact': {
      const semantic = await ctx.loopHistory.semanticCompact({
        mode: 'solo',
        model: ctx.roleRuntime.model,
        systemPrompt: ctx.systemPrompt,
        history: ctx.history,
        turn: ctx.turn,
        events: ctx.events,
        contextUsageOptions: ctx.contextUsageOptions,
        summarize: ctx.summarize,
        signal: ctx.signal,
      })
      return semantic.compacted
    }
    case 'narrow-tools': {
      const profile = action.narrowToProfile ?? 'compact'
      const narrowed = applyRunProfileToolExposure(ctx.baseAllowedTools, profile, {
        protectedTools: ctx.protectedTools,
        toolDescriptors: ctx.enabledToolDescriptors,
        toolSchemaChars: ctx.toolRegistry.estimateToolSerializedCharsByName?.(
          ctx.toolContext,
          ctx.baseAllowedTools
        ),
        maxToolSchemaCharsOverride: ContextWorkingSetBudgetGovernor.resolveZoneCharBudget(
          ctx.zoneAllocation,
          'tool-schemas'
        ),
        toolUsageScores: ctx.toolContext.codingSession.getToolUsageScores?.(),
      })
      if (narrowed.allowedTools.length >= ctx.currentAllowedTools.length) return false

      ctx.toolContext.setCurrentVisibleToolNames(narrowed.allowedTools)
      ctx.onToolsNarrowed(narrowed.allowedTools)
      ctx.log.warn('solo loop narrowed tools for context overflow', {
        turn: ctx.turn,
        level: action.level,
        profile,
        before: ctx.currentAllowedTools.length,
        after: narrowed.allowedTools.length,
      })
      return true
    }
    case 'drop-history': {
      const dropped = ctx.loopHistory.dropHistoryToFallback({
        mode: 'solo',
        history: ctx.history,
        turn: ctx.turn,
      })
      return dropped.dropped
    }
    default:
      return false
  }
}

export { applySoloContextDegradeAction }
export type {
  ApplySoloContextDegradeActionContext,
  SoloContextDegradeHistoryHelper,
  SoloContextDegradeToolContext,
  SoloContextDegradeToolRegistry,
}
