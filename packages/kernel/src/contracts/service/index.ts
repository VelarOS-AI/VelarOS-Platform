// 门面：Kernel 服务面契约(健康度、identity 入参)。
//
// 服务端(Kernel 库自身)产出这些形状，瘦客户端与 serve 配件消费它们；两侧引用同一份定义。
export * from './health'
export * from './identity-inputs'
