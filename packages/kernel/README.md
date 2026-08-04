# @velaros-ai/kernel

VelarOS 的 library-first 微内核。一个领域只发布一个包，职责通过最小子路径分区：

- `@velaros-ai/kernel/contracts/abi`：Mod ABI。
- `@velaros-ai/kernel/contracts/protocol`：wire schema 与调用信封。
- `@velaros-ai/kernel/runtime`：公共 `new Kernel()` 进程内入口、底层 module host、权限、事件、状态与 `KernelService`。
- `@velaros-ai/kernel/client`：serve 模式和瘦客户端接入面。
- `@velaros-ai/kernel/serve`：可选 daemon/RPC 装配。
- `@velaros-ai/kernel/serve/updater`：共享 Runtime 安装、切换与回滚。

Kernel 默认与完整宿主同进程、同生命周期；`serve` 只是同一运行栈的可选部署方式，不是第二个内核。
Desktop / Workbench 等完整宿主直接组合公共 `Kernel`，只选择能力模块、产品权限策略与生命周期
失败策略；不得在产品仓重写能力版本解析、调用权限门或 host 生命周期。
