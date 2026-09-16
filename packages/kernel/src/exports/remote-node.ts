// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 门面:远程能力节点的 **Node 侧**(无头能力提供者,被调方)。
//
// 宿主注入四个端口——能力派发、清单来源、凭据存储、审计落盘——本包只负责把它们接到 wire 上。
// Client 侧(完整宿主的 isolation adapter,主调方)住在 `../client`;两侧只经由
// `@velaros-ai/kernel/contracts/protocol` 的 remote-node 契约相认,不互相 import。
export type { RemoteNodeFileAuditLogOptions } from '../impl/remote-node/FileRemoteNodeAuditLog'
export { createRemoteNodeFileAuditLog } from '../impl/remote-node/FileRemoteNodeAuditLog'
export { createRemoteNodeFileCredentialStore } from '../impl/remote-node/FileRemoteNodeServerCredentialStore'
export type { RemoteNodeCallRunnerOptions } from '../impl/remote-node/RemoteNodeCallRunner'
export {
  RemoteNodeCallRunner,
  RemoteNodeCompletedCallCapacity,
  RemoteNodeInvocationPool,
  RemoteNodeResultCache,
} from '../impl/remote-node/RemoteNodeCallRunner'
export type { RemoteNodePairingGateOptions } from '../impl/remote-node/RemoteNodePairingGate'
export { RemoteNodePairingGate } from '../impl/remote-node/RemoteNodePairingGate'
export { RemoteNodeServer } from '../impl/remote-node/RemoteNodeServer'
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
} from '../types/remote-node'
export { RemoteNodeSocketPath } from '../types/remote-node'
