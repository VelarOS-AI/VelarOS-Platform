import { isBlank } from '@velaros-ai/core/utils/string'

import type { ChatPromptFeatureId } from '../types'

/**
 * 内核只把 prompt-feature id 当作不透明的宿主能力 id。
 *
 * 具体清单、文案、分类映射、可用性策略与工具门由能力包持有，注入 Agent Runtime；
 * 本层只做去重与丢弃空白 id，不认识任何具体 feature 语义。
 */
export function normalizePromptFeatures(
  features: readonly ChatPromptFeatureId[] = []
): ChatPromptFeatureId[] {
  return [...new Set(features.filter((feature) => !isBlank(feature)))]
}
