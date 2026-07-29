# `@velaros-ai/kernel-daemon`

`velaros serve` 部署模式的配件:把 `@velaros-ai/core` 里的 **Kernel 库**装成本机进程。

内核本体(module ABI / wire 协议 / module host / capability registry / 权限 broker /
事件流 / namespaced state / KernelService)住在 `@velaros-ai/core/kernel`——它是**库**,
和宿主同进程同生命周期。本包只提供「把那套栈跑成一个独立进程」所需的装配件。

## 这里有什么

- `daemon/` —— daemon 生命周期、启停握手、endpoint 描述符落盘、ModStore 与 mod 装载、
  system pack 注册(`packs/` 里的瘦入口)。
- `rpc/` —— 本机 RPC 前脸:换行分隔 JSON、Unix domain socket(Windows 走 loopback-only TCP)、
  帧编解码与鉴权。
- `internal/` —— 进程内传输:与 RPC 同语义、免序列化的 `KernelClientTransport` 实现。
- `src/main.ts` —— 进程入口(`velaros-kernel-daemon`),被 launcher spawn。

## 这里**没有**什么

没有第二个内核。module host、能力注册、权限判定、事件与状态全部在 `@velaros-ai/core/kernel`,
本包只调用它们。完整宿主进程内装栈**不经过本包也不经过 kernel-client**——直接 new 内核即可
(宪章 §15.1 原则一「库优先,进程可选」/ §15.3)。

## 相关包

| 包 | 角色 |
| --- | --- |
| `@velaros-ai/core/kernel` | Kernel 库本体(本包的唯一内核依赖) |
| `@velaros-ai/core/kernel/abi` | Mod 开发面 |
| `@velaros-ai/kernel-client` | 瘦客户端接入面(共享 serve 模式的连线契约) |
| `@velaros-ai/kernel-updater` | 共享 Runtime 的安装 / 切换 / 回滚 |

## 已知欠账

`packs/pack-resolve.mjs` 的 `importSibling` 仍按磁盘布局找能力包 dist(路径已在 P2 改成同仓
`packages/<cap>/dist`)。整套机制在 P4 换成 workspace 直连,见宪章 §15.2 层间铁律。
