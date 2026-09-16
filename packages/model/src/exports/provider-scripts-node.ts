/**
 * `Node.js` 提供方脚本加载入口。
 *
 * 仅可信宿主进程可导入此子路径。浏览器和渲染器消费者应依赖包根入口导出的
 * `ProviderScriptRegistryPort`。
 */
export type {
  ProviderScriptHostBridge,
  ProviderScriptRegistryOptions,
} from '../contract/requires'
export { ProviderScriptModelAdapter } from '../impl/adapters/ProviderScriptModelAdapter'
export {
  ProviderScriptRegistry,
  resolveProviderScriptDevConfigCandidates,
} from '../impl/providers/ProviderScriptRegistry'
export type {
  ProviderScriptDescriptor,
  ProviderScriptRuntimeMetadata,
} from '../types/model'
export type {
  ProviderScriptDefinition,
  ProviderScriptHelpers,
  ProviderScriptInput,
  ProviderScriptRuntimeInput,
} from '../types/script-authoring'
export type { ProviderScriptRegistryPort } from '../types/scripts'
