import type { ScopedLog } from '@velaros-ai/core/logger'
import type { ToolDescriptor } from '@velaros-ai/core/types'

import {
  type ContextGovernanceSessionRegistry,
  type ContextWorkingSetBudgetAllocation,
  ContextWorkingSetBudgetGovernor,
} from './context'
import type { ContextDegradeAction } from './ContextDegradeLadder'
import { applyRunProfileToolExposure } from './RunProfile'

interface SoloContextDegradeToolContext {
  sessionId?: LooseOptional<string>
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

interface ApplySoloContextDegradeActionContext<
  TContext extends SoloContextDegradeToolContext = SoloContextDegradeToolContext,
> {
  /** 治理会话登记处：`govern-epoch` 级的落点（缺页 = 强开一次 epoch）。 */
  governanceSessions: ContextGovernanceSessionRegistry
  toolRegistry: SoloContextDegradeToolRegistry<TContext>
  log: Pick<ScopedLog, 'warn'>
  roleRuntime: { model: string; contextWindow?: LooseOptional<number> }
  turn: number
  baseAllowedTools: string[]
  protectedTools: string[]
  enabledToolDescriptors: ToolDescriptor[]
  zoneAllocation: ContextWorkingSetBudgetAllocation
  toolContext: TContext
  currentAllowedTools: string[]
  onToolsNarrowed: (next: string[]) => void
}

/**
 * 执行一级 solo 缺页降级动作；返回 true 表示该级真正改变了状态（可以重试本轮），
 * 返回 false 表示该级无法腾出空间，调用方应继续走下一级阶梯。
 */
function applySoloContextDegradeAction<TContext extends SoloContextDegradeToolContext>(
  action: ContextDegradeAction,
  ctx: ApplySoloContextDegradeActionContext<TContext>
): boolean {
  switch (action.kind) {
    case 'govern-epoch': {
      // 缺页 = 请求治理器强开一次 epoch。语义与模型调 context:distill / 宿主 compact_session 一致：
      // 绕过水位触发线，但反空转、尾保护、达标即停一条不减——压不下去时返回 false 交给下一级。
      const report = ctx.governanceSessions.requestEpoch(ctx.toolContext.sessionId, {
        modelWindowTokens: ctx.roleRuntime.contextWindow,
      })
      if (report?.applied) {
        ctx.log.warn('solo loop recovered context overflow via governance epoch', {
          turn: ctx.turn,
          level: action.level,
          epoch: report.epoch,
          savingPercent: report.savingPercent,
          beforePercent: report.beforePercent,
          afterPercent: report.afterPercent,
        })
      }
      return !!report?.applied
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
    default:
      return false
  }
}

export { applySoloContextDegradeAction }
export type {
  ApplySoloContextDegradeActionContext,
  SoloContextDegradeToolContext,
  SoloContextDegradeToolRegistry,
}
