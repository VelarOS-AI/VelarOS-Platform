# @velaros-ai/kernel

VelarOS 的 library-first 微内核。一个领域只发布一个包，职责通过最小子路径分区：

- `@velaros-ai/kernel/contracts/abi`：Mod ABI。
- `@velaros-ai/kernel/contracts/protocol`：wire schema 与调用信封。
- `@velaros-ai/kernel/runtime`：公共 `new Kernel()` 进程内入口、底层 module host、权限、事件、状态与 `KernelService`。
- `@velaros-ai/kernel/client`：serve 模式和瘦客户端接入面。
- `@velaros-ai/kernel/serve`：可选 daemon/RPC 装配。
- `@velaros-ai/kernel/serve/updater`：共享 Runtime 安装、切换与回滚。
- `@velaros-ai/kernel/remote`：remote isolation adapter、清单投影与两端共享算法。
- `@velaros-ai/kernel/remote/client`：配对、认证、重连、调用与凭据端口。
- `@velaros-ai/kernel/remote/node`：无头能力节点服务端、审计与调用幂等。

Kernel 默认与完整宿主同进程、同生命周期；`serve` 只是同一运行栈的可选部署方式，不是第二个内核。
Desktop / Workbench 等完整宿主直接组合公共 `Kernel`，只选择能力模块、产品权限策略与生命周期
失败策略；不得在产品仓重写能力版本解析、调用权限门或 host 生命周期。

## 只读组合快照

`Kernel.describeComposition()` 与 `KernelService.describeComposition()` 返回确定性、冻结的
`KernelCompositionSnapshot`：模块解析顺序、声明与生命周期状态，以及能力提供者、是否真实激活和
当前 generation。`active: false` 明确区分“manifest 声明了能力”和“本代服务已经注册成功”。

这是观测面，不是配置面。Kernel 不提供把快照反向 patch 回运行时的入口；模块注册、权限、激活、
回滚与服务所有权仍由 Ring 0 裁决。可选 serve 部署继续受版本化 wire 协议和握手约束，本地快照
不会暗中扩大远端协议或授权。
