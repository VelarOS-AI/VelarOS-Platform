# @velaros-ai/kernel-client

Product-facing client for the shared VelarOS Kernel.

Kernel sits between product applications and Mods. This package is the **upward** face: the single main entry point a product uses to discover the local Kernel, connect to it, call capabilities, and subscribe to events. Mod authors want `@velaros-ai/core/kernel/abi` instead.

```ts
import { connectToKernelDaemon } from '@velaros-ai/kernel-client'

const { client, handshake } = await connectToKernelDaemon()
const health = await client.health()
await client.dispose()
```

## What is here

- `KernelClient` — the product-facing facade over a transport.
- `KernelClientTransport` / `SocketKernelTransport` — the transport contract and its Unix-socket / loopback-TCP implementation.
- `discoverKernelDaemon` / `connectToKernelDaemon` — local Kernel discovery, descriptor validation, and verified handshake.
- `KernelClientError` / `KernelRpcClientError` — discovery and RPC error models.
- `/contracts` subpath export — serve 模式的连线契约(daemon descriptor / endpoint / RPC 帧),
  并转出内核基础层的服务面契约(健康度、identity 入参)。wire 协议本身住在
  `@velaros-ai/core/kernel/protocol`(P2 起唯一事实来源),客户端与内核逐字节共享同一份。

## What is deliberately not here

No module host, no capability routing, no permission broker, no daemon lifecycle, no process management, and no host-specific (Electron, renderer, IPC) code. 内核本体在 `@velaros-ai/core/kernel`,进程装配在 `@velaros-ai/kernel-serve/daemon`。 Installing and upgrading the shared runtime belongs to `@velaros-ai/kernel-serve/updater`.
