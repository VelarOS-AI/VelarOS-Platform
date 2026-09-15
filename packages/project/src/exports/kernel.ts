/** 作为能力服务挂进 VelarOS 内核：内核模块工厂与能力令牌。 */
export type { ProjectCapabilityService } from '../contract/provides.js'
export type { CreateProjectKernelModuleOptions, ProjectToolContextResolver } from '../contract/requires.js'
export { createProjectKernelModule, ProjectCapability } from '../impl/ProjectTools.js'
