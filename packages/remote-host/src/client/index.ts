// 门面:完整宿主(Mac / Desktop)一侧的远程能力节点接入面。
//
// 装配顺序是固定的,顺序错了会得到一张空能力面:
//   ① `new RemoteNodeClient({...})` + `await connect()` → 拿到节点身份与清单;
//   ② `createRemoteNodeProjection({ hostName, manifest })` → 命名空间化的模块面与工具面;
//   ③ `new RemoteNodeIsolationAdapter({ client, resolveBinding: projection.resolveBinding })`
//      作为 `isolationAdapters` 注入 Kernel,再注册 `projection.modules`;
//   ④ `projection.tools` 交给 Agent 主干注册。
// 清单变更(`client.onManifestChanged`)时从 ② 起整份重来:能力面变化必须走显式注册周期。
export * from './close-policy'
export * from './contracts'
export * from './credential-store'
export * from './handshake'
export * from './module-projection'
export * from './pending-calls'
export * from './RemoteNodeClient'
export * from './RemoteNodeIsolationAdapter'
export * from './ws-socket'
