// `./tool-contract` 入口：空间包与宿主写工具时要的那几件。
// 通用的工具定义、说明渲染、schema 打包、宽容入参与身份判定都在 `@velaros-ai/tool-contract`；
// 这里只留跟 Agent 审批语义、入参复用与文件上下文绑定的部分。
export type { ToolInputReuseStoreApi } from './contract/provides.js'
export type { ApprovalPort, InteractionPort } from './contract/requires.js'
export type { FileContextCoordinatorApi } from './impl/context/FileContextCoordinator'
export type { FileContextRegistryApi } from './impl/context/FileContextRegistry'
export { fileContextRegistry } from './impl/context/FileContextRegistry'
export type { AgentToolContractsApi } from './impl/tools/AgentToolContracts'
export { agentToolContracts } from './impl/tools/AgentToolContracts'
export { defaultDenyApprovalPort } from './impl/tools/DefaultDenyApprovalPort'
export { resolveToolInputReuse, toolInputReuseStore, withToolInputReuse } from './impl/tools/ToolInputReuseStore'
export { createUnattendedSubAgentApprovalPort } from './impl/tools/UnattendedSubAgentApprovalPort'
export { defaultUnsupportedInteractionPort } from './impl/tools/UnsupportedInteractionPort'
export type { FileContextCarrier, FileContextRange, FileContextSnapshot, FileContextSource } from './types/context.js'
export type { BoundedReadInput, ManualApprovalOptions, RecursiveTraversalInput, ToolInputReuseContract, ToolInputReuseMigrationRequest, UnattendedApprovalEscalationHooks } from './types/toolkit.js'
export type { ToolInputReuseOptions } from './types/tools.js'
