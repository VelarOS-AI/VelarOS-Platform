// 门面：Kernel wire 协议契约的唯一事实来源。
//
// 本目录是 Client 与 Kernel 内部 runtime 共享的协议实现（一份 zod schema，两侧消费）。
// Kernel 内部通过 `@velaros-ai/kernel-client/protocol` 引入，禁止另写一份 request/response 类型。
export * from './capability'
export * from './handshake'
export * from './identity'
export * from './mods'
export * from './negotiation'
export * from './schema-snapshot'
