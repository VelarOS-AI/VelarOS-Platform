/**
 * `Node.js` 提供方脚本加载入口。
 *
 * 仅可信宿主进程可导入此子路径。浏览器和渲染器消费者应依赖包根入口导出的
 * `ProviderScriptRegistryPort`。
 */
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
} from '../ProviderScriptRegistry'
export type {
  ProviderScriptDescriptor,
  ProviderScriptRegistryPort,
  ProviderScriptRuntimeMetadata,
} from '../ProviderScriptRegistryPort'
