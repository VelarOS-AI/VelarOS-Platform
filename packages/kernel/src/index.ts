/** VelarOS 进程内微内核；client 与 serve 部署形态只通过对应子路径公开。 */
export type {
  KernelCallableCapabilityOperation,
  KernelCallableCapabilityService,
  KernelCapabilityOperationContext,
  KernelCapabilityOperationMetadata,
  KernelCapabilityOperationReason,
} from './contracts/abi/callable'
export {
  createKernelCallableCapability,
  isKernelCallableCapabilityService,
  resolveKernelCapabilityOperationReason,
  UnknownKernelCapabilityOperationError,
} from './contracts/abi/callable'
export type { CapabilityRequirement, CapabilityToken } from './contracts/abi/capability'
export { createCapabilityToken, requireCapability } from './contracts/abi/capability'
export type { KernelEvent, KernelEventHandler, KernelModuleEventBus } from './contracts/abi/events'
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
} from './contracts/abi/module'
export { defineKernelModule, KernelModuleIsolationValues } from './contracts/abi/module'
export type {
  KernelModulePermissionBroker,
  KernelModulePermissionRequest,
  KernelPermissionBroker,
  KernelPermissionDecision,
  KernelPermissionRequest,
} from './contracts/abi/permissions'
export type { ResourceRef, ScopeRef } from './contracts/abi/references'
export type { KernelStateStore } from './contracts/abi/state'
export { KernelModuleApiVersion, KernelVersion } from './contracts/abi/version-axis'
export type { KernelServiceHealth, KernelServiceModuleHealth } from './contracts/service/health'
export type {
  OpenKernelSessionInput,
  StartKernelRunInput,
} from './contracts/service/identity-inputs'
export type { KernelCapabilityCall } from './runtime/capability-invocation'
export {
  KernelCapabilityNotCallableError,
  KernelCapabilityOperationMetadataError,
  KernelCapabilityPermissionCheckError,
  KernelCapabilityPermissionDeniedError,
  KernelCapabilityUnavailableError,
} from './runtime/capability-invocation'
export type { KernelCapabilityProvider, KernelModulePlan } from './runtime/host/dependency-resolver'
export { resolveKernelModulePlan, validateManifest } from './runtime/host/dependency-resolver'
export type { KernelHostErrorCode, KernelHostErrorDetails } from './runtime/host/errors'
export {
  KernelHostError,
  KernelOperationError,
  KernelStartupError,
  toError,
} from './runtime/host/errors'
export { KernelEventHub } from './runtime/host/event-bus'
export type { KernelHostBridge } from './runtime/host/host-bridge'
export { KernelHostBridgeRegistry } from './runtime/host/host-bridge'
export type {
  ExternalKernelModuleIsolation,
  KernelModuleIsolationAdapter,
} from './runtime/host/isolation'
export type {
  KernelCompositionCapabilitySnapshot,
  KernelCompositionSnapshot,
  KernelModuleHostOptions,
  KernelModuleSnapshot,
} from './runtime/host/KernelModuleHost'
export { KernelModuleHost } from './runtime/host/KernelModuleHost'
export {
  createScopedPermissionBroker,
  DenyAllKernelPermissionBroker,
} from './runtime/host/permission-broker'
export type { KernelActiveServiceSnapshot } from './runtime/host/service-registry'
export { KernelServiceStore, ScopedKernelServiceResolver } from './runtime/host/service-registry'
export type {
  HostBridgeCancelFrame,
  HostBridgeEndpoint,
  HostBridgeEventFrame,
  HostBridgeOnEvent,
  HostBridgeRpcFailure,
  HostBridgeRpcMethod,
  HostBridgeRpcRequest,
  HostBridgeRpcResponse,
  HostBridgeRpcSuccess,
  SidecarIsolationAdapterOptions,
} from './runtime/host/sidecar-bridge'
export {
  defaultHostBridgeSocketPath,
  HostBridgeClient,
  parseHostBridgeEndpoint,
  SidecarIsolationAdapter,
} from './runtime/host/sidecar-bridge'
export type { KernelStateBackend } from './runtime/host/state-store'
export { createNamespacedStateStore, InMemoryKernelStateBackend } from './runtime/host/state-store'
export { assertSemanticVersion, satisfiesVersionRange } from './runtime/host/version'
export type { KernelLifecycleFailure, KernelOptions, KernelStatus } from './runtime/Kernel'
export { Kernel } from './runtime/Kernel'
export type {
  BoundCapabilityRequirement,
  CapabilitySessionRecord,
} from './runtime/service/capability-grants'
export { CapabilitySessionLedger } from './runtime/service/capability-grants'
export type {
  KernelClientAccessBroker,
  KernelClientAccessDecision,
  KernelClientCapabilityBindRequest,
} from './runtime/service/client-access'
export {
  AllowLoadedKernelClientAccessBroker,
  DenyAllKernelClientAccessBroker,
} from './runtime/service/client-access'
export type {
  KernelIdentityRegistryErrorCode,
  KernelIdentityRegistryOptions,
} from './runtime/service/identity-registry'
export {
  KernelIdentityRegistry,
  KernelIdentityRegistryError,
} from './runtime/service/identity-registry'
export type { KernelServiceOptions, KernelServiceStatus } from './runtime/service/KernelService'
export {
  KernelService,
  KernelServiceLifecycleError,
  KernelServiceStartFailedError,
} from './runtime/service/KernelService'
export type { KernelModCatalog, KernelModCatalogErrorCode } from './runtime/service/mod-catalog'
export { KernelModCatalogError } from './runtime/service/mod-catalog'
