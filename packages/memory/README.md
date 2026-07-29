# @velaros-ai/memory

中文接口文档：[`docs/api.zh-CN.md`](docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/memory` owns Evidence-grounded long-term memory, MemoryDream, the unified
meaning model, versioned tree projection, recall, erasure, and memory tools.

## Public Imports

- `@velaros-ai/memory`
- `@velaros-ai/memory/contracts` — browser-safe, type-only Memory DTOs
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
