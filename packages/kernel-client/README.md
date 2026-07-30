# @velaros-ai/kernel-client

**产品接入共享 Kernel 的瘦客户端**(kernel 域,住 `packages/kernel-client`)。

Kernel 夹在产品应用与 Mod 之间。本包是它的**朝上那一面**:
产品用它发现本机 Kernel、连上去、绑定能力、调用、订阅事件。
写 Mod 的人要的是**朝下那一面**,即 `@velaros-ai/core/kernel/abi`,不是本包。

```
产品应用  ──(本包)──▶  Kernel  ──(core/kernel/abi)──▶  Mod
```

## 什么时候用它、什么时候不用

只有 **serve 部署模式**(Kernel 跑成一个独立进程、被多个产品共享)才需要本包。
完整宿主在自己进程里装内核时,**直接 new `@velaros-ai/core/kernel`**——
不经过本包,也不经过 kernel-serve(宪章 §15.1「库优先,进程可选」)。

## 分区

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/kernel-client` | 客户端主面:发现 / 连接 / 能力会话 / mod 管理 / 事件 / launcher;并转出 `@velaros-ai/core/kernel/protocol` 全部 wire 类型 |
| `@velaros-ai/kernel-client/contracts` | serve 模式的连线契约(daemon descriptor / endpoint / RPC 帧),并转出 `@velaros-ai/core/kernel/contracts` 的服务面契约(健康度、identity 入参) |

**wire 协议本身不住在这里**——它住 `@velaros-ai/core/kernel/protocol`(P2 起唯一事实来源),
客户端与内核逐字节共享同一份定义。本包只添「怎么把帧送过去」。

## 核心概念

- **`KernelClient`** —— 传输之上的产品门面。表面**刻意收窄**成四组:
  连接(`handshake` / `health` / `dispose`)、能力绑定(`openCapabilitySession`)、
  mod 管理(`listMods` / `setModEnabled` / `installModFromDirectory`)、事件订阅。
  identity 的 session/run 注册表和裸 `capability.call` 是 wire/transport 关注点,
  **不是产品 API**,所以不挂在这个类上。
- **`CapabilitySession`** —— 一个消费场景绑定一次能力集。
  调用必须走 session,Kernel 才能按 open 时声明的 `requires` 执法;
  `dispose` 关闭服务端绑定。**这是调用能力的唯一受支持路径。**
- **`KernelClientTransport` / `SocketKernelTransport`** —— 传输契约与它的
  Unix domain socket(Windows 走 loopback-only TCP)实现。
- **`discoverKernelDaemon` / `connectToKernelDaemon`** —— 本机 Kernel 发现、
  descriptor 校验与已验证握手。
- **`KernelLauncher`** —— 需要时 spawn 共享 Kernel 进程并附着上去。
  它**故意不认识安装布局**:哪个版本是 active 由 `KernelVersionResolver` 回答
  (实现归 `@velaros-ai/kernel-serve/updater`)。两者分开,版本切换才不会和进程启动打架。
- **`KernelClientError` / `KernelRpcClientError`** —— 发现期与 RPC 期的错误模型。
  0.2.x 的 `KernelDaemonError` 保留为 `KernelClientError` 的别名。

## 典型用法

连上去、看健康度:

```ts
import { connectToKernelDaemon } from '@velaros-ai/kernel-client'

const { client, handshake } = await connectToKernelDaemon()
const health = await client.health()
await client.dispose()
```

绑定能力并调用(`requires` 一次声明本场景要用的能力集,
`operations` / `scope` 传 `null` 表示不额外收窄):

```ts
import { KernelProtocolVersion } from '@velaros-ai/kernel-client'

const session = await client.openCapabilitySession({
  requires: [
    { capabilityId: 'velaros.workspace', operations: null, scope: null },
  ],
})

const response = await session.call({
  protocolVersion: KernelProtocolVersion,
  callId: crypto.randomUUID(),
  capabilityId: 'velaros.workspace',
  operation: 'listRoots',
  scope: null,
  input: {},
}, abortSignal)

await session.dispose()
```

只绑定**已装载**的能力;未装载会返回 `CAPABILITY_NOT_AVAILABLE`。连接断开则会话失效。

## 边界:本包不负责什么

没有 module host、没有能力路由、没有权限 broker、没有 daemon 生命周期、
没有进程管理,也没有任何宿主专属(Electron / renderer / IPC)代码。

- 内核本体 → `@velaros-ai/core/kernel`
- 进程装配 → `@velaros-ai/kernel-serve/daemon`
- 共享 Runtime 的安装与升级 → `@velaros-ai/kernel-serve/updater`

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/core` | 唯一仓内依赖:wire 协议与服务面契约的单源 |
| `@velaros-ai/kernel-serve` | 服务端对侧;它依赖本包(拿传输契约),本包不依赖它 |
