// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 门面:远程能力节点传输的共享内核(两侧共用的编解码、密钥与清单摘要)。
//
// 角色分工见 `@velaros-ai/kernel/contracts/protocol` 的 remote-node 契约:
// `./node` 是无头能力提供者(被调),`./client` 是完整宿主侧的 isolation adapter(主调)。
export { RemoteNodeProgressEventType } from '../contract/constants'
export type { RemoteNodeIsolationAdapterOptions } from '../impl/remote-client/RemoteNodeIsolationAdapter'
export {
  RemoteNodeIsolationAdapter,
} from '../impl/remote-client/RemoteNodeIsolationAdapter'
export type { RemoteNodeProjection } from '../impl/remote-client/RemoteNodeProjection'
export {
  createRemoteNodeProjection,
  namespaceRemoteId,
  namespaceRemoteToolName,
  RemoteNodeModuleApiVersion,
  RemoteNodeModuleVersion,
  slugifyRemoteHostName,
} from '../impl/remote-client/RemoteNodeProjection'
export { createRemoteNodeAuditLog } from '../impl/remote-node/FileRemoteNodeAuditLog'
export { createRemoteNodeServerCredentialStore } from '../impl/remote-node/FileRemoteNodeServerCredentialStore'
export type { RemoteNodeBindingResolver, RemoteNodeProgressEvent } from '../types/remote'
export type { RemoteNodeCapabilityBinding, RemoteNodeProjectionInput, RemoteNodeToolProjection } from '../types/remote'
export type { RemoteNodeKeyPair } from '../types/remote'
export type { FrameDecodeResult } from '../types/remote'
export {
  createChallenge,
  createClientId,
  createEpoch,
  createNodeId,
  createPairingCode,
  generateRemoteNodeKeyPair,
  signChallenge,
  verifyChallengeSignature,
} from '../utils/remote/crypto'
export { decodeClientFrame, decodeServerFrame, sendFrame } from '../utils/remote/frames'
export { computeManifestRevision, createManifest } from '../utils/remote/manifest'
