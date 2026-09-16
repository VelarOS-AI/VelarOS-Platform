import type { RuntimePromptFeaturePolicy } from '../../contract/requires.js'
import type { ChatPromptFeatureId } from '../../types/agent'

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
