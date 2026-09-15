/** 组合：项目空间（内核加工具）、内置 mod 定义、可选的代码图分析扩展、审批桥。 */
export { ProjectModId, ProjectSpaceId } from '../contract/constants.js'
export type { ProjectBundledModDefinition, ProjectSpace } from '../contract/provides.js'
export { projectApprovalBridge } from '../impl/operations/ProjectApprovalBridge.js'
export { createProjectBundledModDefinition, createProjectCodeAnalysisContribution, createProjectSpace } from '../impl/ProjectTools.js'
export type { ProjectApprovalContext } from '../types/agent.js'
