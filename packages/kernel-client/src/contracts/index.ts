// 门面：Client 与 Kernel 内部服务端共享的契约（descriptor、endpoint、RPC 帧、健康度、identity 入参）。
//
// 服务端实现这些形状，客户端消费它们；两侧引用同一份定义，禁止各写一份。
export * from './descriptor'
export * from './endpoint'
export * from './health'
export * from './identity-inputs'
export * from './rpc-frames'
