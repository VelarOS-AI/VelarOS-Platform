# @velaros-ai/kernel

VelarOS 的 library-first 微内核。一个领域只发布一个包，职责按运行环境分成五个入口：

- `@velaros-ai/kernel`：进程内内核（`createKernel`）、模块 SDK（`kernelModules`）、mod 信封解析
  （`velarosModEnvelopes`）与全部常量表；部署形态的接口也一律从这里以类型出包。任何环境可加载。
- `@velaros-ai/kernel/contracts`：常量表与可移植契约数据（Mod ABI 与 wire 两套坐标的数据形状）。
  任何环境可加载，是根入口的可移植子集。
- `@velaros-ai/kernel/client`：附着到已运行守护进程的瘦客户端（`kernelDaemons`）。
- `@velaros-ai/kernel/serve`：可选的守护进程装配、本机 RPC、ModStore、启动器与共享 Runtime 更新器。
- `@velaros-ai/kernel/remote`：远程能力节点两端——Client 侧的配对/认证/重连/调用与投影，
  Node 侧的无头服务端、审计与调用幂等。

类不出包：一律用工厂（`createKernel`、`createKernelLauncher`、`createKernelUpdater`、
`createRemoteNodeClient`、`createRemoteNodeServer`…）。错误也不出类，外面按 `contract/constants.ts`
里的码表判断。

Kernel 默认与完整宿主同进程、同生命周期；`serve` 只是同一运行栈的可选部署方式，不是第二个内核。
Desktop / Workbench 等完整宿主直接 `createKernel()`，只选择能力模块、产品权限策略与生命周期
失败策略；不得在产品仓重写能力版本解析、调用权限门或 host 生命周期。

## 只读组合快照

`kernel.describeComposition()`（serve 形态是 `booted.service.describeComposition()`）返回确定性、冻结的
`KernelCompositionSnapshot`：模块解析顺序、声明与生命周期状态，以及能力提供者、是否真实激活和
当前 generation。`active: false` 明确区分“manifest 声明了能力”和“本代服务已经注册成功”。

这是观测面，不是配置面。Kernel 不提供把快照反向 patch 回运行时的入口；模块注册、权限、激活、
回滚与服务所有权仍由 Ring 0 裁决。可选 serve 部署继续受版本化 wire 协议和握手约束，本地快照
不会暗中扩大远端协议或授权。
