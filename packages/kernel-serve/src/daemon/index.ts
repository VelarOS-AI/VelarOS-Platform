// 门面：@velaros-ai/kernel-serve/daemon —— serve 部署模式的配件（宪章 §15.3）。
//
// 内核本体（module host / capability registry / 权限 broker / 事件流 / 状态 / wire 协议）住在
// `@velaros-ai/core/kernel`；本包只负责把它装成本机进程：daemon 生命周期 + 本机 RPC 前脸 +
// ModStore + 进程内传输。完整宿主进程内装栈**不经本包**，直接 new 内核。
//
// 产品接入远端 Kernel 用 @velaros-ai/kernel-client；Mod 开发用 @velaros-ai/core/kernel/abi。
export * from './daemon'
export * from './internal'
export * from './rpc'
