/**
 * 工具契约根入口（`@velaros-ai/tool-contract`）：定义一条工具、渲染它的模型面说明、出它的入参 schema、
 * 把一个空间的工具集合挂进内核、造统一的失败回执。另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口 ────────────────────────────────────────────────────
export * from './contracts.js'

// ── 注入面：宿主给的工具上下文解析器 ─────────────────────────────
export type { ToolContextResolver } from './contract/requires.js'

// ── 产品面：定义工具、说明、schema、身份、宽容入参、内核挂载、失败回执 ──
export type { ToolContractDefinitionApi } from './impl/ToolContractDefinition.js'
export { toolContracts } from './impl/ToolContractDefinition.js'
export type { ToolDescriptionsApi } from './impl/ToolDescriptions.js'
export { renderParameterDescription, toolDescriptions } from './impl/ToolDescriptions.js'
export type { ToolExampleRegistryApi } from './impl/ToolExampleRegistry.js'
export {
  createToolExampleRegistry,
  renderToolExampleInputs,
  serializeToolExampleInput,
  toolExamples,
} from './impl/ToolExampleRegistry.js'
export type { ToolFailuresApi } from './impl/ToolFailures.js'
export { toolFailures } from './impl/ToolFailures.js'
export type { ToolIdentityApi } from './impl/ToolIdentity.js'
export { toolIdentity } from './impl/ToolIdentity.js'
export type { ToolInputForgivenessApi } from './impl/ToolInputForgiveness.js'
export { toolInputForgiveness } from './impl/ToolInputForgiveness.js'
export type { ToolKernelModulesApi } from './impl/ToolKernelModules.js'
export { toolKernelModules } from './impl/ToolKernelModules.js'
export type { ToolSchemasApi } from './impl/ToolSchemas.js'
export { toolSchemas } from './impl/ToolSchemas.js'

// ── 上面用到、又不在可移植文件里的数据 ───────────────────────────
export type {
  DefineToolContractInput,
  DefineToolContractSurfaceInput,
  DefineToolRuntimeSpecInput,
  ToolCallableOperationsOptions,
  ToolCapabilityService,
  ToolContractExecute,
  ToolContractRuntimeSpec,
  ToolContractSpec,
  ToolContractSurface,
  ToolDefiner,
  ToolDefinerOptions,
  ToolInputReuseContract,
  ToolKernelModuleOptions,
  ToolSchemaSource,
} from './types/toolkit.js'
