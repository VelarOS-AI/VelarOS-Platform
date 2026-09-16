// 门面：@velaros-ai/kernel/client 的公开入口 —— 产品接入共享 Kernel 的唯一主要通道。
//
// 产品只依赖本包：发现本机 Kernel、连接、握手、调用能力、订阅事件、启动/附着共享进程。
// Kernel Host / Runtime / Daemon 实现属于 Kernel 内部基础设施，不从这里暴露。
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
export type { KernelClientErrorCode } from '../contract/constants'
export type { KernelRpcMethod } from '../contract/constants'
export { KernelClientErrorCodes } from '../contract/constants'
export { KernelRpcMethods } from '../contract/constants'
export type { ConnectedKernelDaemon } from '../contract/provides'
export type { KernelLaunchResult } from '../contract/provides'
export type { KernelEventSubscription } from '../contract/provides'
export type { KernelClientEventHandler, KernelClientTransport } from '../contract/requires'
export { CapabilitySession, openCapabilitySessionOnTransport } from '../impl/client/CapabilitySession'
export { KernelClient } from '../impl/client/KernelClient'
export { connectToKernelDaemon, discoverKernelDaemon } from '../impl/client/KernelDaemonDirectory'
export { SocketKernelTransport } from '../impl/client/SocketKernelTransport'
export type { KernelLauncherOptions } from '../impl/serve/KernelLauncher'
export { KernelLauncher } from '../impl/serve/KernelLauncher'
export type { OpenCapabilitySessionInput } from '../types/client'
export type { SocketKernelTransportOptions } from '../types/client'
export type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from '../types/kernel'
export type { KernelModuleHealthStatus } from '../types/kernel.js'
export type { KernelServiceHealth, KernelServiceModuleHealth } from '../types/kernel.js'
export type { KernelRpcEndpoint, TcpKernelRpcEndpoint, UnixKernelRpcEndpoint } from '../types/kernel.js'
export type { KernelVersionResolver, KernelVersionTarget } from '../types/serve'
export type { KernelRpcError, KernelRpcEventFrame, KernelRpcFailure, KernelRpcRequest, KernelRpcResponse, KernelRpcServerFrame, KernelRpcSuccess } from '../types/wire'
export { KernelClientError } from '../utils/errors'
export {
  createDefaultKernelDaemonPaths,
  defaultKernelRuntimeDirectory,
  parseKernelDaemonDescriptor,
} from '../utils/rpc/descriptor'
export { KernelProtocolVersion } from '../utils/wire/version'
