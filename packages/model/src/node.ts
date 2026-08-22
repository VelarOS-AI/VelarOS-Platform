/**
 * `Node.js` 宿主入口。
 *
 * 本入口在可移植包根能力上补充基于文件系统的提供方脚本加载、虚拟机适配器和默认运行时装配。
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
