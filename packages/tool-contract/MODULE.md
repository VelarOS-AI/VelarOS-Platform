# @velaros-ai/tool-contract 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/` 八个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

写一条工具要用到的全部契约：怎么声明它（身份、类别、角色、权限、能力声明、暴露策略、入参 schema、execute），
怎么把声明编译成模型最终看到的那段说明并拦住写爆的说明，怎么把 zod schema 出成 JSON Schema 或一整批工具的紧凑 schema 包，
怎么把一个空间的工具集合挂进 VelaOS 内核，以及失败回执长什么样。

system、project、browser、office、memory、computer、knowledge 七个空间都靠它写工具。
本包不认识回合循环、不认识上下文治理、不认识任何一个空间：谁来解析工具上下文、谁来审批、入参失败后怎么复用，
都在 `@velaros-ai/agent` 与各空间自己那边；这里只回答「一条工具对外长什么样、怎么被声明出来、怎么被挂上去」。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：八件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `toolContracts` | `ToolContractDefinitionApi` | 定义一条工具（`define` / `defineRuntime`）、编译它的模型面说明（`describe`）、鸭子判定与只读判定、造各空间那一行 `createDefiner` |
| `toolDescriptions` | `ToolDescriptionsApi` | 工具说明的渲染、判定、解析、精简、两道长度闸，以及各空间共用的约束句 |
| `renderParameterDescription` | 工厂 | 按四节语法渲染单个参数的说明；各空间的 schema 文件按参数逐个调它 |
| `toolExamples` | `ToolExampleRegistryApi` | 进程内共享的示例登记表：定义端写入，说明渲染端与离线审核端读出 |
| `toolSchemas` | `ToolSchemasApi` | zod schema → JSON Schema、发给 provider 前的稳定化、一整批工具的紧凑 schema 包 |
| `toolIdentity` | `ToolIdentityApi` | canonical 工具 id 的判定与断言、跨工具共享的审批操作身份 |
| `toolInputForgiveness` | `ToolInputForgivenessApi` | 宽容入参的原语：钳制、缺省、取首项、空输入 no-op、推断 action、调整回显 |
| `toolKernelModules` | `ToolKernelModulesApi` | 严格解析线上入参、把工具集合包成内核可调用操作、做成内核模块（`define`） |
| `toolFailures` | `ToolFailuresApi` | 统一的失败回执信封：`not-applied` / `skipped` / `failed` 三种结论与列表上限 |
| `createToolExampleRegistry` | 工厂 | 造一张与进程共享表隔离的示例登记表，给测试与离线审核用 |
| `renderToolExampleInputs` | 工厂 | 把一组示例渲染成「示例：」分节的条目 |
| `serializeToolExampleInput` | 工厂 | 把一条示例编成模型实际会收到的那串 JSON，编不出来当场抛 |
| `CanonicalToolIdPatternSource` | 契约常量 | canonical 工具 id 的正则源文本 |
| `ToolFailureLimits` | 契约常量 | 失败回执里每个列表最多列几项 |
| `ToolExecutionOutcomes` | 契约常量 | 失败回执的三种结论 |
| `GlobalToolConcepts` | 契约常量 | 各空间工具说明共用的约束句 |

**注入面**是 `contract/requires.ts` 的 `ToolContextResolver`：内核按名调工具之前，由挂载的那个空间给出本次调用的工具上下文；不给就一个操作都不登记。

**数据面**是 `types/tool-contract.ts`（可移植）与 `types/toolkit.ts`（带 zod 与 execute，只走根入口）：
`ToolContractRuntimeSpec`、`ToolContractSpec`、`ToolContractSurface`、`ToolContractExecute`、`DefineToolRuntimeSpecInput`、
`DefineToolContractInput`、`DefineToolContractSurfaceInput`、`ToolInputReuseContract`、`ToolDefiner`、`ToolDefinerOptions`、
`ToolCallableOperationsOptions`、`ToolCapabilityService`、`ToolKernelModuleOptions`、`ToolSchemaSource`，
以及可移植的 `ToolPermission`、`ToolCategoryId`、`ToolContractRole`、`ToolCapabilitySchema`、`ToolExposurePolicy` 等一族。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | 写工具的空间与 Agent 运行时 | 八件能力、三个模块级工厂、注入口，外加它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 定义一条工具 | `toolContracts.createDefiner({ categoryOf, inputReuse?, contractVersion?, wrapExecute? })` → `toolContracts.defineRuntime` → 断言 canonical id → 按工具自己的 schema 校验每条示例（先序列化成模型会发的那份 JSON）→ `describe` 编译说明 → 逐 surface 再走一遍 → 定 `readOnly`（effectKind 优先，其次显式 readOnly，最后 role）→ 声明了 `inputReuse` 就套信封并冻结 |
| 编译模型面说明 | `toolContracts.describe` → 登记示例 → companion skill 指路追加到「注意」末尾 → `toolDescriptions.forModel`（已结构化就原样返回，否则按七节语法渲染）→ `assertWithinLimit` 硬上限 → `assertWithinBudget` 软预算（合法豁免可跳过） |
| 出 schema | `toolSchemas.toInputSchema`（单条，`io:'input'` + 元组补长度界 + 剥元字段）；`toolSchemas.bundle`（整批：注册表出 schema → 共享定义归一成包内引用 → 内联单处引用的小定义 → 定义改短名 → 给引用点补回 description）；`toolSchemas.canonicalizeProviderInput`（发给 provider 前排键序、丢空 required） |
| 挂进内核 | `toolKernelModules.define({ id, version, permissions, token, tools, resolveContext, label, mapError })` → `toolKernelModules.callableOperations` 按工具名登记 → 每次调用：`parseWireInput` 严格解析 → 向宿主解析上下文并换上内核的 abortSignal → 核可用性与取消 → execute → 领域错误交给 `mapError` |
| 失败回执 | `toolFailures.create(code, message, cause, { notApplied?, applied? })` → 结论落进 `context.executionOutcome`（`not-applied` / `failed` / `skipped`）→ 已落地的部分经 `toolFailures.listed` 截到 `ToolFailureLimits.listItems` |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、数值钳制）、`@velaros-ai/kernel`（内核模块与能力服务的 ABI）。
- `zod`（入参 schema 与 JSON Schema 输出）。
- 不碰 Node 内置模块、不读环境变量、不起子进程、不落盘。两个入口都能在渲染进程里加载。

