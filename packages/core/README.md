# @velaros-ai/core

**Kernel 库本体 + 全平台内核基础层**(core 域,住 `packages/core`)。
它在四环分层里是第 ② 层(宪章 §15.2 / §15.4「一个身份」),下面所有域都依赖它,
它**谁都不依赖**——仓内运行时依赖只有 `zod` 与 `gpt-tokenizer`。

包里其实是两样东西挤在一个发布单元里:

| 部分 | 是什么 |
| --- | --- |
| `src/kernel/**` | **内核本体**:module ABI、wire 协议、服务面契约、module host(capability registry / 权限 broker / 事件流 / namespaced state)、KernelService 运行态 |
| 其余目录 | 任何域都要用的**跨域基建**:错误、结果、日志、断言、类型守卫、工具契约、纯工具函数 |

## 第一条要记住的事:内核是库,不是进程

`src/kernel/**` 是**库**。进程形态(daemon 生命周期、本机 RPC 前脸、launcher)
住在 `@velaros-ai/kernel-serve/daemon`;瘦客户端住 `@velaros-ai/kernel-client`。
**内核对进程一无所知**,`check:kernel-arch` 机械锁死 core 不得反向依赖那两个包
(反过来它们依赖 core 是合法的)。

完整宿主在自己进程里装内核时,直接 new 本包的内核,**不经过 serve 也不经过 client**。

## 第二条:领域语义禁止入核

`check:core-semantic-vocabulary` 是一道词汇墙:内核只许认识
「模块 / 能力 / 权限 / 事件 / 状态 / 引用 / 错误」这几类词。
对 `src/kernel/**` **零豁免执法**——出现聊天、浏览器、工作区、记忆、办公、桌面控制
这类具体域名词即红。其余目录的存量登记在该门的「待逐出清单」里,**只减不增**
(最大一块是 `src/types/index.ts`,数据契约该去 `agent/protocol`,运行时行为该去 `agent`)。

## 分区(与 `package.json` 的 `exports` 一一对应,改一处必改两处)

### 内核面

| 入口 | 谁用它 |
| --- | --- |
| `@velaros-ai/core/kernel/abi` | **写 Mod 的人看这个**:module ABI / capability token / 权限 / 事件 / 状态 / 模块生命周期状态 |
| `@velaros-ai/core/kernel/protocol` | wire 协议契约(调用信封)。**唯一事实来源**,三侧共享:内核 runtime、serve 的 RPC 前脸、瘦客户端;形状漂移由 `check:kernel-schemas` 快照门拦 |
| `@velaros-ai/core/kernel/contracts` | 服务面契约(健康度、identity 入参) |
| `@velaros-ai/core/kernel/host` | module host 实现:注册 / 激活 / 回滚 / 服务租约 / 依赖解析 / 权限 broker / 事件总线 / 命名空间状态 / 隔离与 sidecar 桥 |
| `@velaros-ai/core/kernel/runtime` | KernelService 运行态:协议门面、identity 注册表、能力授权与会话账本、mod 目录 |
| `@velaros-ai/core/kernel` | 上面四个的桶(宿主装配内核用:abi + contracts + host + runtime) |

> `protocol` 与 `abi` **各有一份** `ScopeRef` / `ResourceRef` / `CapabilityToken`
> ——前者是 wire 形状,后者是进程内形状。所以 `kernel` 桶**不并入** protocol;
> 要 wire 契约就明确走 `/kernel/protocol`。这不是重复,是刻意的两套坐标系。

