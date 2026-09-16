// 门面：@velaros-ai/kernel/client 的公开入口 —— 产品接入共享 Kernel 的唯一主要通道。
//
// 产品只依赖本包：发现本机 Kernel、连接、握手、调用能力、订阅事件、启动/附着共享进程。
// Kernel Host / Runtime / Daemon 实现属于 Kernel 内部基础设施，不从这里暴露。
export * as KernelAbi from '../contracts/abi'
export type { KernelModuleHealthStatus } from '../contracts/abi/module'
export * as KernelProtocol from '../contracts/protocol'
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
} from '../contracts/protocol/capability'
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
} from '../contracts/protocol/capability'
export type { KernelHandshake } from '../contracts/protocol/handshake'
export { KernelHandshakeSchema } from '../contracts/protocol/handshake'
export type {
  VelarosModEnvelope,
  VelarosModEnvelopeParseResult,
  VelarosModManifestDiagnostic,
  VelarosModModuleSection,
} from '../contracts/protocol/mod-manifest'
export {
  parseVelarosModEnvelope,
  VelarosModCapabilityRequirementSchema,
  VelarosModCapabilityTokenSchema,
  VelarosModEnvelopeSchema,
  VelarosModManifestFileName,
  VelarosModModuleSectionSchema,
} from '../contracts/protocol/mod-manifest'
export type {
  KernelModPackDescriptor,
  KernelModPackKind,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../contracts/protocol/mods'
export {
  KernelModPackDescriptorSchema,
  KernelModPackKindSchema,
  ModsInstallFromDirectoryRequestSchema,
  ModsInstallFromDirectoryResponseSchema,
  ModsListRequestSchema,
  ModsListResponseSchema,
  ModsSetEnabledRequestSchema,
  ModsSetEnabledResponseSchema,
} from '../contracts/protocol/mods'
export type { KernelProtocolNegotiation } from '../contracts/protocol/negotiation'
export {
  isKernelProtocolAccepted,
  negotiateKernelProtocol,
} from '../contracts/protocol/negotiation'
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
} from '../contracts/protocol/remote-node'
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
} from '../contracts/protocol/remote-node'
export { KernelProtocolWireSchemas } from '../contracts/protocol/schema-snapshot'
/**
 * kernel 协议主版本号。
 *
 * 每个版本只接受完全相同的 wire 版本。协议变化直接提升版本，旧数据不在运行时迁移。
 */
export { KernelProtocolVersion } from '../contracts/protocol/version'
export type { KernelServiceHealth, KernelServiceModuleHealth } from '../contracts/service/health'
export type { OpenCapabilitySessionInput } from './CapabilitySession'
export { CapabilitySession, openCapabilitySessionOnTransport } from './CapabilitySession'
export type { KernelDaemonEndpointDescriptor, KernelDaemonPaths } from './contracts/descriptor'
export {
  createDefaultKernelDaemonPaths,
  defaultKernelRuntimeDirectory,
  parseKernelDaemonDescriptor,
} from './contracts/descriptor'
export type {
  KernelRpcEndpoint,
  TcpKernelRpcEndpoint,
  UnixKernelRpcEndpoint,
} from './contracts/endpoint'
export type {
  KernelRpcError,
  KernelRpcEventFrame,
  KernelRpcFailure,
  KernelRpcMethod,
  KernelRpcRequest,
  KernelRpcResponse,
  KernelRpcServerFrame,
  KernelRpcSuccess,
} from './contracts/rpc-frames'
export { KernelRpcMethods } from './contracts/rpc-frames'
export type { ConnectedKernelDaemon } from './discovery'
export { connectToKernelDaemon, discoverKernelDaemon } from './discovery'
export type { KernelCapabilityGrantErrorCode, KernelClientErrorCode } from './errors'
export { KernelCapabilityGrantErrorCodes, KernelClientError, KernelRpcClientError } from './errors'
export { KernelClient } from './KernelClient'
export type {
  KernelLauncherErrorCode,
  KernelLauncherOptions,
  KernelLaunchResult,
  KernelVersionResolver,
  KernelVersionTarget,
} from './KernelLauncher'
export { KernelLauncher, KernelLauncherError } from './KernelLauncher'
export type { SocketKernelTransportOptions } from './socket-transport'
export { SocketKernelTransport } from './socket-transport'
export type {
  KernelClientEventHandler,
  KernelClientTransport,
  KernelEventSubscription,
} from './transport'
