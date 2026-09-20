// 门面：`@velaros-ai/kernel` —— 进程内微内核与模块 SDK。
//
// 值只有三件：`createKernel`（装一个进程内内核）、`kernelModules`（写内核模块的四件套）、
// `velarosModEnvelopes`（解 mod 信封），外加常量表。部署形态的值住在 `./serve`、`./client`、
// `./remote`；它们的接口按门禁要求一律从这里以类型出包。
//
// 这条入口不碰 Node 模块，渲染进程可以直接加载（INV-11）。
export * from './contract/constants'
export type {
  BootedKernelDaemonApi,
  CapabilitySessionApi,
  KernelApi,
  KernelClientApi,
  KernelDaemonAssemblyOptions,
  KernelDaemonDirectoryApi,
  KernelDaemonDirectoryConnection,
  KernelDaemonProcessApi,
  KernelDaemonProcessEnvironment,
  KernelEventSubscription,
  KernelLauncherApi,
  KernelLauncherOptions,
  KernelLauncherResult,
  KernelLocalDaemonApi,
  KernelModStoreApi,
  KernelModuleActivateContext,
  KernelModuleEventBus,
  KernelModuleHostOptions,
  KernelModuleKitApi,
  KernelModulePermissionBroker,
  KernelOptions,
  KernelRegistration,
  KernelServiceApi,
  KernelServiceHandle,
  KernelServiceResolver,
  KernelStateStore,
  KernelUpdaterApi,
  RemoteNodeClientApi,
  RemoteNodeIsolationAdapterOptions,
  RemoteNodeProjectionApi,
  RemoteNodeServerApi,
  VelarosModEnvelopeApi,
} from './contract/provides'
export type {
  KernelArtifactExtractor,
  KernelArtifactSignatureVerifier,
  KernelCallableCapabilityOperation,
  KernelCallableCapabilityService,
  KernelCapabilityOperationContext,
  KernelCapabilityOperationMetadata,
  KernelCapabilityOperationReason,
  KernelClientAccessBroker,
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventHandler,
  KernelFetch,
  KernelHealthCheck,
  KernelModuleDefinition,
  KernelModuleImporter,
  KernelModuleIsolationAdapter,
  KernelModuleLifecycle,
  KernelPermissionBroker,
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
export { createKernel } from './impl/runtime/Kernel'
export { kernelModules } from './impl/runtime/KernelModuleKit'
export { velarosModEnvelopes } from './impl/runtime/VelarosModEnvelopeParser'
export type { OpenCapabilitySessionInput } from './types/client'
export type * from './types/kernel.js'
export type { RemoteNodeCapabilityBinding } from './types/remote'
export type { RemoteNodeBindingResolver, RemoteNodeFileAuditLogOptions } from './types/remote'
export type { RemoteNodeProjectionInput, RemoteNodeToolProjection } from './types/remote'
export type { RemoteNodeClientCredentialStoreOptions, RemoteNodeClientOptions, RemoteNodeCredentials } from './types/remote-client'
export type { RemoteNodeClientFailure, RemoteNodeInvokeRequest, RemoteNodeSession } from './types/remote-client'
export type { RemoteNodeConnectionState, RemoteNodeManifestListener, RemoteNodeProgressListener } from './types/remote-client'
export type { RemoteNodeStateListener, RemoteNodeStopListener, RemoteNodeUnsubscribe } from './types/remote-client'
export type { RemoteNodeActivityEvent, RemoteNodeAuditEntry, RemoteNodePairedCredential } from './types/remote-node'
export type { RemoteNodeCapabilityInvokeRequest, RemoteNodeCapabilityInvokeResult } from './types/remote-node'
export type { RemoteNodeServerOptions, RemoteNodeServerStatus } from './types/remote-node'
export type { KernelCapabilityCall, KernelLifecycleFailure } from './types/runtime'
export type { KernelBundledPack, KernelModCatalog, KernelModPackLoadFailure, KernelModPackRecord } from './types/serve'
export type { KernelClientAccessDecision, KernelClientCapabilityBindRequest, KernelModStorePaths } from './types/serve'
export type { KernelServiceStatus, KernelSystemModPackInput } from './types/serve'
export type { KernelVersionResolver, KernelVersionTarget } from './types/serve'
export type {
  KernelActivationOptions,
  KernelCompatibilityOutcome,
  KernelCompatibilityRequirement,
  KernelEnsureInstalledOptions,
  KernelHealthCheckContext,
  KernelInstallOutcome,
  KernelPruneOptions,
  KernelUpdaterOptions,
} from './types/updater'
export type { KernelArtifactExtractionContext } from './types/updater'
export type { KernelArtifactSignatureContext, KernelArtifactSignatureResult } from './types/updater'
export type {
  KernelActivePointer,
  KernelArtifact,
  KernelArtifactFormat,
  KernelArtifactTarget,
  KernelFetchRequest,
  KernelFetchResponse,
  KernelInstalledVersion,
  KernelInstallLayout,
  KernelInstallRecord,
  KernelManifestVersion,
  KernelUpdateManifest,
} from './types/updater'
export type { VelarosModCapabilityRequirement, VelarosModCapabilityToken } from './types/wire'
// wire 数据：与 `types/kernel.ts` 里同名的四个（ScopeRef、CapabilityToken、CapabilityRequirement、
// ResourceRef）是 wire 坐标下的另一套形状，出包时一律带 `KernelWire` 前缀，两套坐标不混用。
export type { OperationRuntimeApi } from './contract/provides.js'
export type { ModelRequestEncoderApi } from './contract/provides.js'
export type { InvocationJournal, OperationContext, OperationDefinition, OperationModuleDefinition, OperationRuntimeOptions } from './contract/requires.js'
export type { ModelDriver } from './contract/requires.js'
export { modelRequestEncoder } from './impl/runtime/ModelRequestEncoder.js'
export { createOperationRuntime } from './impl/runtime/OperationRuntime.js'
export type { ModelDriverLimits, ModelImage, ModelInputEstimate, ModelMaterial, ModelResponseFormat, ModelTurnDelta,ModelTurnRequest, ModelUserMessage } from './types/model.js'
export type { InvocationReceipt, InvocationRecord, ModuleBinding, ModuleCard, ModuleDescription, ModulePage, ModuleQuery, OperationCall,OperationDescriptor, OperationSchema, OperationSurface, PreparedInvocation } from './types/operations.js'
export type { InvocationReconciliation } from './types/operations.js'
export type {
  CapabilityCallError,
  CapabilityCallFailure,
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilityCallSuccess,
  CapabilityRequireItem,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenFailure,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
  CapabilitySessionOpenSuccess,
  KernelHandshake,
  KernelModPackDescriptor,
  KernelModPackKind,
  KernelModuleDescriptor,
  CapabilityIsolation as KernelWireCapabilityIsolation,
  CapabilityRequirement as KernelWireCapabilityRequirement,
  CapabilityToken as KernelWireCapabilityToken,
  ScopeRef as KernelWireScopeRef,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
  RemoteNodeCapabilityDescriptor,
  RemoteNodeError,
  RemoteNodeIdentity,
  RemoteNodeManifest,
  RemoteNodeOperationDescriptor,
  RemoteNodePlatform,
  RemoteNodeToolDescriptor,
  VelarosModEnvelope,
  VelarosModEnvelopeParseResult,
  VelarosModManifestDiagnostic,
  VelarosModModuleSection,
} from './types/wire'
