# @velaros-ai/memory

中文接口文档：[`docs/api.zh-CN.md`](docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/memory` owns Evidence-grounded long-term memory, MemoryDream, the unified
meaning model, versioned tree projection, recall, erasure, and memory tools.

## Pluggable backends

Memory storage is **backend-pluggable** (kernel-contract §15.7 / mod-architecture-blueprint §九).
`./backend` holds the implementation-agnostic verb port (`MemoryStoreBackend`); `./files` ships the
bundled default authority tier (`memory-files`: markdown + frontmatter + a `MEMORY.md` index);
the existing SQLite memory tree is wrapped verbatim as the `tree` backend. The Kernel adapter
resolves one backend through the `velaros.memory.store.<backendId>` capability token family and
falls back to the tree backend when no backend mod is registered — behaviour is unchanged for hosts
that do not opt in.

Backends **stack** rather than compete (§九 9.2): the authority tier always holds the content, and
optional **derived indexes** sit on top of it. `./vector` ships the first one (`memory-vector`,
market-optional): capture double-writes, recall runs in parallel and re-fetches full text from the
authority through the pointer, and uninstalling drops only the index — authority content is never
touched. Embedding is an injected port (BYOK; the package assumes no model and pulls in no native
module). Composition lives in `createLayeredMemoryStoreBackend` (`./backend`).
Wiring map, host attachment points and batch progress:
[`docs/memory/memory-backends.md`](../../docs/memory/memory-backends.md).

## Public Imports

- `@velaros-ai/memory`
- `@velaros-ai/memory/contracts` — browser-safe, type-only Memory DTOs
- `@velaros-ai/memory/backend` — implementation-agnostic backend verb port + tree backend wrapper
- `@velaros-ai/memory/files` — the `memory-files` bundled default backend (Node host injects paths + IO)
- `@velaros-ai/memory/vector` — the `memory-vector` **market-optional** derived index (host injects the
  embedder + index store); **not part of the bundled set** — new users start files-only
- `@velaros-ai/memory/cli`

## Boundary

This package must not depend on `@velaros-ai/memory/knowledge`, `@velaros-ai/agent`,
Desktop IPC, renderer code, or app-specific prompt feature manifests. Hosts inject
the database and system APIs. Workspace knowledge and embeddings live in
`@velaros-ai/memory/knowledge`.

Memory scope ids and helpers are owned here (`MemoryScopeId`,
`buildProjectMemoryScope`, `buildSiteMemoryScope`). Product context selection
is intentionally not owned here; hosts map their context to one scope through
the Kernel adapter's `MemoryHostScopeResolver`.

Renderer、Web Worker、RPC schema 和前端测试应从
`@velaros-ai/memory/contracts` 导入 Memory DTO。该入口只包含类型，不加载
SQLite、Memory runtime 或工具实现；Node 宿主继续从包根入口导入完整能力。

The v2 authority implementation also owns legacy Evidence replay and parity verification. The
legacy database is opened read-only; authority cutover and legacy-table deletion are intentionally
not exposed as package operations. A host may consider cutover only after an exact parity report,
a matching true-device receipt, and an explicit user signoff bind to the same verification digest.

## Example

```ts
import { createMemoryRuntime, memoryTools } from '@velaros-ai/memory'
```
