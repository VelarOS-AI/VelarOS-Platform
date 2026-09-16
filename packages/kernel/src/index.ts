/** VelarOS 进程内微内核；client 与 serve 部署形态只通过对应子路径公开。 */
export type { KernelCallErrorCode, KernelErrorCode } from './contract/constants'
export type { KernelModuleIsolation } from './contract/constants'
export { KernelModuleApiVersion, KernelVersion } from './contract/constants'
export { KernelModuleIsolations,KernelModuleIsolationValues } from './contract/constants'
export type {
  AllowLoadedKernelClientAccessBrokerApi,
  BootedKernelDaemon,
  BootKernelDaemonOptions,
  CapabilitySessionLedgerApi,
  ConnectedKernelDaemon,
  InProcessKernelService,
  InProcessKernelTransportApi,
  InProcessKernelTransportService,
  KernelCapabilityInvokerApi,
  KernelDaemonAssemblyOptions,
  KernelDaemonDirectoryConnection,
  KernelEventHubApi,
  KernelLauncherResult,
  KernelLaunchResult,
  KernelLocalDaemonApi,
  KernelLocalRpcServerApi,
  KernelModLoaderApi,
  KernelModStoreApi,
  KernelModuleActivateContext,
  KernelRegistration,
  KernelServiceHandle,
  KernelServiceStoreApi,
  RemoteNodeCallRunnerApi,
  RemoteNodeInvocationPoolApi,
  RemoteNodePairingGateApi,
  RemoteNodePendingCallsApi,
  RemoteNodeResultCacheApi,
} from './contract/provides'
export type {
  KernelStateBackend,
  RemoteNodeActivitySink,
  RemoteNodeAuditSink,
  RemoteNodeCapabilityInvoker,
  RemoteNodeClientCredentialStore,
  RemoteNodeManifestSource,
  RemoteNodeServerCredentialStore,
  RemoteNodeSocket,
  RemoteNodeSocketFactory,
} from './contract/requires'
export type { KernelCallableCapabilityOperation, KernelCallableCapabilityService, KernelCapabilityOperationContext, KernelCapabilityOperationMetadata, KernelCapabilityOperationReason } from './contract/requires'
export type { KernelEventHandler } from './contract/requires'
export type { KernelModuleDefinition, KernelModuleLifecycle } from './contract/requires'
export type { KernelPermissionBroker } from './contract/requires'
export type { KernelModuleIsolationAdapter } from './contract/requires'
export type { KernelClientAccessBroker } from './contract/requires'
export { DenyAllKernelPermissionBroker } from './impl/runtime/DenyAllKernelPermissionBroker'
export { InMemoryKernelStateBackend } from './impl/runtime/InMemoryKernelStateBackend'
export type { KernelOptions } from './impl/runtime/Kernel'
export { createKernel } from './impl/runtime/Kernel'
export { Kernel } from './impl/runtime/Kernel'
export { createKernelCallableCapability } from './impl/runtime/KernelCallableCapability'
export { KernelEventHub } from './impl/runtime/KernelEventHub'
export type { KernelModuleHostOptions } from './impl/runtime/KernelModuleHost'
export { KernelModuleHost } from './impl/runtime/KernelModuleHost'
export { createCapabilityToken, defineKernelModule, kernelModules, requireCapability } from './impl/runtime/KernelModuleKit'
export { KernelServiceStore } from './impl/runtime/KernelServiceStore'
export type { KernelStateStore } from './impl/runtime/NamespacedKernelStateStore'
export { createNamespacedStateStore } from './impl/runtime/NamespacedKernelStateStore'
export type { KernelModuleEventBus } from './impl/runtime/ScopedKernelEventBus'
export type { KernelModulePermissionBroker } from './impl/runtime/ScopedKernelPermissionBroker'
export { createScopedPermissionBroker } from './impl/runtime/ScopedKernelPermissionBroker'
export type { KernelServiceResolver } from './impl/runtime/ScopedKernelServiceResolver'
export { ScopedKernelServiceResolver } from './impl/runtime/ScopedKernelServiceResolver'
export { velarosModEnvelopes } from './impl/runtime/VelarosModEnvelopeParser'
export { AllowLoadedKernelClientAccessBroker } from './impl/serve/AllowLoadedKernelClientAccessBroker'
export { CapabilitySessionLedger } from './impl/serve/CapabilitySessionLedger'
export { DenyAllKernelClientAccessBroker } from './impl/serve/DenyAllKernelClientAccessBroker'
export type { KernelServiceOptions } from './impl/serve/KernelService'
export {
  KernelService,
} from './impl/serve/KernelService'
export type { KernelStatus } from './types/kernel'
export type { KernelCompositionCapabilitySnapshot, KernelCompositionSnapshot, KernelModuleSnapshot } from './types/kernel'
export type { ExternalKernelModuleIsolation } from './types/kernel'
export type { CapabilityRequirement, CapabilityToken } from './types/kernel.js'
export type { ResourceRef, ScopeRef } from './types/kernel.js'
export type { Awaitable, KernelModuleHealth, KernelModuleHealthStatus, KernelModuleManifest, KernelModuleStatus } from './types/kernel.js'
export type { KernelModulePermissionRequest, KernelPermissionDecision, KernelPermissionRequest } from './types/kernel.js'
export type { KernelEvent } from './types/kernel.js'
export type { KernelServiceHealth, KernelServiceModuleHealth } from './types/kernel.js'
export type { KernelLifecycleFailure } from './types/runtime'
export type { KernelCapabilityCall } from './types/runtime'
export type { KernelActiveServiceSnapshot } from './types/runtime'
export type { BoundCapabilityRequirement, CapabilitySessionRecord } from './types/serve'
export type { KernelClientAccessDecision, KernelClientCapabilityBindRequest } from './types/serve'
export type { KernelServiceStatus } from './types/serve'
export type { KernelModCatalog } from './types/serve'
export type { KernelErrorDetails } from './utils/errors'
export { KernelError, toError } from './utils/errors'
export {
  isKernelCallableCapabilityService,
  resolveKernelCapabilityOperationReason,
} from './utils/runtime/callable'
export type { KernelCapabilityProvider, KernelModulePlan } from './utils/runtime/module-plan'
export { resolveKernelModulePlan, validateManifest } from './utils/runtime/module-plan'
export { assertSemanticVersion, satisfiesVersionRange } from './utils/runtime/version'

