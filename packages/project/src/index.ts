/** Project 聚合入口。职责边界可通过 files、changes、execution、contracts、composition 与 kernel 子路径单独消费。 */
export * from './changes.js'
export * from './composition/index.js'
export * from './contracts.js'
export * from './execution.js'
export * from './files.js'
export {
  createProjectKernelModule,
  type CreateProjectKernelModuleOptions,
  ProjectCapability,
  type ProjectCapabilityService,
  type ProjectToolContextResolver,
} from './kernel-module.js'
export * from './runtime.js'
