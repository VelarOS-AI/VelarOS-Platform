# @velaros-ai/kernel-client API

## 定位与非目标

`@velaros-ai/kernel-client` 是**产品开发者接入共享 Kernel 的唯一主要入口**。VelarOS-Desktop、Workbench、浏览器桥接、CLI 等上层产品通过它发现本机 Kernel、建立连接、调用能力、订阅事件。

Kernel 在架构上位于上层产品与底层 Mod 之间:对上给产品稳定的 Client API(本包),对下给 Mod 稳定的 Module SDK(`@velaros-ai/kernel-sdk`)。

本包**是**:

- 本机 Kernel daemon 的发现与连接(读 endpoint descriptor、校验、握手)。
- wire 协议契约的唯一实现处(zod schema),Client 与 Kernel 内部共享同一份定义。
- 一层薄客户端:请求编解码、requestId 关联、取消、事件分发、返回值运行时校验。

本包**不是**:

- 不是 Kernel Runtime。这里没有模块加载、能力路由、权限治理、生命周期、状态存储。
- 不是 Mod 开发接口。声明 Module 与 Capability 请用 `@velaros-ai/kernel-sdk`。
- 不负责安装、升级、版本切换与回滚,那是 `@velaros-ai/kernel-updater` 的职责。
- 不含任何 host 相关代码(Electron、renderer/main、IPC 别名一律禁止)。

依赖方向上,本包**只允许**依赖协议契约与 `@velaros-ai/kernel-sdk` 的公共类型;反向依赖 Kernel Host / Runtime / RPC / Daemon 由架构哨兵与 ESLint 双重拦截。

## 安装

```bash
npm install @velaros-ai/kernel-client
```

需要 Node.js >= 20。包为纯 ESM(`"type": "module"`)。

## 公共入口

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/kernel-client` | 全部公共 API(下述三者的并集) |
| `@velaros-ai/kernel-client/contracts` | Client 与 Kernel 服务端共享的契约:descriptor、endpoint、RPC 帧、健康度、identity 入参 |
| `@velaros-ai/kernel-client/protocol` | wire 协议 zod schema 与类型:capability、handshake、identity、negotiation、schema snapshot |

`/contracts` 与 `/protocol` 子入口存在的原因是:Kernel 内部实现必须与 Client 共享同一份 wire 定义,而协议实现落在已发布的这一侧,内部通过子入口消费,从而保证「一份 schema,两侧消费」。产品代码通常只需根入口。

## 核心类与接口

### `KernelClient`

产品面向的门面,只依赖 `KernelClientTransport`,不感知传输实现。

产品面刻意收窄为四类语义:

| 方法 | 说明 |
| --- | --- |
| `handshake()` | 返回对端协议版本、Kernel 版本与模块清单 |
| `health()` | 返回 Kernel 与各模块的健康状态 |
| `openCapabilitySession({ requires })` | 能力 Bind;返回 `CapabilitySession`(唯一调用入口:`call` / `dispose`) |
| `listMods` / `setModEnabled` / `installModFromDirectory` | ModStore 管理 |
| `subscribe(eventType, handler)` | 订阅事件,返回可 `dispose()` 的订阅句柄 |
| `dispose()` | 关闭底层传输 |

**不在** `KernelClient` 上:

- 裸 `capability.call`(必须经 `CapabilitySession`)
- Identity session/run 账本(`session.*` / `run.*` wire 仍存在,属 Kernel 内部名册,不是产品 Bind)

### `CapabilitySession`

一次 Bind 得到的能力会话。`call(request, signal?)` 会注入 `sessionId` 并在中止时走 `capability.cancel`;`dispose()` 关闭服务端绑定。

### `KernelClientTransport`

完整 **wire 实现面**(Unix socket、进程内适配、将来的鉴权远程)。自定义传输需实现全部方法;产品应只用 `KernelClient`,不要直接摸 capability/identity wire。

Identity 相关方法(`openSession` / `startRun` 等)仅服务 RPC `session.*` / `run.*`,与 `CapabilitySession` 无关。

### `SocketKernelTransport`

基于 `node:net` 的换行分隔 JSON 传输,是当前唯一的生产实现。它负责:

- 以 `requestId` 关联并发请求的响应(乱序返回也能正确归位)。
- `AbortSignal` 中止时发出 `capability.cancel`,并以 `AbortError` 拒绝原调用。
- socket 断开时拒绝**全部** pending 请求(`TRANSPORT_DISCONNECTED`,`retryable: true`)。
- 以 zod schema 校验每个 RPC 返回值,形状不符即拒绝,不把脏数据交给产品。

构造参数:`{ authToken, endpoint, maxFrameBytes? }`。

### `discoverKernelDaemon(paths?)`

读取本机运行中 Kernel 发布的 endpoint descriptor 并做结构校验。Kernel 未运行时抛 `DAEMON_NOT_RUNNING`。

### `connectToKernelDaemon(paths?)`

发现 + 连接 + 验证的组合操作,返回 `{ client, descriptor, handshake }`。它在信任 socket 之前先校验 descriptor 的协议版本,再要求实时握手与 descriptor 一致——这样上一次 Kernel 构建残留的过期 descriptor 不会把调用悄悄路由到错误的 runtime。

### 契约类型

`KernelRpcEndpoint`(`unix` | `tcp`)、`KernelDaemonEndpointDescriptor`、`KernelDaemonPaths`、`KernelServiceHealth`、`KernelRpcRequest` / `KernelRpcResponse` / `KernelRpcEventFrame`、`OpenKernelSessionInput`、`StartKernelRunInput`。

`createDefaultKernelDaemonPaths(name?, runtimeDirectory?)` 给出默认的 descriptor / lock / socket 路径,可用 `VELAROS_KERNEL_RUNTIME_DIR` 覆盖运行时目录。

## 生命周期/并发

- **连接**:`SocketKernelTransport` 惰性建连,首个请求触发连接;连接失败以 `TRANSPORT_CONNECT_FAILED`(`retryable: true`)拒绝。
- **并发**:多个请求可同时在途,响应按 `requestId` 匹配,不依赖到达顺序。
- **取消**:`call(request, signal)` 在 signal 已中止时**不发送**请求;在途中止则发出 `capability.cancel` 并以 `AbortError` 拒绝。
- **断开**:socket 关闭时全部 pending 请求被拒绝,事件订阅同时失效。
- **关闭**:`dispose()` 之后的请求以 `TRANSPORT_CLOSED`(`retryable: true`)拒绝,重复 `dispose()` 安全。
- **事件**:事件按 `subscriptionId` 分发;`subscription.dispose()` 后不再回调。

## 依赖注入

本包不做服务定位,一切依赖显式传入:

- `KernelClient` 构造时注入 `KernelClientTransport`,便于用假传输测试产品逻辑而无需真 Kernel。
- `SocketKernelTransport` 构造时注入 `authToken` 与 `endpoint`,通常来自 `discoverKernelDaemon()` 的 descriptor。
- `discoverKernelDaemon` / `connectToKernelDaemon` 接受 `KernelDaemonPaths`,便于在测试中指向临时目录。

## 错误模型

| 类型 | 场景 | 字段 |
| --- | --- | --- |
| `KernelClientError` | 发现与连接阶段的失败 | `code`、`message`、`guidance?` |
| `KernelRpcClientError` | 传输层与 Kernel 上报的失败 | `rpcError`(`code` / `message` / `retryable` / `details`)、`code`、`retryable` |

`KernelClientErrorCode`:`DAEMON_NOT_RUNNING`、`DAEMON_DESCRIPTOR_INVALID`、`DAEMON_ALREADY_RUNNING`、`PROTOCOL_VERSION_MISMATCH`。

协议不兼容时 `guidance` 携带来自 `negotiateKernelProtocol` 的升级指引,产品可直接展示给用户。

传输层 `rpcError.code`:`TRANSPORT_CONNECT_FAILED`、`TRANSPORT_DISCONNECTED`、`TRANSPORT_CLOSED`、`TRANSPORT_FRAME_TOO_LARGE`,均为 `retryable: true`;Kernel 业务错误的 `code` 由 Kernel 决定,原样透出。

> 兼容别名:`KernelDaemonError` 是 `KernelClientError` 的旧名导出,0.2.x 调用点无需改动。

## 最小第三方示例

```ts
import {
  connectToKernelDaemon,
  KernelClientError,
  KernelProtocolVersion,
} from '@velaros-ai/kernel-client'

