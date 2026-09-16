// 门面：Kernel wire 协议契约的唯一事实来源（宪章 §15.6「Ring 0 只要 protocol/调用信封」）。
//
// 一份 zod schema，三侧消费：Kernel 库自身的 runtime、serve 配件的 RPC 前脸、瘦客户端。
// 禁止另写一份 request/response 类型；形状漂移由 check:kernel-schemas 快照门拦截。
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
} from './capability'
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
} from './capability'
export type { KernelHandshake } from './handshake'
export { KernelHandshakeSchema } from './handshake'
export type { KernelRunIdentity, KernelSessionIdentity } from './identity'
export { KernelRunIdentitySchema, KernelSessionIdentitySchema } from './identity'
export type {
  VelarosModEnvelope,
  VelarosModEnvelopeParseResult,
  VelarosModManifestDiagnostic,
  VelarosModModuleSection,
} from './mod-manifest'
export {
  parseVelarosModEnvelope,
  VelarosModCapabilityRequirementSchema,
  VelarosModCapabilityTokenSchema,
  VelarosModEnvelopeSchema,
  VelarosModManifestFileName,
  VelarosModModuleSectionSchema,
} from './mod-manifest'
export type {
  KernelModPackDescriptor,
  KernelModPackKind,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from './mods'
export {
  KernelModPackDescriptorSchema,
  KernelModPackKindSchema,
  ModsInstallFromDirectoryRequestSchema,
  ModsInstallFromDirectoryResponseSchema,
  ModsListRequestSchema,
  ModsListResponseSchema,
  ModsSetEnabledRequestSchema,
  ModsSetEnabledResponseSchema,
} from './mods'
export type { KernelProtocolNegotiation } from './negotiation'
export { isKernelProtocolAccepted, negotiateKernelProtocol } from './negotiation'
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
} from './remote-node'
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
} from './remote-node'
export { KernelProtocolWireSchemas } from './schema-snapshot'
/**
 * kernel 协议主版本号。
 *
 * 每个版本只接受完全相同的 wire 版本。协议变化直接提升版本，旧数据不在运行时迁移。
 */
export { KernelProtocolVersion } from './version'
