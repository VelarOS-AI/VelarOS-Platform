/** 进程内 Kernel 实现。 */
export type { KernelCallErrorCode, KernelErrorCode } from '../contract/constants'
export {
  createScopedPermissionBroker,
  DenyAllKernelPermissionBroker,
} from '../impl/runtime/DenyAllKernelPermissionBroker'
export type { KernelStateBackend } from '../impl/runtime/InMemoryKernelStateBackend'
export { createNamespacedStateStore, InMemoryKernelStateBackend } from '../impl/runtime/InMemoryKernelStateBackend'
export type { KernelLifecycleFailure, KernelOptions, KernelStatus } from '../impl/runtime/Kernel'
export { Kernel } from '../impl/runtime/Kernel'
export type { KernelCapabilityCall } from '../impl/runtime/KernelCapabilityInvoker'
export { KernelEventHub } from '../impl/runtime/KernelEventHub'
export type {
  KernelCompositionCapabilitySnapshot,
  KernelCompositionSnapshot,
  KernelModuleHostOptions,
  KernelModuleSnapshot,
} from '../impl/runtime/KernelModuleHost'
export { KernelModuleHost } from '../impl/runtime/KernelModuleHost'
export type { KernelActiveServiceSnapshot } from '../impl/runtime/KernelServiceStore'
export { KernelServiceStore } from '../impl/runtime/KernelServiceStore'
export { ScopedKernelServiceResolver } from '../impl/runtime/ScopedKernelServiceResolver'
export { AllowLoadedKernelClientAccessBroker } from '../impl/serve/AllowLoadedKernelClientAccessBroker'
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
export { DenyAllKernelClientAccessBroker } from '../impl/serve/DenyAllKernelClientAccessBroker'
export type { KernelServiceOptions, KernelServiceStatus } from '../impl/serve/KernelService'
export {
  KernelService,
} from '../impl/serve/KernelService'
export type { KernelModuleStatus } from '../types/abi-module'
export type { ExternalKernelModuleIsolation, KernelModuleIsolationAdapter } from '../types/runtime-isolation'
export type { KernelModCatalog } from '../types/serve-mod-catalog'
export type { KernelErrorDetails } from '../utils/errors'
export { KernelError, toError } from '../utils/errors'
export type { KernelCapabilityProvider, KernelModulePlan } from '../utils/runtime/module-plan'
export { resolveKernelModulePlan, validateManifest } from '../utils/runtime/module-plan'
export { assertSemanticVersion, satisfiesVersionRange } from '../utils/runtime/version'
