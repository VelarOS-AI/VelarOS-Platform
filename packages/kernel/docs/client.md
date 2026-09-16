# `@velaros-ai/kernel/client`

独立 Kernel 进程的瘦客户端。只有 serve 部署模式需要它；Desktop、Workbench 等完整宿主
直接 `createKernel()`（根入口 `@velaros-ai/kernel`）。

## 公开职责

这条入口只出一件值 `kernelDaemons`（`KernelDaemonDirectoryApi`）：

- `kernelDaemons.defaultPaths(name?)`：算出守护进程在本机的落点。
- `kernelDaemons.discover(paths?)`：读出正在跑的守护进程发布的 descriptor。
- `kernelDaemons.connect(paths?)`：发现、连上、核对协议与内核版本，交出
  `KernelClientApi`（握手、健康度、能力会话、Mod 管理与事件订阅）、descriptor 与握手结果。
- `KernelClientApi.openCapabilitySession(...)`：绑一组能力后调用，服务端按绑定范围执法。

传输实现、会话实现与启动器都不出包：传输由 `kernelDaemons.connect` 建，启动器在
`@velaros-ai/kernel/serve` 的 `createKernelLauncher`，不过网络的进程内客户端由
`bootKernelDaemon(...)` 的 `booted.createClient()` 给。

Wire 数据的唯一事实来源是根入口（与 `@velaros-ai/kernel/contracts` 同源）。Client 只负责传输，
不包含 module host、权限 broker、能力实现或 daemon 生命周期。

```ts
import { kernelDaemons } from '@velaros-ai/kernel/client'

const { client } = await kernelDaemons.connect()
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
