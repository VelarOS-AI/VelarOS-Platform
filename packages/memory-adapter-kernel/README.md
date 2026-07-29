# @velaros-ai/memory-adapter-kernel

中文接口文档：[`docs/api.zh-CN.md`](docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/memory-adapter-kernel` is the **only** legal bidirectional glue point between the kernel
(`@velaros-ai/agent-runtime`) and the memory product (`@velaros-ai/memory`). It owns the three host
strategy services that turn kernel/session activity into memory-product calls and vice versa:

- **`MemoryEvidenceBridge`** — session/execution/workspace events → `capture` (the capture port).
- **`MemoryTurnRecallCoordinator`** — turn-start async recall → a `turn-context` delta source
  (`memory.recall`, the 8th turn-context source; renderer-invisible).
- **`MemoryDreamScheduler`** / **`MemoryService`** — background Dream scheduling + the thin
  governance facade (diagnostics / run-now / warmup / close).

## The three-port seam (why this package exists)

Per [`docs/kernel-contract.md`](../../docs/kernel-contract.md) §7, the kernel's *entire* interface to
memory is three ports, and the kernel holds **zero** `import` of `@velaros-ai/memory`:

1. **turn-context source registration** — `mount().turnRecall.createTurnContextSource()` registers
   `memory.recall` as one turn-context source; the kernel never queries memory directly.
2. **tool registration** — memory/knowledge tools ship from `@velaros-ai/memory` and are registered
   through the shared ToolContext DI (already consumed by the web bridge's external brain).
3. **session-event subscription** — the capture port: significant session events flow through
   `MemoryEvidenceBridge` into the evidence layer.

Any temptation to add a "fourth port" (e.g. the governance pipeline querying memory directly) must be
refused: every memory contribution to context goes through the turn-context source, or the two
domains grow back together.

## `mount(...)` — single assembly entry

The host wires memory in one call. `mountMemoryAdapter(input)` receives the memory domain plus three
narrow host ports and returns the three-port host attachment points:

```ts
import { mountMemoryAdapter } from '@velaros-ai/memory-adapter-kernel'

const memory = mountMemoryAdapter({
  domain: memoryRuntime.memoryDomainService,
  idleSignal: createDesktopMemoryHostIdleSignal(), // Electron impl stays in apps/desktop glue
  config: { isEnabled, isBackgroundGrowthEnabled, allowBatteryGrowth, isAutomaticDeepRecallEnabled, /* capture flags */ },
  hostContext: {
    turnContextScopes: ['system', 'project', 'browser'],
    resolveScope: ({ sessionId, workspaceRoot, contextId }) =>
      hostMemoryScopePolicy.resolve({ sessionId, workspaceRoot, contextId }),
    environmentContextBlockOpenTag: '<environment-context>',
  },
})

turnContextFanIn.register(memory.turnRecall.createTurnContextSource())
// memory.evidenceBridge → chat capture; memory.service → IPC/warmup/close
```

## Host signal port

`MemoryDreamScheduler` needs three host runtime readings (system idle seconds, on-battery, foreground
focus). On Desktop these come from Electron (`powerMonitor` / `BrowserWindow`), but the adapter itself
is **host-agnostic**: the readings are injected as a narrow `HostIdleSignalPort`. The Electron
implementation lives in `apps/desktop` glue; headless hosts inject a constant implementation.

## Boundary

- This package **may** import `@velaros-ai/core` and `@velaros-ai/memory` (it is the glue).
- Core imports are restricted to generic value/error/turn-context contracts. Chat, Workspace,
  Browser, Memory scope and session storage DTOs are normalized into this package's own host
  contracts before they cross the boundary.
- It **must not** import `electron` / `@electron/*`, Desktop IPC (`@velaros-ai/ipc`), or any
  `apps/desktop` renderer/main path. The `HostIdleSignalPort` implementation is injected by the host.
- `@velaros-ai/agent-runtime` (the kernel) **must not** import this package or `@velaros-ai/memory`.

These rules are enforced by the `velaros/memory-product-boundary` arch-guard ratchet (baseline: zero
violations).

## Public Imports

- `@velaros-ai/memory-adapter-kernel`
