export { FeatureLimits, FeaturesModuleId } from './contract/constants.js'
export type { FeaturesOperationsApi } from './contract/provides.js'
export type { FeatureHost, FeaturesOperationContext } from './contract/requires.js'
export { VelarFeaturesModule } from './contract/surface.js'
export { featuresOperations } from './impl/FeaturesOperations.js'
export type {
  FeatureDefinition,
  FeatureIdInput,
  FeatureInstallInput,
  FeatureLoaded,
  FeaturePathInput,
  FeatureSelection,
  FeatureSummary,
} from './types/features.js'
