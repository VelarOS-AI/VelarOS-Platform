// 域：Kernel wire schema 注册表。产品域 schema 由各 capability protocol 自己锁定。
import {
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
import { KernelHandshakeSchema } from './handshake'
import {
  KernelRunIdentitySchema,
  KernelSessionIdentitySchema,
} from './identity'
import {
  KernelModPackDescriptorSchema,
  KernelModPackKindSchema,
  ModsInstallFromDirectoryRequestSchema,
  ModsInstallFromDirectoryResponseSchema,
  ModsListRequestSchema,
  ModsListResponseSchema,
  ModsSetEnabledRequestSchema,
  ModsSetEnabledResponseSchema,
} from './mods'
import {
  RemoteNodeAuthenticateSchema,
  RemoteNodeCancelSchema,
  RemoteNodeCapabilityDescriptorSchema,
  RemoteNodeChallengeSchema,
  RemoteNodeClientFrameSchema,
  RemoteNodeErrorSchema,
  RemoteNodeFatalSchema,
  RemoteNodeHelloSchema,
  RemoteNodeIdentitySchema,
  RemoteNodeInvokeSchema,
  RemoteNodeManifestChangedSchema,
  RemoteNodeManifestSchema,
  RemoteNodeOperationDescriptorSchema,
  RemoteNodePairedSchema,
  RemoteNodePairSchema,
  RemoteNodePingSchema,
  RemoteNodePongSchema,
  RemoteNodeProgressSchema,
  RemoteNodeReadySchema,
  RemoteNodeResultSchema,
  RemoteNodeServerFrameSchema,
  RemoteNodeToolDescriptorSchema,
} from './remote-node'

// 握手与能力协商域的 schema 分片。
const handshakeWireSchemas = {
  KernelHandshake: KernelHandshakeSchema,
}

// 可注入模块、能力令牌与通用调用信封。
const capabilityWireSchemas = {
  CapabilityIsolation: CapabilityIsolationSchema,
  CapabilityToken: CapabilityTokenSchema,
  CapabilityRequirement: CapabilityRequirementSchema,
  ScopeRef: ScopeRefSchema,
  ResourceRef: ResourceRefSchema,
  KernelModuleDescriptor: KernelModuleDescriptorSchema,
  CapabilityCallRequest: CapabilityCallRequestSchema,
  CapabilityCallError: CapabilityCallErrorSchema,
  CapabilityCallSuccess: CapabilityCallSuccessSchema,
  CapabilityCallFailure: CapabilityCallFailureSchema,
  CapabilityCallResponse: CapabilityCallResponseSchema,
  CapabilityRequireItem: CapabilityRequireItemSchema,
  CapabilitySessionOpenRequest: CapabilitySessionOpenRequestSchema,
  CapabilitySessionOpenSuccess: CapabilitySessionOpenSuccessSchema,
  CapabilitySessionOpenFailure: CapabilitySessionOpenFailureSchema,
  CapabilitySessionOpenResponse: CapabilitySessionOpenResponseSchema,
  CapabilitySessionCloseRequest: CapabilitySessionCloseRequestSchema,
  CapabilitySessionCloseResponse: CapabilitySessionCloseResponseSchema,
}

const identityWireSchemas = {
  KernelSessionIdentity: KernelSessionIdentitySchema,
  KernelRunIdentity: KernelRunIdentitySchema,
}

const modsWireSchemas = {
  KernelModPackKind: KernelModPackKindSchema,
  KernelModPackDescriptor: KernelModPackDescriptorSchema,
  ModsListRequest: ModsListRequestSchema,
  ModsListResponse: ModsListResponseSchema,
  ModsSetEnabledRequest: ModsSetEnabledRequestSchema,
  ModsSetEnabledResponse: ModsSetEnabledResponseSchema,
  ModsInstallFromDirectoryRequest: ModsInstallFromDirectoryRequestSchema,
  ModsInstallFromDirectoryResponse: ModsInstallFromDirectoryResponseSchema,
}

// 远程能力节点 transport 绑定域(宪章 §15 原则一 isolation:'remote')。
const remoteNodeWireSchemas = {
  RemoteNodeIdentity: RemoteNodeIdentitySchema,
  RemoteNodeOperationDescriptor: RemoteNodeOperationDescriptorSchema,
  RemoteNodeCapabilityDescriptor: RemoteNodeCapabilityDescriptorSchema,
  RemoteNodeToolDescriptor: RemoteNodeToolDescriptorSchema,
  RemoteNodeManifest: RemoteNodeManifestSchema,
  RemoteNodeError: RemoteNodeErrorSchema,
  RemoteNodeHello: RemoteNodeHelloSchema,
  RemoteNodePair: RemoteNodePairSchema,
  RemoteNodeAuthenticate: RemoteNodeAuthenticateSchema,
  RemoteNodeInvoke: RemoteNodeInvokeSchema,
  RemoteNodeCancel: RemoteNodeCancelSchema,
  RemoteNodePing: RemoteNodePingSchema,
  RemoteNodeClientFrame: RemoteNodeClientFrameSchema,
  RemoteNodeChallenge: RemoteNodeChallengeSchema,
  RemoteNodePaired: RemoteNodePairedSchema,
  RemoteNodeReady: RemoteNodeReadySchema,
  RemoteNodeManifestChanged: RemoteNodeManifestChangedSchema,
  RemoteNodeResult: RemoteNodeResultSchema,
  RemoteNodeProgress: RemoteNodeProgressSchema,
  RemoteNodePong: RemoteNodePongSchema,
  RemoteNodeFatal: RemoteNodeFatalSchema,
  RemoteNodeServerFrame: RemoteNodeServerFrameSchema,
}

/**
 * 全部协议 wire schema 的命名注册表，按域分片组装（§12.8 对象按域分片，不按时间生长）。
 *
 * 键为契约名，值为该契约的严格 zod 校验器；构建期逐个序列化进 dist/schema-snapshot.json。
 */
export const KernelProtocolWireSchemas = {
  ...handshakeWireSchemas,
  ...capabilityWireSchemas,
  ...identityWireSchemas,
  ...modsWireSchemas,
  ...remoteNodeWireSchemas,
}
