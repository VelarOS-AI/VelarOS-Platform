// 门面：@velaros-ai/kernel/client 的公开入口 —— 产品接入共享 Kernel 的唯一主要通道。
//
// 产品只依赖本包：发现本机 Kernel、连接、握手、调用能力、订阅事件、启动/附着共享进程。
// Kernel Host / Runtime / Daemon 实现属于 Kernel 内部基础设施，不从这里暴露。
export type { KernelModuleHealthStatus } from '../types/abi-module'
export type {
  CapabilityCallError,
  CapabilityCallFailure,
  CapabilityCallRequest,
  CapabilityCallResponse,
  CapabilityCallSuccess,
  CapabilityIsolation,
  CapabilityRequireItem,
  CapabilityRequirement,
  CapabilitySessionCloseRequest,
  CapabilitySessionCloseResponse,
  CapabilitySessionOpenFailure,
  CapabilitySessionOpenRequest,
  CapabilitySessionOpenResponse,
  CapabilitySessionOpenSuccess,
  CapabilityToken,
  KernelModuleDescriptor,
  ResourceRef,
  ScopeRef,
} from '../utils/wire/capability'
export {
  CapabilityCallErrorSchema,
  CapabilityCallFailureSchema,
  CapabilityCallRequestSchema,
  CapabilityCallResponseSchema,
  CapabilityCallSuccessSchema,
  CapabilityIsolationSchema,
  CapabilityRequireItemSchema,
  CapabilityRequirementSchema,
  CapabilitySessionCloseRequestSchema,
  CapabilitySessionCloseResponseSchema,
  CapabilitySessionOpenFailureSchema,
  CapabilitySessionOpenRequestSchema,
  CapabilitySessionOpenResponseSchema,
  CapabilitySessionOpenSuccessSchema,
  CapabilityTokenSchema,
  KernelModuleDescriptorSchema,
  ResourceRefSchema,
  ScopeRefSchema,
} from '../utils/wire/capability'
export type { KernelHandshake } from '../utils/wire/handshake'
export { KernelHandshakeSchema } from '../utils/wire/handshake'
export type {
  VelarosModEnvelope,
  VelarosModEnvelopeParseResult,
  VelarosModManifestDiagnostic,
  VelarosModModuleSection,
} from '../utils/wire/mod-envelope'
export {
  parseVelarosModEnvelope,
  VelarosModCapabilityRequirementSchema,
  VelarosModCapabilityTokenSchema,
  VelarosModEnvelopeSchema,
  VelarosModManifestFileName,
  VelarosModModuleSectionSchema,
} from '../utils/wire/mod-envelope'
export type {
  KernelModPackDescriptor,
  KernelModPackKind,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../utils/wire/mods'
export {
  KernelModPackDescriptorSchema,
  KernelModPackKindSchema,
  ModsInstallFromDirectoryRequestSchema,
  ModsInstallFromDirectoryResponseSchema,
  ModsListRequestSchema,
  ModsListResponseSchema,
  ModsSetEnabledRequestSchema,
  ModsSetEnabledResponseSchema,
} from '../utils/wire/mods'
export type { KernelProtocolNegotiation } from '../utils/wire/negotiation'
export {
  isKernelProtocolAccepted,
  negotiateKernelProtocol,
} from '../utils/wire/negotiation'
export type {
  RemoteNodeAuthenticate,
  RemoteNodeCancel,
  RemoteNodeCapabilityDescriptor,
  RemoteNodeChallenge,
  RemoteNodeClientFrame,
  RemoteNodeCloseCodeValue,
  RemoteNodeError,
  RemoteNodeFatal,
  RemoteNodeHello,
  RemoteNodeIdentity,
  RemoteNodeInvoke,
  RemoteNodeManifest,
  RemoteNodeManifestChanged,
  RemoteNodeOperationDescriptor,
  RemoteNodePair,
  RemoteNodePaired,
  RemoteNodePing,
  RemoteNodePlatform,
  RemoteNodePong,
  RemoteNodeProgress,
  RemoteNodeReady,
  RemoteNodeResult,
  RemoteNodeServerFrame,
  RemoteNodeToolDescriptor,
} from '../utils/wire/remote-node'
export {
  RemoteNodeAuthenticateSchema,
  RemoteNodeCancelSchema,
  RemoteNodeCapabilityDescriptorSchema,
  RemoteNodeChallengeSchema,
  RemoteNodeClientFrameSchema,
  RemoteNodeCloseCode,
  RemoteNodeErrorSchema,
  RemoteNodeFatalSchema,
  RemoteNodeHeartbeatIntervalMs,
  RemoteNodeHelloSchema,
  RemoteNodeIdentitySchema,
  RemoteNodeIdleTimeoutMs,
  RemoteNodeInvokeSchema,
  RemoteNodeManifestChangedSchema,
  RemoteNodeManifestSchema,
  RemoteNodeMaxFrameBytes,
  RemoteNodeOperationDescriptorSchema,
  RemoteNodePairedSchema,
  RemoteNodePairingLifetimeMs,
  RemoteNodePairingLockoutMs,
  RemoteNodePairingMaxFailures,
  RemoteNodePairSchema,
  RemoteNodePingSchema,
  RemoteNodePlatformSchema,
  RemoteNodePongSchema,
  RemoteNodeProgressSchema,
  RemoteNodeProtocolVersion,
  RemoteNodeReadySchema,
  RemoteNodeResultSchema,
  RemoteNodeServerFrameSchema,
  RemoteNodeToolDescriptorSchema,
} from '../utils/wire/remote-node'
export { KernelProtocolWireSchemas } from '../utils/wire/snapshot'
export * as KernelAbi from './contracts-abi'
export * as KernelProtocol from './contracts-protocol'
/**
 * kernel 协议主版本号。
 *
 * 每个版本只接受完全相同的 wire 版本。协议变化直接提升版本，旧数据不在运行时迁移。
 */
export type { OpenCapabilitySessionInput } from '../impl/client/CapabilitySession'
export { CapabilitySession, openCapabilitySessionOnTransport } from '../impl/client/CapabilitySession'
export { KernelClient } from '../impl/client/KernelClient'
export type { ConnectedKernelDaemon } from '../impl/client/KernelDaemonDirectory'
export { connectToKernelDaemon, discoverKernelDaemon } from '../impl/client/KernelDaemonDirectory'
export type { SocketKernelTransportOptions } from '../impl/client/SocketKernelTransport'
export { SocketKernelTransport } from '../impl/client/SocketKernelTransport'
export type {
  KernelLauncherErrorCode,
  KernelLauncherOptions,
  KernelLaunchResult,
  KernelVersionResolver,
  KernelVersionTarget,
} from '../impl/serve/KernelLauncher'
export { KernelLauncher, KernelLauncherError } from '../impl/serve/KernelLauncher'
export type {
  KernelRpcEndpoint,
  TcpKernelRpcEndpoint,
  UnixKernelRpcEndpoint,
} from '../types/client-endpoint'
export type {
  KernelRpcError,
  KernelRpcEventFrame,
  KernelRpcFailure,
  KernelRpcMethod,
  KernelRpcRequest,
  KernelRpcResponse,
  KernelRpcServerFrame,
  KernelRpcSuccess,
} from '../types/client-rpc-frames'
export { KernelRpcMethods } from '../types/client-rpc-frames'
export type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from '../types/client-transport'
export type { KernelServiceHealth, KernelServiceModuleHealth } from '../types/service-health'
export type { KernelCapabilityGrantErrorCode, KernelClientErrorCode } from '../utils/errors-client'
export { KernelCapabilityGrantErrorCodes, KernelClientError, KernelRpcClientError } from '../utils/errors-client'
export type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from '../utils/rpc/descriptor'
export {
  createDefaultKernelDaemonPaths,
  defaultKernelRuntimeDirectory,
  parseKernelDaemonDescriptor,
} from '../utils/rpc/descriptor'
export { KernelProtocolVersion } from '../utils/wire/version'
