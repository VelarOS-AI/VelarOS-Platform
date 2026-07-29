# @velaros-ai/kernel-client

Product-facing client for the shared VelarOS Kernel.

Kernel sits between product applications and Mods. This package is the **upward** face: the single main entry point a product uses to discover the local Kernel, connect to it, call capabilities, and subscribe to events. Mod authors want `@velaros-ai/kernel-sdk` instead.

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
- `/protocol` and `/contracts` subpath exports — the single source of truth for the wire protocol, shared byte-for-byte with the Kernel runtime.

## What is deliberately not here

No module host, no capability routing, no permission broker, no daemon lifecycle, no process management, and no host-specific (Electron, renderer, IPC) code. Those are Kernel-internal infrastructure. Installing and upgrading the shared runtime belongs to `@velaros-ai/kernel-updater`.

## Documentation

Full API reference: [docs/api.zh-CN.md](./docs/api.zh-CN.md).
