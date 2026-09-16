import { isNumber, toNullable } from '@velaros-ai/core'

import type {
  StreamTurnContextPayload,
  ToolLayerTelemetryMetrics,
  ToolSchemaTelemetryPayload,
} from '../../types/agent'
import type { ToolSurfaceProfileId } from '../../types/agent.js'
import type { BuildSoloRunProfileTelemetryInput, BuildSoloToolSchemaTelemetryInput, SoloToolAllocatorTelemetryPlan,SoloToolSchemaTelemetryContext } from '../../types/loop.js'

/**
 * 把宿主可能残缺的工具层指标收成一份形状完整的定值：四个计数取非负整数，
 * `toolsBlockCacheInvalidationRate` 夹进 0–1，`turnsPerCompletedTask` 取非负整数。
 * 后两项拿不到数字时给 `null` 而不是 0——「本会话还没有这个观测」和「实测就是零」在看板上是两回事，
 * 混成 0 会把缺席读成「缓存零失效」。
 */
function normalizeToolLayerMetrics(
  metrics?: LooseOptional<Partial<ToolLayerTelemetryMetrics>>
): ToolLayerTelemetryMetrics {
  return {
    enableToolsPerSession: Math.max(0, Math.floor(metrics?.enableToolsPerSession ?? 0)),
    dedupeHitCount: Math.max(0, Math.floor(metrics?.dedupeHitCount ?? 0)),
    invisibleToolCallCount: Math.max(0, Math.floor(metrics?.invisibleToolCallCount ?? 0)),
    confirmCardsPerSession: Math.max(0, Math.floor(metrics?.confirmCardsPerSession ?? 0)),
    toolsBlockCacheInvalidationRate: isNumber(metrics?.toolsBlockCacheInvalidationRate)
      ? Math.max(0, Math.min(1, metrics.toolsBlockCacheInvalidationRate))
      : null,
    turnsPerCompletedTask: isNumber(metrics?.turnsPerCompletedTask)
      ? Math.max(0, Math.floor(metrics.turnsPerCompletedTask))
      : null,
  }
}

/**
 * 算这一轮工具 schema 的省量遥测：拿当前 tool surface 档下的序列化字符数，比对同一批工具在基线档
 * （`direct`，即全量 schema）下的字符数，给出省下/多出的字符、除以 4 的 token 估算与省量百分比。
 * 当前档就是基线档时不再重复估一次，直接复用同一个数。
 * 两个估算回调任一缺席、或算不出有限数字，整条返回 `null`——宁可这轮没有遥测，也不报一个假的省量。
 */
function buildSoloToolSchemaTelemetry<TContext extends SoloToolSchemaTelemetryContext>(
  input: BuildSoloToolSchemaTelemetryInput<TContext>
): Nullable<ToolSchemaTelemetryPayload> {
  const currentProfile = input.toolContext.codingSession.getToolSurfaceProfile?.() ?? 'direct'
  const currentSerializedChars = input.estimateCurrentSerializedChars?.(
    input.toolContext,
    input.allowedTools
  )
  const baselineProfile: ToolSurfaceProfileId = 'direct'
  const baselineSerializedChars =
    currentProfile === baselineProfile
      ? currentSerializedChars
      : input.estimateBaselineSerializedChars?.(
          input.toolContext,
          baselineProfile,
          input.allowedTools
        )

  if (!isNumber(currentSerializedChars) || !isNumber(baselineSerializedChars)) return null

  const savedChars = Math.max(0, baselineSerializedChars - currentSerializedChars)
  const overheadChars = Math.max(0, currentSerializedChars - baselineSerializedChars)
  const currentEstimatedTokens = Math.ceil(currentSerializedChars / 4)
  const baselineEstimatedTokens = Math.ceil(baselineSerializedChars / 4)

  return {
    currentProfile,
    baselineProfile,
    currentSerializedChars,
    baselineSerializedChars,
    savedChars,
    overheadChars,
    savedPercent:
      baselineSerializedChars > 0
        ? Math.round((savedChars / baselineSerializedChars) * 1000) / 10
        : 0,
    currentEstimatedTokens,
    baselineEstimatedTokens,
    savedTokens: Math.max(0, baselineEstimatedTokens - currentEstimatedTokens),
  }
}

/**
 * 把本轮 run profile 的裁剪结果收成遥测：被丢掉的工具先记总数，名单只留前 40 条
 * （防止一个大工具面把单条遥测撑爆，完整条数仍在 `droppedToolCount` 里），
 * 再数出有多少段提示词是被 run profile 裁掉的（按 skip 理由里含 `trimmed by run profile` 计）。
 * `skippedPromptSegments` 只用来算这个计数，本身不进结果。
 */
function buildSoloRunProfileTelemetry(
  input: BuildSoloRunProfileTelemetryInput
): NonNullable<StreamTurnContextPayload['runProfileTelemetry']> {
  const { skippedPromptSegments, ...telemetry } = input
  return {
    ...telemetry,
    droppedToolCount: telemetry.droppedTools.length,
    droppedTools: telemetry.droppedTools.slice(0, 40),
    promptTrimmedSegmentCount: skippedPromptSegments.filter((segment) =>
      segment.reason.includes('trimmed by run profile')
    ).length,
  }
}

/**
 * 拼工具分配器这一轮的遥测。plan 与 toolLayerMetrics 都缺席时返回 `null`（本轮压根没走分配器，
 * 不产条目）；只有指标没有 plan 时给一份「分配器未被调用」的零值骨架再挂上指标；有 plan 则记下
 * 顾问是否被调用及其消息/错误、熔断是否跳闸、授予的类别与工具数、被拒的请求。
 * 指标优先取显式传入的 `toolLayerMetrics`，缺席才回落到 plan 自带的那份。
 */
function buildSoloToolAllocatorTelemetry(
  plan: Nullable<SoloToolAllocatorTelemetryPlan>,
  toolLayerMetrics?: LooseOptional<Partial<ToolLayerTelemetryMetrics>>
): StreamTurnContextPayload['toolAllocatorTelemetry'] {
  const metrics = normalizeToolLayerMetrics(toolLayerMetrics ?? plan?.toolLayerMetrics)
  if (!plan && !toolLayerMetrics) return null

  if (!plan) return {
      advisorCalled: false,
      advisorMessage: null,
      advisorError: null,
      fuseTripped: false,
      fuseMessage: null,
      grantedCategoryIds: [],
      grantedToolCount: 0,
      deniedRequests: [],
      ...metrics,
    }

  return {
    advisorCalled: plan.advisor.called,
    advisorMessage: toNullable(plan.advisor.message),
    advisorError: toNullable(plan.advisor.error),
    fuseTripped: plan.fuse.tripped,
    fuseMessage: toNullable(plan.fuse.message),
    grantedCategoryIds: plan.grantedCategoryIds,
    grantedToolCount: plan.grantedToolNames.length,
    deniedRequests: plan.deniedRequests,
    ...metrics,
  }
}

export {
  buildSoloRunProfileTelemetry,
  buildSoloToolAllocatorTelemetry,
  buildSoloToolSchemaTelemetry,
}
