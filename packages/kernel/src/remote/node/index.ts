// Platform Kernel owns the host-neutral remote-node implementation.
// 门面:远程能力节点的 **Node 侧**(无头能力提供者,被调方)。
//
// 宿主注入四个端口——能力派发、清单来源、凭据存储、审计落盘——本包只负责把它们接到 wire 上。
// Client 侧(完整宿主的 isolation adapter,主调方)住在 `../client`;两侧只经由
// `@velaros-ai/kernel/contracts/protocol` 的 remote-node 契约相认,不互相 import。
export type { RemoteNodeFileAuditLogOptions } from './audit-log'
export { createRemoteNodeFileAuditLog } from './audit-log'
export type { RemoteNodeCallRunnerOptions } from './call-runner'
export {
  RemoteNodeCallRunner,
  RemoteNodeCompletedCallCapacity,
  RemoteNodeInvocationPool,
  RemoteNodeResultCache,
} from './call-runner'
export type {
  RemoteNodeActivityEvent,
  RemoteNodeActivitySink,
  RemoteNodeAuditEntry,
  RemoteNodeAuditSink,
  RemoteNodeCapabilityInvoker,
  RemoteNodeCapabilityInvokeRequest,
  RemoteNodeCapabilityInvokeResult,
  RemoteNodeCredentialStore,
  RemoteNodeManifestSource,
  RemoteNodePairedCredential,
  RemoteNodeServerOptions,
  RemoteNodeServerStatus,
} from './contracts'
export { RemoteNodeSocketPath } from './contracts'
export { createRemoteNodeFileCredentialStore } from './credential-store'
export type { RemoteNodePairingGateOptions } from './pairing'
export { RemoteNodePairingGate } from './pairing'
export { RemoteNodeServer } from './RemoteNodeServer'