### 基建面

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/core` | 常用面的门面:断言、错误、结果、类型守卫、类型、`Log`,以及少数几个高频纯函数 |
| `@velaros-ai/core/assert` | 断言原语 |
| `@velaros-ai/core/error` | `AppError` 与错误分类 |
| `@velaros-ai/core/result` | Result 类型 |
| `@velaros-ai/core/logger` | `logRuntime` / `LoggerFactory` / transport(memory / callback) |
| `@velaros-ai/core/tool-contract` | 工具定义契约:`define` / 审批 / 交互 / 示例 / schema bundle |
| `@velaros-ai/core/cli` | CLI 基建:参数解析、结构化输出信封、tool-runner。各域的 CLI 命名空间共用它 |
| `@velaros-ai/core/types` / `/types/*` | 跨域共享类型(存量待逐出区,见上) |
| `@velaros-ai/core/constants/*` | 跨域共享常量 |
| `@velaros-ai/core/utils/*` | 逐文件按需导入的纯工具,不走桶 |

`utils/` 里几件被广泛依赖的东西值得单独点名:
**`ForgivingSchema`**(宽容参数原语套件——工具入参一律用它拼,钳制不拒绝、缺参给默认、
回显 `AppliedAdjustment`)、**`TimerScope`**(生命周期定时器原语:超时 / 间隔 / 动画帧 /
防抖 / sleep 全走 scope,调用方才能整组取消或 dispose)、**`TurnContextLedger`**
与 `TurnContextFormat`(回合上下文账本与格式)、**`ToolDescription`**(工具描述语法)、
`contextBudget` / `contextUsage` / `contextZones` / `tokenizer`(上下文预算与计量)。

## 用法

```ts
import { assertPresent } from '@velaros-ai/core/assert'
import { AppError } from '@velaros-ai/core/error'
import type { ToolDescriptor } from '@velaros-ai/core/types'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'
```

**所有运行时能力都通过 ESM 具名导出,不改宿主的 `globalThis`,也不动内建原型。**
两条随手会踩的约定:

- 缺席值到 JSON / IPC 边界要归一成 `null` 用 **`toNullable`**;
  普通可选字段用 **`toOptional`** 表达 `value ?? undefined`。
- 拿 scoped logger 一律 `logRuntime.tag(scope)`(或门面别名 `Log.tag`)。
  日志器**不提供任何 `globalThis` 兜底**——旧的 `Loggable` 基类读 `globalThis.Log`,
  而本包早就不再写全局,等于永久静默 no-op,已删除。
- 命名空间形式用 `import { TypeGuards } from '@velaros-ai/core'`;
  单个守卫直接 `import { isPresent } from '@velaros-ai/core'`。

## 边界:本包不放什么

必须保持 host-agnostic。**不得**出现 Desktop / Workbench IPC、产品布局类型、
Electron API、渲染层组件、应用资源、具体工具注册、能力结果策略、模型 / embedding 目录、
包编排,或任何模块专属的实现状态。

判断归属的那把尺子:**只被某个能力及其适配器共享的契约,属于那个能力包**,
不属于 core;Agent Runtime 通过 `AgentRuntimeCapabilityPorts` 消费它。

## 包内单源清单(改前先看,别再造第二份)

这些位置各自是某类逻辑的**唯一实现**,本包内曾出现同义多份并已收口;
新代码一律调用,不要在本地重写:

| 单源 | 位置 | 曾散落的形态 |
| --- | --- | --- |
| 运行时类型判定 | `typeGuards.ts`(`TypeGuards` + 具名守卫 + 注册符号品牌) | 各处内联 `typeof` / `=== null` / `Array.isArray` |
| 数量钳制 | `utils/number.ts` 的 `clamp` / `clampRounded` | 六份 `Math.min(max, Math.max(min, Math.round(v)))` 变体 |
| 错误取消息 | `AppError.getMessage` | 本地 `instanceof Error ? .message : String(...)` |
| 工具描述语法 | `utils/ToolDescription.ts` 的 `isStructuredDescription` + 两张语法表 | 工具面 / 参数面各一份 28 行校验器 |
| 描述规格摘取 | `tool-contract/define.ts` 的 `pickToolDescriptionSpec` | 三处逐字段抄 8 个同名字段 |
| 模块生命周期状态 | `kernel/abi/module.ts` 的 `KernelModuleStatus` | host 与 contracts 各一份十值联合 |
| `optionalWhen` 守卫闭集 | 由 `VelarosRuntimeTypeGuardNames` 派生 | 额外的类型联合 + 运行时 Set 各抄一份 |

## 相邻包

| 包 | 关系 |
| --- | --- |
| `@velaros-ai/kernel-client` / `@velaros-ai/kernel-serve` | serve 部署模式的两侧,**它们依赖 core,core 不依赖它们**(`check:kernel-arch`) |
| `@velaros-ai/agent` | 最大消费方;core 待逐出的产品语义正是往它那里搬 |
| 各能力包(browser / workspace / office / …) | 用 `tool-contract` 定义工具、用 `kernel/abi` 做成 kernel module |

## 门

`check:kernel-schemas`(wire 形状快照)、`check:kernel-arch`(依赖方向)、
`check:core-semantic-vocabulary`(词汇墙 + 待逐出清单棘轮)。
构建期还会跑 `generate:schema-snapshot` 刷新协议快照。
