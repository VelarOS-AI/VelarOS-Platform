export { KernelModuleApiVersion, KernelVersion } from '../contract/constants'
export type {
  KernelCallableCapabilityOperation,
  KernelCallableCapabilityService,
  KernelCapabilityOperationContext,
  KernelCapabilityOperationMetadata,
  KernelCapabilityOperationReason,
} from '../impl/runtime/KernelCallableCapability'
export {
  createKernelCallableCapability,
  isKernelCallableCapabilityService,
  resolveKernelCapabilityOperationReason,
  UnknownKernelCapabilityOperationError,
} from '../impl/runtime/KernelCallableCapability'
export { createCapabilityToken, requireCapability } from '../impl/runtime/KernelModuleKit'
export type { CapabilityRequirement, CapabilityToken } from '../types/abi-capability'
export type { KernelEvent, KernelEventHandler, KernelModuleEventBus } from '../types/abi-events'
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
} from '../types/abi-module'
export { defineKernelModule, KernelModuleIsolationValues } from '../types/abi-module'
export type {
  KernelModulePermissionBroker,
  KernelModulePermissionRequest,
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from '../types/abi-permissions'
export type { ResourceRef, ScopeRef } from '../types/abi-references'
export type { KernelStateStore } from '../types/abi-state'
