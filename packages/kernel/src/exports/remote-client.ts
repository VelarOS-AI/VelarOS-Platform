// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 门面:完整宿主(Mac / Desktop)一侧的远程能力节点接入面。
//
// 装配顺序是固定的,顺序错了会得到一张空能力面:
//   ① `new RemoteNodeClient({...})` + `await connect()` → 拿到节点身份与清单;
//   ② 从 `@velaros-ai/kernel/remote` 调 `createRemoteNodeProjection()`;
//   ③ 从同一入口创建 `RemoteNodeIsolationAdapter`
//      作为 `isolationAdapters` 注入 Kernel,再注册 `projection.modules`;
//   ④ `projection.tools` 交给 Agent 主干注册。
// 清单变更(`client.onManifestChanged`)时从 ② 起整份重来:能力面变化必须走显式注册周期。
export { defaultRemoteNodeCredentialsPath, FileRemoteNodeCredentialStore } from '../impl/remote-client/FileRemoteNodeCredentialStore'
export { RemoteNodeClient } from '../impl/remote-client/RemoteNodeClient'
export type { RemoteNodePendingCallsHost } from '../impl/remote-client/RemoteNodePendingCalls'
export { createAbortError, RemoteNodePendingCalls } from '../impl/remote-client/RemoteNodePendingCalls'
export type {
  RemoteNodeClientErrorCode,
  RemoteNodeClientErrorInit,
  RemoteNodeClientOptions,
  RemoteNodeConnectionState,
  RemoteNodeCredentials,
  RemoteNodeCredentialStore,
  RemoteNodeInvokeRequest,
  RemoteNodeManifestListener,
  RemoteNodeProgressListener,
  RemoteNodeSession,
  RemoteNodeSocket,
  RemoteNodeSocketFactory,
  RemoteNodeStateListener,
  RemoteNodeStopListener,
  RemoteNodeUnsubscribe,
} from '../types/remote-client'
export {
  RemoteNodeClientErrorCodes,
} from '../types/remote-client'
export { RemoteNodeClientError } from '../utils/errors'
export type { RemoteNodeCloseAction } from '../utils/remote/close-policy'
export { computeReconnectDelayMs, planRemoteNodeCloseAction } from '../utils/remote/close-policy'
export type { RemoteNodeHandshakeInput, RemoteNodeHandshakeStep } from '../utils/remote/handshake'
export { planRemoteNodeHandshake } from '../utils/remote/handshake'
export { createRemoteNodeWebSocket } from '../utils/remote/ws-socket'
