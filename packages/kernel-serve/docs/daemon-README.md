# `@velaros-ai/kernel-serve/daemon`

`velaros serve` 部署模式的配件:把 `@velaros-ai/core` 里的 **Kernel 库**装成本机进程。

内核本体(module ABI / wire 协议 / module host / capability registry / 权限 broker /
事件流 / namespaced state / KernelService)住在 `@velaros-ai/core/kernel`——它是**库**,
和宿主同进程同生命周期。本包只提供「把那套栈跑成一个独立进程」所需的装配件。

## 这里有什么

- `daemon/` —— daemon 生命周期、启停握手、endpoint 描述符落盘、ModStore 与 mod 装载、
  编译期 bundled pack 清单(`daemon/bundled-packs.ts`)。
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
| `@velaros-ai/kernel-serve/updater` | 共享 Runtime 的安装 / 切换 / 回滚 |

## 两种 pack:bundled 是编译期,installed 才是运行时

宪章 §15.2 层间铁律「`bundled` = 编译期依赖」+「`importSibling` 退役」。P4 起:

| | bundled | installed |
| --- | --- | --- |
| 来源 | 构建图(静态 import) | 用户目录 / 注册表(`mods.installFromDirectory`) |
| 记录 | `module` 在手,`specifier` = `bundled:<moduleId>` 身份 URI | `specifier` = 可 import 的路径 |
| 装载 | 取字段,零 IO | 动态 import,逐 pack 失败隔离 |
| 坏了会怎样 | **构建期红** | 该 pack 缺席 + 可读失败原因,Kernel 照常起 |

**本包自己只编进 sidecar 目录桩**(agent / model / browser:目录在 Kernel,实现在宿主那侧)。
具体能力(workspace / computer-runtime / system-tools …)的 bundled pack 归**宿主**的构建图——
依赖方向单向 ⑤→④→③→②,内核不认识能力包。宿主这样注入:

```ts
import { createWorkspaceKernelModule } from '@velaros-ai/workspace'
import { bootKernelDaemon, createBundledModPack, toBundledPackRecords } from '@velaros-ai/kernel-serve/daemon'

await bootKernelDaemon({
  kernelVersion,
  modPacks: toBundledPackRecords([
    createBundledModPack({
      id: 'system.workspace',
      module: createWorkspaceKernelModule({ workspace: { root } }),
    }),
  ]),
})
```

## 已知欠账

Platform 内还没有 `velaros serve` 宿主包,上面那条能力注入线因此只有契约与测试,没有生产消费者。
