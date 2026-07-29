# @velaros-ai/core

## Responsibility

`@velaros-ai/core` **是 Kernel 库本体**(宪章 §15.2 第 ② 层 / §15.4「一个身份」),
同时是全平台的内核基础层。它由两部分构成:

- `src/kernel/**` —— 内核本体:module ABI、wire 协议、服务面契约、module host
  (capability registry / 权限 broker / 事件流 / namespaced state)与 KernelService 运行态。
  它是**库不是进程**:进程形态(daemon 生命周期、本机 RPC 前脸)住在
  `@velaros-ai/kernel-daemon`,arch 门机械锁死 core 不得反向依赖它与 kernel-client。
- 其余目录 —— 任何域都需要的跨域基建:错误、结果、日志、断言、守卫与纯工具。

它不含产品 DTO、Electron IPC、具体能力实现或 UI。**领域语义禁止入核**:
`check:core-semantic-vocabulary` 词汇墙对 `src/kernel/**` 零豁免执法,
其余目录的余量登记在该门的「待逐出清单」里,只减不增。

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
- `@velaros-ai/core/tool-contract`
- `@velaros-ai/core/kernel` —— 内核本体(宿主装配用:abi + contracts + host + runtime)
- `@velaros-ai/core/kernel/abi` —— **Mod 开发面**(module ABI / capability token / 权限 / 事件 / 状态)
- `@velaros-ai/core/kernel/protocol` —— wire 协议契约(调用信封,唯一事实来源)
- `@velaros-ai/core/kernel/contracts` —— 服务面契约(健康度、identity 入参)

## Boundary

This package must stay host-agnostic. It must not contain Desktop/Workbench IPC, product layout types, Electron APIs, renderer components, app assets, concrete tool registrations, capability result policy, model/embedding catalogs, package orchestration, or module-specific implementation state. `src/kernel/**` 另受更严的约束:只认识「模块/能力/权限/事件/状态/引用/错误」,出现任何具体域名词即红。 A contract shared only by one capability and its adapters belongs to that capability package; Agent Runtime consumes it through `AgentRuntimeCapabilityPorts`.

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
