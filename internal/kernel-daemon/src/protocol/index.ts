// 门面：Kernel 内部访问 wire 协议的唯一入口。
//
// wire schema 的实现住在 `@velaros-ai/kernel-client/protocol` —— Client 与 Kernel 必须逐字节共享同一份
// zod 定义，而 Client 是已发布包、内部 `src/` 不是，所以实现落在可发布的那一侧，内部通过本桶文件消费。
// 依赖方向仍然合规：Kernel 内部 → 协议契约，Client 不反向依赖 Host/Runtime。
// Kernel 内部代码一律 `from '../protocol'`，不要直接写包路径，换实现位置时只改这一处。
export * from '@velaros-ai/kernel-client/protocol'
