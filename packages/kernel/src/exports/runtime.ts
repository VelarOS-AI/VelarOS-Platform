/** 进程内 Kernel 实现。 */
export {
  createScopedPermissionBroker,
  DenyAllKernelPermissionBroker,
} from '../impl/runtime/DenyAllKernelPermissionBroker'
export type { KernelStateBackend } from '../impl/runtime/InMemoryKernelStateBackend'
export { createNamespacedStateStore, InMemoryKernelStateBackend } from '../impl/runtime/InMemoryKernelStateBackend'
export type { KernelLifecycleFailure, KernelOptions, KernelStatus } from '../impl/runtime/Kernel'
export { Kernel } from '../impl/runtime/Kernel'
export type { KernelCapabilityCall } from '../impl/runtime/KernelCapabilityInvoker'
export {
  KernelCapabilityNotCallableError,
  KernelCapabilityOperationMetadataError,
  KernelCapabilityPermissionCheckError,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from '../impl/runtime/KernelCapabilityInvoker'
export { KernelEventHub } from '../impl/runtime/KernelEventHub'
export type {
  KernelCompositionCapabilitySnapshot,
  KernelCompositionSnapshot,
  KernelModuleHostOptions,
  KernelModuleSnapshot,
} from '../impl/runtime/KernelModuleHost'
export { KernelModuleHost } from '../impl/runtime/KernelModuleHost'
export type { KernelActiveServiceSnapshot } from '../impl/runtime/KernelServiceStore'
export { KernelServiceStore, ScopedKernelServiceResolver } from '../impl/runtime/KernelServiceStore'
export type {
  BoundCapabilityRequirement,
  CapabilitySessionRecord,
} from '../impl/serve/CapabilitySessionLedger'
export { CapabilitySessionLedger } from '../impl/serve/CapabilitySessionLedger'
export type {
  KernelClientAccessBroker,
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from '../impl/serve/DenyAllKernelClientAccessBroker'
export {
  AllowLoadedKernelClientAccessBroker,
  DenyAllKernelClientAccessBroker,
} from '../impl/serve/DenyAllKernelClientAccessBroker'
export type { KernelServiceOptions, KernelServiceStatus } from '../impl/serve/KernelService'
export {
  KernelService,
  KernelServiceLifecycleError,
  KernelServiceStartFailedError,
} from '../impl/serve/KernelService'
export type { KernelModuleStatus } from '../types/abi-module'
export type { ExternalKernelModuleIsolation, KernelModuleIsolationAdapter } from '../types/runtime-isolation'
export type { KernelModCatalog, KernelModCatalogErrorCode } from '../types/serve-mod-catalog'
export { KernelModCatalogError } from '../types/serve-mod-catalog'
export type { KernelHostErrorCode, KernelHostErrorDetails } from '../utils/errors'
export { KernelHostError, KernelOperationError, KernelStartupError, toError } from '../utils/errors'
export type { KernelCapabilityProvider, KernelModulePlan } from '../utils/runtime/module-plan'
export { resolveKernelModulePlan, validateManifest } from '../utils/runtime/module-plan'
export { assertSemanticVersion, satisfiesVersionRange } from '../utils/runtime/version'
