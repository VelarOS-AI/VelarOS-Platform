# `@velaros-ai/kernel/client`

独立 Kernel 进程的瘦客户端。只有 serve 部署模式需要它；Desktop、Workbench 等完整宿主
直接组合 `@velaros-ai/kernel/runtime`。

## 公开职责

- `KernelClient`：握手、健康度、能力会话、Mod 管理与事件订阅。
- `CapabilitySession`：绑定一组能力后调用；服务端按绑定范围执法。
- `SocketKernelTransport`：Unix domain socket / loopback TCP 传输。
- `discoverKernelDaemon`、`connectToKernelDaemon`：发现 descriptor 并完成握手。
- `KernelLauncher`：启动已解析的 Kernel 可执行文件；安装布局由调用方提供。
- `@velaros-ai/kernel/client/contracts`：endpoint、descriptor 与 RPC 帧。

Wire schema 的唯一事实来源是 `@velaros-ai/kernel/contracts/protocol`。Client 只负责传输，
不包含 module host、权限 broker、能力实现或 daemon 生命周期。

```ts
import { connectToKernelDaemon } from '@velaros-ai/kernel/client'

const { client } = await connectToKernelDaemon()
const session = await client.openCapabilitySession({
  requires: [{ capabilityId: 'velaros.project', operations: null, scope: null }],
})

const result = await session.call({
  protocolVersion: 2,
  callId: crypto.randomUUID(),
  capabilityId: 'velaros.project',
  operation: 'project:list',
  scope: null,
  input: {},
})

await session.dispose()
await client.dispose()
```
