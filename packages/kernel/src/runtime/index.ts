/** 进程内 Kernel 实现。 */
export type { KernelModuleStatus } from '../contracts/abi/module'
export type { KernelCapabilityCall } from './capability-invocation'
export {
  KernelCapabilityNotCallableError,
  KernelCapabilityOperationMetadataError,
  KernelCapabilityPermissionCheckError,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from './capability-invocation'
export type { KernelCapabilityProvider, KernelModulePlan } from './host/dependency-resolver'
export { resolveKernelModulePlan, validateManifest } from './host/dependency-resolver'
export type { KernelHostErrorCode, KernelHostErrorDetails } from './host/errors'
export { KernelHostError, KernelOperationError, KernelStartupError, toError } from './host/errors'
export { KernelEventHub } from './host/event-bus'
export type { ExternalKernelModuleIsolation, KernelModuleIsolationAdapter } from './host/isolation'
export type {
  KernelCompositionCapabilitySnapshot,
  KernelCompositionSnapshot,
  KernelModuleHostOptions,
  KernelModuleSnapshot,
} from './host/KernelModuleHost'
export { KernelModuleHost } from './host/KernelModuleHost'
export {
  createScopedPermissionBroker,
  DenyAllKernelPermissionBroker,
} from './host/permission-broker'
export type { KernelActiveServiceSnapshot } from './host/service-registry'
export { KernelServiceStore, ScopedKernelServiceResolver } from './host/service-registry'
export type { KernelStateBackend } from './host/state-store'
export { createNamespacedStateStore, InMemoryKernelStateBackend } from './host/state-store'
export { assertSemanticVersion, satisfiesVersionRange } from './host/version'
export type { KernelLifecycleFailure, KernelOptions, KernelStatus } from './Kernel'
export { Kernel } from './Kernel'
export type {
  BoundCapabilityRequirement,
  CapabilitySessionRecord,
} from './service/capability-grants'
export { CapabilitySessionLedger } from './service/capability-grants'
export type {
  KernelClientAccessBroker,
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from './service/client-access'
export {
  AllowLoadedKernelClientAccessBroker,
  DenyAllKernelClientAccessBroker,
} from './service/client-access'
export type { KernelServiceOptions, KernelServiceStatus } from './service/KernelService'
export {
  KernelService,
  KernelServiceLifecycleError,
  KernelServiceStartFailedError,
} from './service/KernelService'
export type { KernelModCatalog, KernelModCatalogErrorCode } from './service/mod-catalog'
export { KernelModCatalogError } from './service/mod-catalog'
