
import type { ApplySoloContextDegradeActionContext, ContextDegradeAction,SoloContextDegradeToolContext } from '../../types/loop.js'
import { resolveContextWorkingSetZoneCharBudget } from '../context/context-working-set-budget-governor'
import { resolveGovernanceSessionKey } from '../residency/session-key'
import { applyRunProfileToolExposure } from '../runner/run-profile'

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
      // 供应方确认超限后自动请求治理 epoch；无需模型调用或用户手动操作。
      // 绕过本地水位触发线，保留反空转和尾保护；没有实际回收时返回 false 交给下一级。
      // 键必须与编译面注册时用的那一个逐字相同：编译面对空会话 id 回落 `unknown-session`，
      // 这里原样传空串就查不到账本，这一级对无身份会话恒失效。
      const report = ctx.governanceSessions.requestEpoch(
        resolveGovernanceSessionKey(ctx.toolContext.sessionId),
        {
          modelWindowTokens: ctx.roleRuntime.contextWindow,
          source: 'overflow-recovery',
        }
      )
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
        maxToolSchemaCharsOverride: resolveContextWorkingSetZoneCharBudget(
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
