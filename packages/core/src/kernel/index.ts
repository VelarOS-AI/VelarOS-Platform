// 门面：Kernel 库本体（宪章 §15.2 第 ② 层 / §15.4「core 就是 Kernel 库」）。
//
// 本目录是 VelarOS 内核基础层的唯一实现：module ABI + module host + capability registry
// + 权限 broker + 事件流 + namespaced state + KernelService 运行态。它是**库**不是进程——
// 进程形态（daemon / serve 的 RPC 前脸、launcher）住在 `@velaros-ai/kernel-daemon`，
// 内核本体对进程一无所知（arch 门机械锁死 core 不得依赖 kernel-daemon / kernel-client）。
//
// 四个消费面：
//   `@velaros-ai/core/kernel/abi`       Mod 开发面（module ABI / capability token / 权限 / 事件 / 状态）
//   `@velaros-ai/core/kernel/protocol`  wire 协议契约（调用信封，唯一事实来源）
//   `@velaros-ai/core/kernel/contracts` 服务面契约（健康度、identity 入参）
//   `@velaros-ai/core/kernel`           本桶：宿主装配内核所需的全部实现
//
// 注意：protocol 与 abi 各有一份 ScopeRef / ResourceRef / CapabilityToken（wire 形状 vs 进程内形状），
// 故本桶**不**并入 protocol——要 wire 契约请走 `@velaros-ai/core/kernel/protocol`。
export * from './abi'
export * from './contracts'
export * from './host'
export * from './runtime'