const { client, handshake } = await connectToKernelDaemon()

try {
  console.info(`Kernel ${handshake.kernelVersion} (protocol v${handshake.protocolVersion})`)

  const subscription = await client.subscribe('workspace.changed', (event) => {
    console.info('event', event.type, event.payload)
  })

  const session = await client.openCapabilitySession({
    requires: [
      {
        capabilityId: 'workspace.files',
        operations: ['read'],
        scope: null,
      },
    ],
  })

  const controller = new AbortController()
  const response = await session.call(
    {
      protocolVersion: KernelProtocolVersion,
      callId: crypto.randomUUID(),
      capabilityId: 'workspace.files',
      operation: 'read',
      scope: null,
      input: { path: 'README.md' },
    },
    controller.signal,
  )

  if (response.status === 'ok') console.info(response.output)

  await session.dispose()
  await subscription.dispose()
} catch (error) {
  if (error instanceof KernelClientError && error.code === 'DAEMON_NOT_RUNNING') {
    console.error('共享 Kernel 未运行,请先启动。')
  } else {
    throw error
  }
} finally {
  await client.dispose()
}
```

## 扩展点

- **自定义传输**:实现 `KernelClientTransport` 即可把 `KernelClient` 接到别的通道(测试假件、鉴权远程传输、进程内适配)。传输契约是稳定扩展点。
- **自定义 daemon 路径**:向 `discoverKernelDaemon` / `connectToKernelDaemon` 传入自定义 `KernelDaemonPaths`,或设置 `VELAROS_KERNEL_RUNTIME_DIR`,用于多实例与测试隔离。
- **协议协商**:`negotiateKernelProtocol` 可单独调用,在正式连接前判断对端版本是否可用。
- **帧大小上限**:`SocketKernelTransport` 的 `maxFrameBytes` 可按产品需要调整。

## 兼容策略

- **协议版本**:`KernelProtocolVersion` 是当前 wire 版本。握手先解析对端版本,再由逻辑层判断兼容性;协商通过后的业务帧严格匹配当前版本。
- **schema 快照**:构建产出 `dist/schema-snapshot.json`,CI 与 `baselines/kernel-wire-schema-snapshot.json` 逐 schema 比对,拦截无意的 wire 形状漂移。有意变更需重生成基线并在提交中说明。
- **语义化版本**:公共导出遵循 semver。协议版本递增属于 breaking change。
- **0.3.0 迁移**:本包是新的产品接入入口,取代了原 `@velaros-ai/kernel-service` 的客户端部分与 `@velaros-ai/kernel-protocol`。原 `KernelDaemonError` 保留为别名。详见仓库根 `docs/migration-0.3.md`。
