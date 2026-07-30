/**
 * Node.js host entry.
 *
 * This entry extends the portable package root with filesystem-backed provider
 * script loading, VM adapters, and the default runtime composition.
 */
export * from './index'
export {
  createLegacyModelAdapterRegistry,
  createModelAdapterRegistry,
  ModelAdapterRegistry,
} from './ModelAdapterRegistry'
export {
  createModelRuntimeComposition,
  type CreateModelRuntimeCompositionOptions,
  DefaultModelRuntimeComposition,
  ModelRuntimeComposition,
} from './ModelRuntimeComposition'
export { NodeLocalModelEnvironment } from './NodeLocalModelEnvironment'
export {
  type ProviderScriptDefinition,
  type ProviderScriptHelpers,
  type ProviderScriptHostBridge,
  type ProviderScriptInput,
  ProviderScriptModelAdapter,
  ProviderScriptRegistry,
  type ProviderScriptRegistryOptions,
  type ProviderScriptRuntimeInput,
  resolveProviderScriptDevConfigCandidates,
} from './ProviderScriptRegistry'
export { UserJsModelAdapter } from './UserJsModelAdapter'
