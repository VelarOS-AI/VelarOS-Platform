import { isNumber, toNullable } from '@velaros-ai/core'
import type {
  RunProfileId,
  StreamTurnContextPayload,
  ToolCategoryId,
  ToolLayerTelemetryMetrics,
  ToolSchemaTelemetryPayload,
  ToolSurfaceProfileId,
} from '@velaros-ai/core/types'

interface SoloToolSchemaTelemetryContext {
  codingSession: {
    getToolSurfaceProfile: () => ToolSurfaceProfileId
  }
}

interface BuildSoloToolSchemaTelemetryInput<TContext extends SoloToolSchemaTelemetryContext> {
  toolContext: TContext
  allowedTools: string[]
  estimateCurrentSerializedChars?: (
    toolContext: TContext,
    allowedTools: string[]
  ) => LooseOptional<number>
  estimateBaselineSerializedChars?: (
    toolContext: TContext,
    profile: ToolSurfaceProfileId,
    allowedTools: string[]
  ) => LooseOptional<number>
}

interface BuildSoloRunProfileTelemetryInput {
  profile: RunProfileId
  reason: string
  contextWindow: Nullable<number>
  maxToolCount: Nullable<number>
  maxSystemPromptChars: Nullable<number>
  baseAllowedToolCount: number
  exposedToolCount: number
  droppedTools: string[]
  systemPromptChars: number
  skippedPromptSegments: StreamTurnContextPayload['skippedPromptSegments']
}

interface SoloToolAllocatorTelemetryPlan {
  baselineToolNames?: string[]
  grantedCategoryIds: ToolCategoryId[]
  grantedToolNames: string[]
  deniedRequests: NonNullable<StreamTurnContextPayload['toolAllocatorTelemetry']>['deniedRequests']
  fuse: {
    tripped: boolean
    message?: LooseOptional<string>
  }
  advisor: {
    called: boolean
    message?: LooseOptional<string>
    error?: LooseOptional<string>
  }
  toolLayerMetrics?: LooseOptional<Partial<ToolLayerTelemetryMetrics>>
  message?: LooseOptional<string>
}

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
export type {
  BuildSoloRunProfileTelemetryInput,
  BuildSoloToolSchemaTelemetryInput,
  SoloToolAllocatorTelemetryPlan,
  SoloToolSchemaTelemetryContext,
}
