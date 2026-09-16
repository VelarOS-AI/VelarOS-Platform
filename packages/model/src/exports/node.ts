/**
 * `Node.js` 宿主入口。
 *
 * 本入口在可移植包根能力上补充基于文件系统的提供方脚本加载、虚拟机适配器和默认运行时装配。
 */
export { ProviderScriptModelAdapter } from '../impl/adapters/ProviderScriptModelAdapter'
export { UserJsModelAdapter } from '../impl/adapters/UserJsModelAdapter'
export {
  createModelRuntimeComposition,
  DefaultModelRuntimeComposition,
  ModelRuntimeComposition,
} from '../impl/composition/DefaultModelRuntimeComposition'
export type { ModelAdapterRegistryApi } from '../impl/composition/ModelAdapterRegistry'
export {
  createLegacyModelAdapterRegistry,
  createModelAdapterRegistry,
  ModelAdapterRegistry,
} from '../impl/composition/ModelAdapterRegistry'
export { NodeLocalModelEnvironment } from '../impl/providers/NodeLocalModelEnvironment'
export type { ProviderScriptRegistryApi } from '../impl/providers/ProviderScriptRegistry'
export {
  ProviderScriptRegistry,
  resolveProviderScriptDevConfigCandidates,
} from '../impl/providers/ProviderScriptRegistry'
export type {
  ProviderScriptDefinition,
  ProviderScriptHelpers,
  ProviderScriptInput,
  ProviderScriptRuntimeInput,
} from '../types/script-authoring'
export * from './index'
