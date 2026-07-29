# Kernel 0.3 迁移说明

0.3 重构了 Kernel 仓库的包边界。**这是一次硬中断**:`@velaros-ai/kernel-protocol`、`@velaros-ai/kernel-host`、`@velaros-ai/kernel-service` 已从 registry 下线,不提供 deprecated shim。请按本文一次性迁移。

## 为什么

0.2.x 把 Kernel 的七个内部组件全部作为平级公开包发布,导致:

- 产品需要同时依赖 `kernel-protocol` + `kernel-service` 才能连上 Kernel,接入面不明确。
- Mod 能直接 import `kernel-host`,绕过 Host 伪造 moduleId、generation 与状态命名空间。
- 协议类型散在两处,Client 与 Runtime 有各写一份的持续压力。

0.3 收敛成两个开发入口 + 一个运维包,其余全部内部化:

| 角色 | 唯一主要入口 |
| --- | --- |
| 产品开发者(Desktop、Workbench、CLI、桥接) | `@velaros-ai/kernel-client` |
| Mod 开发者 | `@velaros-ai/kernel-sdk` |
| 共享 Runtime 的安装/升级/回滚 | `@velaros-ai/kernel-updater` |

Protocol、Host、Runtime、RPC、Daemon、Launcher 现在住在 Kernel 仓的 `src/`,不再发布。

## 包映射

| 0.2.x | 0.3 |
| --- | --- |
| `@velaros-ai/kernel-protocol` | `@velaros-ai/kernel-client`(根入口或 `/protocol` 子入口) |
| `@velaros-ai/kernel-service`(客户端部分) | `@velaros-ai/kernel-client` |
| `@velaros-ai/kernel-service`(服务端部分) | Kernel 内部 `src/runtime`、`src/rpc`、`src/daemon` —— 不再发布 |
| `@velaros-ai/kernel-host` | Kernel 内部 `src/host` —— 不再发布 |
| `@velaros-ai/kernel-sdk` | `@velaros-ai/kernel-sdk`(不变) |

## 产品应用的改法

绝大多数产品只需要改 import 来源,符号名没变。

```diff
-import {
-  CapabilityCallRequest,
-  KernelProtocolVersion,
-} from '@velaros-ai/kernel-protocol'
-import {
-  connectToKernelDaemon,
-  discoverKernelDaemon,
-  KernelClient,
-  SocketKernelTransport,
-} from '@velaros-ai/kernel-service'
+import {
+  type CapabilityCallRequest,
+  connectToKernelDaemon,
+  discoverKernelDaemon,
+  KernelClient,
+  KernelProtocolVersion,
+  SocketKernelTransport,
+} from '@velaros-ai/kernel-client'
```

package.json:

```diff
   "dependencies": {
-    "@velaros-ai/kernel-protocol": "^0.2.0",
-    "@velaros-ai/kernel-service": "^0.2.0"
+    "@velaros-ai/kernel-client": "^0.3.0"
   }
```

### 重命名

| 0.2.x | 0.3 | 说明 |
| --- | --- | --- |
| `KernelDaemonError` | `KernelClientError` | 旧名保留为别名导出,可暂不改 |

`KernelClientError` 的 `code` 取值不变:`DAEMON_NOT_RUNNING`、`DAEMON_DESCRIPTOR_INVALID`、`DAEMON_ALREADY_RUNNING`、`PROTOCOL_VERSION_MISMATCH`。

### 已不再对外提供

| 符号 | 处置 |
| --- | --- |
| `KernelModuleHost` | Kernel 内部。产品不应直接建 Host——那会绕过共享 Kernel,得到一份各自为政的状态。请改为连接 daemon。 |
| `KernelService` | 同上。 |
| `KernelLocalRpcServer` / `KernelLocalDaemon` | Kernel 内部。启动 Kernel 请用 launcher,不要在产品进程内起 RPC server。 |
| `InProcessKernelTransport` | 移入 Kernel 内部测试适配层。产品若需假传输,请自行实现 `KernelClientTransport`(它就是为此存在的扩展点)。 |

如果你的产品此前**在自己进程里 new 了一个 `KernelModuleHost` + `KernelService`**,这正是 0.3 要消除的模式:多个产品各起一个 Kernel,状态、Session、Run 互不可见。改法是连接共享 daemon:

```ts
import { connectToKernelDaemon } from '@velaros-ai/kernel-client'

const { client } = await connectToKernelDaemon()
```

## Mod 的改法

`@velaros-ai/kernel-sdk` 的公共组合 API 保持源码兼容,0.2.x 的 Mod 通常**无需改动**(仓库内有 `public-api-compat` 测试守着这条保证)。

唯一的硬性变化:如果 Mod 直接 import 过 `@velaros-ai/kernel-host` 或 `@velaros-ai/kernel-protocol`,必须移除。Mod 只能通过 SDK 契约与 Host 交互;这条边界现在由架构哨兵与 ESLint 强制。

## Agent 与 Core 已迁出本仓

`@velaros-ai/core`、`@velaros-ai/agent-protocol`、`@velaros-ai/agent-runtime` 不再由 Kernel 仓维护:

| 包 | 新仓库 |
| --- | --- |
| `@velaros-ai/core` | `VelarOS-Core` |
| `@velaros-ai/agent-protocol`、`@velaros-ai/agent-runtime` | `VelarOS-Agent` |

包名与公共 API 不变,消费方只需确保依赖解析到新仓发布的版本。`agent-runtime` 中的握手协商逻辑已并入 `@velaros-ai/kernel-client` 的 `negotiateKernelProtocol`,因为它本质是客户端与 Kernel 的协商契约。

## 校验清单

1. `rg '@velaros-ai/(kernel-protocol|kernel-host|kernel-service)'` 在你的仓库里应为零命中。
2. 依赖里只保留 `@velaros-ai/kernel-client`(产品)或 `@velaros-ai/kernel-sdk`(Mod)。
3. 产品代码中不应出现 `new KernelModuleHost` / `new KernelService`。
4. 跑一遍类型检查——符号名没变,报错基本只会是 import 来源问题。
