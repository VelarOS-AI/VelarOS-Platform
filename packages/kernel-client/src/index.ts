// 门面：@velaros-ai/kernel-client 的公开入口 —— 产品接入共享 Kernel 的唯一主要通道。
//
// 产品只依赖本包：发现本机 Kernel、连接、握手、调用能力、订阅事件、启动/附着共享进程。
// Kernel Host / Runtime / Daemon 实现属于 Kernel 内部基础设施，不从这里暴露。
export * from './CapabilitySession'
export * from './contracts'
export * from './discovery'
export * from './errors'
export * from './KernelClient'
export * from './KernelLauncher'
export * from './socket-transport'
export * from './transport'
export * from '@velaros-ai/core/kernel/protocol'

// 0.2.x 的 `KernelDaemonError` 在 0.3 统一为 `KernelClientError`；保留旧名以减少调用点改动。
export { KernelClientError as KernelDaemonError } from './errors'
