// 门面：Kernel wire 协议契约的唯一事实来源（宪章 §15.6「Ring 0 只要 protocol/调用信封」）。
//
// 一份 zod schema，三侧消费：Kernel 库自身的 runtime、serve 配件的 RPC 前脸、瘦客户端。
// 禁止另写一份 request/response 类型；形状漂移由 check:kernel-schemas 快照门拦截。
export * from './capability'
export * from './handshake'
export * from './identity'
export * from './mods'
export * from './negotiation'
export * from './schema-snapshot'
