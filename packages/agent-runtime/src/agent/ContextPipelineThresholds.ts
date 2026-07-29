import type { ChatContextPipelineProfileId } from '@velaros-ai/core/types'
import {
  ContextUsageCompactionPercent,
  ContextUsageHighWatermarkPercent,
  ContextUsageSemanticPreSummaryPercent,
} from '@velaros-ai/core/utils/contextUsage'

export interface ContextPipelineThresholdProfile {
  autoCompactionPercent: number
  semanticPreSummaryPercent: number
  highWatermarkPercent: number
}

const DefaultThresholdProfile: ContextPipelineThresholdProfile = {
  autoCompactionPercent: ContextUsageCompactionPercent,
  semanticPreSummaryPercent: ContextUsageSemanticPreSummaryPercent,
  highWatermarkPercent: ContextUsageHighWatermarkPercent,
}

const ThresholdProfiles: Record<ChatContextPipelineProfileId, ContextPipelineThresholdProfile> = {
  'pre-send-discovery': {
    ...DefaultThresholdProfile,
    autoCompactionPercent: 78,
  },
  'post-run-cleanup': DefaultThresholdProfile,
  'auto-conservative': DefaultThresholdProfile,
  'team-worker-minimal': {
    ...DefaultThresholdProfile,
    autoCompactionPercent: 76,
    semanticPreSummaryPercent: 70,
  },
  'recovery-safe': {
    ...DefaultThresholdProfile,
    autoCompactionPercent: 82,
    semanticPreSummaryPercent: 78,
  },
}

export function resolveContextPipelineThresholds(
  profile: ChatContextPipelineProfileId = 'auto-conservative'
): ContextPipelineThresholdProfile {
  return ThresholdProfiles[profile] ?? DefaultThresholdProfile
}

export function resolveAutoCompactionPercent(
  profile: ChatContextPipelineProfileId = 'auto-conservative'
): number {
  return resolveContextPipelineThresholds(profile).autoCompactionPercent
}

export function resolveSemanticPreSummaryPercent(
  profile: ChatContextPipelineProfileId = 'auto-conservative'
): number {
  return resolveContextPipelineThresholds(profile).semanticPreSummaryPercent
}
