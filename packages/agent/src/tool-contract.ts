// `./tool-contract` 入口：写工具要的整套契约，任何环境都能加载（整条引用链不碰 Node 内置模块）。
// 定义一条工具（`toolContracts.createDefiner`）、整类说明的结构化断言（`toolDescriptions`）、把工具集合挂进内核（`toolKernelModules`）、
// 一整批工具的紧凑 schema 包（`toolSchemas`），外加审批与交互端口、入参复用与文件上下文。可移植的工具协议数据在 `./contracts`。
export type { ToolContractDefinitionApi, ToolDescriptionsApi, ToolInputReuseStoreApi, ToolKernelModulesApi, ToolSchemasApi } from './contract/provides.js'
export type { ApprovalPort, InteractionPort, ToolContextResolver } from './contract/requires.js'
export type { FileContextCoordinatorApi } from './impl/context/FileContextCoordinator'
export type { FileContextRegistryApi } from './impl/context/FileContextRegistry'
export { fileContextRegistry } from './impl/context/FileContextRegistry'
export type { AgentToolContractsApi } from './impl/tools/AgentToolContracts'
export { agentToolContracts } from './impl/tools/AgentToolContracts'
export { defaultDenyApprovalPort } from './impl/tools/DefaultDenyApprovalPort'
export { toolContracts } from './impl/tools/ToolContractDefinition'
export { toolDescriptions } from './impl/tools/ToolDescriptions'
export { resolveToolInputReuse, toolInputReuseStore, withToolInputReuse } from './impl/tools/ToolInputReuseStore'
export { toolKernelModules } from './impl/tools/ToolKernelModules'
export { toolSchemas } from './impl/tools/ToolSchemas'
export { createUnattendedSubAgentApprovalPort } from './impl/tools/UnattendedSubAgentApprovalPort'
export { defaultUnsupportedInteractionPort } from './impl/tools/UnsupportedInteractionPort'
export type { FileContextCarrier, FileContextPresentation, FileContextRange, FileContextSnapshot, FileContextSource } from './types/context.js'
export type { AppliedAdjustment, BoundedReadInput, CreateToolSchemaBundleOptions, DefineToolContractSurfaceInput, DefineToolRuntimeSpecInput,
 ManualApprovalOptions, NonEmptyToolContractList, RecursiveTraversalInput, ToolCapabilityService, ToolContractDescriptionSpec,
 ToolContractExecute, ToolContractRuntimeSpec, ToolContractSurface, ToolDefiner, ToolDefinerOptions, ToolDescriptionBudgetWaiver,
 ToolDescriptionBudgetWaiverReason, ToolDescriptionLike, ToolInputReuseContract, ToolInputReuseMigrationRequest, ToolKernelModuleOptions,
 ToolSchemaBundle, ToolSchemaSource, UnattendedApprovalEscalationHooks } from './types/toolkit.js'
export type { ToolInputReuseOptions } from './types/tools.js'
