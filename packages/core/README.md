# @velaros-ai/core

中文接口文档：[docs/api.zh-CN.md](docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/core` is the host-neutral foundation contract package. It owns broadly reusable types, stable primitives, errors, result helpers, logging contracts, and pure utilities that are safe for every VelarOS package to import.

## Public Imports

- `@velaros-ai/core`
- `@velaros-ai/core/cli`
- `@velaros-ai/core/types`
- `@velaros-ai/core/constants/*`
- `@velaros-ai/core/utils/*`
- `@velaros-ai/core/logger`
- `@velaros-ai/core/assert`
- `@velaros-ai/core/error`
- `@velaros-ai/core/result`
- `@velaros-ai/core/chat-stream`
- `@velaros-ai/core/tool-contract`

## Boundary

This package must stay host-agnostic. It must not contain Desktop/Workbench IPC, product layout types, Electron APIs, renderer components, app assets, concrete tool registrations, capability result policy, model/embedding catalogs, package orchestration, or module-specific implementation state. A contract shared only by one capability and its adapters belongs to that capability package; Agent Runtime consumes it through `AgentRuntimeCapabilityPorts`.

## Example

```ts
import { assertPresent } from '@velaros-ai/core/assert'
import { AppError } from '@velaros-ai/core/error'
import type { ToolDescriptor } from '@velaros-ai/core/types'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
```

`TimerScope` is the shared lifecycle timer primitive. Runtime code should schedule timeouts,
intervals, animation frames, debounce callbacks, sleeps, and async timeouts through a scope so
callers can cancel or dispose related work together.

所有运行时能力都通过 ESM 具名导出，不修改宿主的 `globalThis` 或内建原型。缺席值归一到 JSON/IPC 边界的 `null` 用 **`toNullable`**，普通可选字段用 **`toOptional`** 表达 `value ?? undefined`。命名空间形式请 `import { TypeGuards } from '@velaros-ai/core'`；单个守卫可直接 `import { isPresent } from '@velaros-ai/core'`。
