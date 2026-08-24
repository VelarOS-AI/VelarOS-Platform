// Platform Kernel owns the host-neutral remote-node implementation.
// 门面:远程能力节点传输的共享内核(两侧共用的编解码、密钥与清单摘要)。
//
// 角色分工见 `@velaros-ai/kernel/contracts/protocol` 的 remote-node 契约:
// `./node` 是无头能力提供者(被调),`./client` 是完整宿主侧的 isolation adapter(主调)。
export * from './module-projection'
export * from './RemoteNodeIsolationAdapter'
export * from './shared/crypto'
export * from './shared/frames'
export * from './shared/manifest'
