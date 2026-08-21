import type {
  CapabilityScopeId,
  ChatPromptFeatureId,
  ToolCategoryId,
} from '@velaros-ai/agent/protocol'

interface RuntimePromptFeaturePolicy {
  normalize(features: readonly ChatPromptFeatureId[]): ChatPromptFeatureId[]
  /** 宿主可按当前能力作用域收窄常驻协议；缺席时沿用全局归一。 */
  normalizeForScope?(
    features: readonly ChatPromptFeatureId[],
    scope: CapabilityScopeId
  ): ChatPromptFeatureId[]
  getLabel(feature: ChatPromptFeatureId): string
  /**
   * 内置协议也可以用 feature id 参与运行时装配，但不应被描述成用户“本轮已选”的能力。
   * 宿主不实现时保持历史行为：所有 feature 都按已选能力展示。
   */
  shouldDescribeAsSelected?(feature: ChatPromptFeatureId): boolean
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
