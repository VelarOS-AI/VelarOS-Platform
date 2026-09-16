// 门面：`@velaros-ai/kernel/remote` —— 远程能力节点的两端。
//
// Node 侧（无头能力提供者，被调）：`createRemoteNodeServer` 加三个文件存储工厂；
// Client 侧（完整宿主的 isolation adapter，主调）：`createRemoteNodeClient`、
// `createRemoteNodeProjection`、`createRemoteNodeIsolationAdapter`。
// 两侧的装配顺序是固定的，顺序错了会得到一张空能力面：
//   ① `createRemoteNodeClient({...})` + `await connect()` → 拿到节点身份与清单；
//   ② `createRemoteNodeProjection()` 把清单投影成本地代理模块；
//   ③ `createRemoteNodeIsolationAdapter()` 作为 `isolationAdapters` 注入内核，再注册
//      `projection.modules`；④ `projection.tools` 交给 Agent 主干注册。
// 清单变更（`client.onManifestChanged`）时从 ② 起整份重来：能力面变化必须走显式注册周期。
//
// 这条入口独有第三方依赖 `ws` 与 `node:http`，进程内宿主不该为此加载它们。
export { createRemoteNodeClientCredentialStore } from './impl/remote-client/FileRemoteNodeCredentialStore'
export { createRemoteNodeClient } from './impl/remote-client/RemoteNodeClient'
export { createRemoteNodeIsolationAdapter } from './impl/remote-client/RemoteNodeIsolationAdapter'
export { createRemoteNodeProjection } from './impl/remote-client/RemoteNodeProjection'
export { createRemoteNodeAuditLog } from './impl/remote-node/FileRemoteNodeAuditLog'
export { createRemoteNodeServerCredentialStore } from './impl/remote-node/FileRemoteNodeServerCredentialStore'
export { createRemoteNodeServer } from './impl/remote-node/RemoteNodeServer'
