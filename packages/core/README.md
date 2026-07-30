# @velaros-ai/core

## Responsibility

`@velaros-ai/core` **是 Kernel 库本体**(宪章 §15.2 第 ② 层 / §15.4「一个身份」),
同时是全平台的内核基础层。它由两部分构成:

- `src/kernel/**` —— 内核本体:module ABI、wire 协议、服务面契约、module host
  (capability registry / 权限 broker / 事件流 / namespaced state)与 KernelService 运行态。
  它是**库不是进程**:进程形态(daemon 生命周期、本机 RPC 前脸)住在
  `@velaros-ai/kernel-serve/daemon`,arch 门机械锁死 core 不得反向依赖它与 kernel-client。
- 其余目录 —— 任何域都需要的跨域基建:错误、结果、日志、断言、守卫与纯工具。

它不含产品 DTO、Electron IPC、具体能力实现或 UI。**领域语义禁止入核**:
`check:core-semantic-vocabulary` 词汇墙对 `src/kernel/**` 零豁免执法,
其余目录的余量登记在该门的「待逐出清单」里,只减不增。

## Public Imports

与 `package.json` 的 `exports` 表一一对应(改一处必改两处):

- `@velaros-ai/core`
- `@velaros-ai/core/cli`
- `@velaros-ai/core/types` / `@velaros-ai/core/types/*`
- `@velaros-ai/core/constants/*`
- `@velaros-ai/core/utils/*`
- `@velaros-ai/core/logger`
- `@velaros-ai/core/assert`
- `@velaros-ai/core/error`
- `@velaros-ai/core/result`
- `@velaros-ai/core/tool-contract`
- `@velaros-ai/core/kernel` —— 内核本体(宿主装配用:abi + contracts + host + runtime)
- `@velaros-ai/core/kernel/abi` —— **Mod 开发面**(module ABI / capability token / 权限 / 事件 / 状态 / 模块生命周期状态)
- `@velaros-ai/core/kernel/protocol` —— wire 协议契约(调用信封,唯一事实来源)
- `@velaros-ai/core/kernel/contracts` —— 服务面契约(健康度、identity 入参)
- `@velaros-ai/core/kernel/host` —— module host 实现(注册/激活/回滚/服务租约/事件流/命名空间状态)
- `@velaros-ai/core/kernel/runtime` —— KernelService 运行态(协议门面、identity 注册表、能力会话账本)

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

## 包内单源清单(改前先看，别再造第二份)

这些位置各自是某类逻辑的**唯一实现**，本包内曾出现同义多份并已收口；新代码一律调用，不要在本地重写：

| 单源 | 位置 | 曾散落的形态 |
| --- | --- | --- |
| 运行时类型判定 | `typeGuards.ts`（`TypeGuards` + 具名守卫 + 注册符号品牌） | 各处内联 `typeof` / `=== null` / `Array.isArray` |
| 数量钳制 | `utils/number.ts` 的 `clamp` / `clampRounded` | 六份 `Math.min(max, Math.max(min, Math.round(v)))` 变体 |
| 错误取消息 | `AppError.getMessage` | 本地 `instanceof Error ? .message : String(...)` |
| 工具描述语法 | `utils/ToolDescription.ts` 的 `isStructuredDescription` + 两张语法表 | 工具面/参数面各一份 28 行校验器 |
| 描述规格摘取 | `tool-contract/define.ts` 的 `pickToolDescriptionSpec` | 三处逐字段抄 8 个同名字段 |
| 模块生命周期状态 | `kernel/abi/module.ts` 的 `KernelModuleStatus` | host 与 contracts 各一份十值联合 |
| `optionalWhen` 守卫闭集 | 由 `VelarosRuntimeTypeGuardNames` 派生 | 额外的类型联合 + 运行时 Set 各抄一份 |

日志器不提供任何 `globalThis` 兜底：拿 scoped logger 一律 `logRuntime.tag(scope)`（或门面别名 `Log.tag`）。
旧的 `Loggable` 基类读 `globalThis.Log`、而本包早已不再写全局，等于永久静默 no-op，已删除。
