export type {
  KernelCallableCapabilityOperation,
  KernelCallableCapabilityService,
  KernelCapabilityOperationContext,
  KernelCapabilityOperationMetadata,
  KernelCapabilityOperationReason,
} from './callable'
export {
  createKernelCallableCapability,
  isKernelCallableCapabilityService,
  resolveKernelCapabilityOperationReason,
  UnknownKernelCapabilityOperationError,
} from './callable'
export type { CapabilityRequirement, CapabilityToken } from './capability'
export { createCapabilityToken, requireCapability } from './capability'
export type { KernelEvent, KernelEventHandler, KernelModuleEventBus } from './events'
export type {
  Awaitable,
  KernelModuleActivateContext,
  KernelModuleDefinition,
  KernelModuleHealth,
  KernelModuleHealthStatus,
  KernelModuleIsolation,
  KernelModuleLifecycle,
  KernelModuleManifest,
  KernelModuleStatus,
  KernelRegistration,
  KernelServiceHandle,
  KernelServiceResolver,
} from './module'
export { defineKernelModule, KernelModuleIsolationValues } from './module'
export type {
  KernelModulePermissionBroker,
  KernelModulePermissionRequest,
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from './permissions'
export type { ResourceRef, ScopeRef } from './references'
export type { KernelStateStore } from './state'
export { KernelModuleApiVersion, KernelVersion } from './version-axis'