## 状态归谁

只有一处跨调用的状态：`toolExamples` 里那张「工具名 → 示例」的表，由工具定义期写入、说明渲染与离线审核期读出，随进程存在。
要一份不受进程共享表影响的，用 `createToolExampleRegistry()`。其余类都无状态，固定用的名单与阈值写成 `private static readonly`。

## 生命周期

没有需要释放的东西。八个实例随进程存在；`toolKernelModules.define` 造出的模块由内核管理，激活时注册服务、不持有可释放资源。

## 失败语义

- 定义期一律抛 `AppError('VALIDATION', …)`：工具名不是 canonical id、示例过不了自己的 schema、说明超硬上限或软预算、豁免理由不被认可或 note 空白、整类说明不是完全结构化。定义期不静默降级——坏工具必须进不了注册表。
- 内核调用期：入参不是对象或过不了严格解析抛 `VALIDATION`；集合里混进不是工具的值抛 `INVARIANT`；工具在解析出的上下文里不可用抛 `UNAVAILABLE`；工具自己抛的领域错误交给空间注入的 `mapError` 翻一次，没给就原样抛。
- 失败回执只出 `AppError`，码由各空间自己定；本包只定 `context.executionOutcome` 这一格的形状，外面按码与这一格判断，不按失败文字猜。

## 不变量

共 8 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 7 条、门禁 1 条。未验证 0 条。

## 非目标

- 不管回合循环、上下文治理、工具执行策略、入参失败后的复用账房：那些在 `@velaros-ai/agent`。
- 不管审批怎么征询：本包只出跨工具一致的操作身份，审批通道与交互端口在 agent 的注入面。
- 不认识任何一个空间：类别名单、权限名单、错误码表都由各空间自己出，本包不做登记处。
- 不管工具怎么被发现、怎么分页、怎么进提示词：那是 Agent 的工具空间与目录的事。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记七件能力的 API（定义在各自类上方，这里 re-export），requires.ts 是工具上下文解析器，constants.ts 是 id 写法、失败结论与上限、共用约束句
  types/        只放类型：tool-contract.ts 是可移植数据，toolkit.ts 是带 zod 与 execute 的那些形状
  impl/         一类一文件：ToolContractDefinition（定义工具）→ ToolKernelModules（挂进内核）→ ToolSchemas / ToolInputForgiveness / ToolFailures → ToolDescriptions → ToolExampleRegistry / ToolIdentity
  utils/        definition.ts（示例校验、描述规格摘取、只读判定）、description-syntax.ts（分节语法的渲染、判定、解析、压缩）、json-schema.ts（元字段、键序、共享定义的引用）、kernel.ts（工具规格判定）、tuning.ts（可调参数）
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**分层**（登记表 `layers`，上层可以引下层）：`ToolContractDefinition.ts` → `ToolKernelModules.ts` → `ToolSchemas.ts` / `ToolInputForgiveness.ts` / `ToolFailures.ts` → `ToolDescriptions.ts` → `ToolExampleRegistry.ts` / `ToolIdentity.ts`。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。
整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型；对外的工厂写成入口要的模块级函数。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ToolContractDefinition.ts` | `ToolContractDefinitionApi` | 定义工具与编译说明的唯一入口；`createDefiner` 造各空间那一行 |
| `ToolKernelModules.ts` | `ToolKernelModulesApi` | 严格解析入参、包成内核可调用操作；`define` 造内核模块 |
| `ToolSchemas.ts` | `ToolSchemasApi` | zod → JSON Schema、provider 面稳定化、紧凑 schema 包 |
| `ToolInputForgiveness.ts` | `ToolInputForgivenessApi` | 宽容入参的原语与调整回显 |
| `ToolFailures.ts` | `ToolFailuresApi` | 失败回执的统一信封 |
| `ToolDescriptions.ts` | `ToolDescriptionsApi` | 说明的渲染、判定、解析、精简与两道长度闸 |
| `ToolExampleRegistry.ts` | `ToolExampleRegistryApi` | 示例登记表；同文件的三个模块级函数是对外要的工厂 |
| `ToolIdentity.ts` | `ToolIdentityApi` | canonical 工具 id 与审批操作身份 |

**常量分四处。** 对外约定的（id 写法、失败结论与列表上限、共用约束句）在 `contract/constants.ts`；可调的（说明的两道闸、schema 包内联阈值、宽容修正补项上限）在 `utils/tuning.ts` 的 `ToolContractTuning`；
类里固定用的名单与分节标题写成 `private static readonly`；分节语法本身的名单跟着规则留在 `utils/description-syntax.ts`。
