/** 系统空间聚合入口，各项职责由专用子路径提供。 */
export {
  createSystemSearchIgnorePolicy,
  type SystemSearchIgnorePolicy,
  type SystemSearchIgnorePolicyOptions,
} from './atomic/SystemSearchIgnorePolicy'
export {
  MacosTccProtectedSearchDirectoryNames,
  shouldSkipSystemSearchEntry,
  shouldSkipSystemSearchProtectedDirectory,
  type SystemSearchProtectedDirectoryInput,
  SystemSearchSkippedDirectoryNames,
} from './atomic/SystemSearchVisibility'
export {
  systemDesktopTools,
  systemExecutionTools,
  systemFileTools,
  systemProcessTools,
  systemTools,
} from './Collection'
export * from './composition/index'
export {
  createLocalSystemKernel,
  LocalSystemKernel,
  type LocalSystemKernelOptions,
} from './kernel/LocalSystemKernel'
export {
  createSystemKernelModule,
  type CreateSystemKernelModuleOptions,
  SystemCapability,
  type SystemCapabilityService,
  type SystemToolContextResolver,
} from './kernel-module'
export type { SystemToolCategoryId, SystemToolName } from './system-tool-names'
export { SystemToolCategoryByName, SystemToolNames } from './system-tool-names'
export * from './SystemCommandExecutionPolicy'
export type * from './SystemContracts'
export * from './SystemPlatformCompatibility'
export * from './SystemProcessConfinement'
export * from './SystemProcessParsers'
export type { SystemToolContext, SystemToolSystemApi, ToolContext, VelaTool } from './Types'
export {
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
  type VelarOSSharedResourceStoreOptions,
} from './VelarOSSharedResourceStore'
