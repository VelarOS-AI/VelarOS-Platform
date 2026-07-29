# @velaros-ai/system-tools

[中文接口文档](./docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/system-tools` owns the package-level system kernel contract and the default agent-facing system tools.

The default `systemTools` surface is intentionally small and primitive:

- `read` / `write` / `edit`
- `list` / `grep`
- `bash`
- `ps`
- `open`
- `get_system_overview`

High-level project discovery, runtime diagnosis, and split open/runtime tools live behind `systemExtensionTools` for hosts that explicitly want that larger surface. The old `atomic_*` aliases are retired; use the primitive names above.

## Public Imports

- `@velaros-ai/system-tools`
- `@velaros-ai/system-tools/cli`
- `@velaros-ai/system-tools/contracts` — browser-safe, type-only System contracts
- `@velaros-ai/system-tools/platform-compatibility` — browser-safe platform policy values

## Boundary

This package must not depend on `@velaros-ai/agent`, product IPC, Electron APIs, renderer UI, or Workspace registry operations. It defines tools over an injected system API; Workspace root registration, removal, activation, and switching belong exclusively to the Workspace capability and host composition.

The package also ships a local Node.js `SystemKernel` implementation for CLI and tests. Electron hosts can adapt their richer domain service to the same `SystemToolSystemApi` contract.

Renderer、Web Worker 和 RPC schema 应从 `@velaros-ai/system-tools/contracts`
导入纯类型，并从 `/platform-compatibility` 导入平台策略运行时值。只有 Node 宿主
需要从包根入口加载文件、进程和 shell 工具。

## Example

```ts
import { createLocalSystemKernel, systemTools } from '@velaros-ai/system-tools'
```
