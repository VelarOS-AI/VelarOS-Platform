/**
 * 产品面：本包交给外面的七件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），
 * 这里登记并转发。注入面在 `requires.ts`。这里登记的每个接口都必须从根入口导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { ToolContractDefinitionApi } from '../impl/ToolContractDefinition.js'
export type { ToolDescriptionsApi } from '../impl/ToolDescriptions.js'
export type { ToolExampleRegistryApi } from '../impl/ToolExampleRegistry.js'
export type { ToolFailuresApi } from '../impl/ToolFailures.js'
export type { ToolIdentityApi } from '../impl/ToolIdentity.js'
export type { ToolInputForgivenessApi } from '../impl/ToolInputForgiveness.js'
export type { ToolKernelModulesApi } from '../impl/ToolKernelModules.js'
export type { ToolSchemasApi } from '../impl/ToolSchemas.js'