// 合同：产品面与注入面的每个接口都从根入口出（`check:module-ownership` 的硬要求）。
export type {
  BootedKernelDaemonApi,
  CapabilitySessionApi,
  KernelApi,
  KernelClientApi,
  KernelDaemonDirectoryApi,
  KernelDaemonProcessApi,
  KernelDaemonProcessEnvironment,
  KernelEventSubscription,
  KernelLauncherApi,
  KernelLauncherOptions,
  KernelLocalDaemonOptions,
  KernelLocalRpcServerOptions,
  KernelModStorePaths,
  KernelModuleHostApi,
  KernelModuleKitApi,
  KernelServiceApi,
  KernelUpdateLockApi,
  KernelUpdaterApi,
  RemoteNodeCallRunnerOptions,
  RemoteNodeClientApi,
  RemoteNodeIsolationAdapterOptions,
  RemoteNodePairingGateOptions,
  RemoteNodePendingCallsHost,
  RemoteNodeProjectionApi,
  RemoteNodeServerApi,
  VelarosModEnvelopeApi,
} from './contract/provides'
export type {
  KernelArtifactExtractor,
  KernelArtifactSignatureVerifier,
  KernelClientEventHandler,
  KernelClientTransport,
  KernelFetch,
  KernelHealthCheck,
  KernelModuleImporter,
} from './contract/requires'

// 公开签名闭包里用到、之前没出包的几个数据形状。
export type { RemoteNodeClientFailure } from './types/remote-client'
export type {
  NamespacedKernelStateStoreOptions,
  ScopedKernelPermissionBrokerOptions,
} from './types/runtime'
export type { KernelSystemModPackInput } from './types/serve'
export type {
  VelarosModCapabilityRequirement,
  VelarosModCapabilityToken,
} from './types/wire'
