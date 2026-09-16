// 域：提示词段的稳定性判定。单独成文件是因为内置 mod 的清单投影（utils/builtin）也要用它，
// 而 utils 不许引 impl。
import type { PromptSegmentStability, PromptSegmentTier } from '../../types/guidance.js'

/** 稳定性由层派生：只有 Tier0 进稳定前缀。 */
export function resolvePromptSegmentStability(tier: PromptSegmentTier): PromptSegmentStability {
  return tier === 'core' ? 'stable' : 'dynamic'
}
