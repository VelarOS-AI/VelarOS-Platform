import type { ChatPromptFeatureId } from '../../types/agent.js'

/** 提示词特性去重，保持首次出现的顺序。 */
export function uniquePromptFeatures(
  features: readonly ChatPromptFeatureId[]
): ChatPromptFeatureId[] {
  return [...new Set(features)]
}
