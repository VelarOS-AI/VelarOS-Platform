import type { ChatPromptFeatureId, ToolCategoryId } from '@velaros-ai/agent/protocol'

interface RuntimePromptFeaturePolicy {
  normalize(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  getLabel(feature: ChatPromptFeatureId): string
  getCategoriesForFeatures(features: readonly ChatPromptFeatureId[]): ToolCategoryId[]
  getFeaturesForCategories(categories: readonly ToolCategoryId[]): ChatPromptFeatureId[]
  getRequiredFeatureForTool(
    toolName: string,
    categoryId?: LooseOptional<ToolCategoryId>
  ): Nullable<ChatPromptFeatureId>
  isOfficeFeature(feature: ChatPromptFeatureId): boolean
}

function uniquePromptFeatures(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[] {
  return [...new Set(features)]
}

const defaultRuntimePromptFeaturePolicy: RuntimePromptFeaturePolicy = {
  normalize: uniquePromptFeatures,
  getLabel: (feature) => feature,
  getCategoriesForFeatures: () => [],
  getFeaturesForCategories: () => [],
  getRequiredFeatureForTool: () => null,
  isOfficeFeature: () => false,
}

export { defaultRuntimePromptFeaturePolicy }
export type { RuntimePromptFeaturePolicy }
