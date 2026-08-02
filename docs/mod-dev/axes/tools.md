# 轴：`tools`

给 agent 加一个工具。**主键 = `name`，全宿主唯一；运行态绑定必需。**

## Schema

`AgentModToolContributionSchema`（`packages/agent/src/protocol/mods.ts`）：

```ts
z.strictObject({
  name: CanonicalToolIdSchema,                        // namespace:tool，全宿主唯一
  categoryId: TrimmedIdSchema.optional(),
  summary: z.string().optional(),
  readOnly: z.boolean().optional(),
  /** 声明本工具在哪些 space 常驻（数据条目，由宿主常驻集算法消费）。 */
  residentInSpaces: tolerantArray(TrimmedIdSchema).optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `name` | 工具名。**这是模型看到的名字**，同时是注册表主键 |
| `categoryId` | 归入哪个工具类别；类别本身可由 [`toolCategories`](./tool-categories.md) 轴贡献 |
| `summary` | 简述（宿主诊断面 / 工具目录展示用） |
| `readOnly` | 只读工具标记 |
| `residentInSpaces` | 声明本工具在哪些 space 常驻。**纯数据条目**——由宿主的常驻集算法消费，主干不解释 space 语义 |

## 命名规则（裁决 5）

VelarOS 内部、Manifest、权限策略与持久历史只认 canonical id：
`namespace:tool`。命名空间允许小写字母、数字、点和短横线；具体工具名允许小写字母、
数字和下划线。Mod Loader 在注册任何绑定前完成校验，非法名字直接拒载。

因此：

- 外部 mod 使用自己的稳定命名空间，例如 `acme.notes:search`；
- 不允许裸名，也不允许把 provider 的下划线传输名写回 Manifest；
- provider 不支持冒号时，请求编译器临时映射为 `namespace__tool`。映射只存在于该次请求，
  返回的工具调用立即还原成 canonical id；
- 注册期做全局唯一性校验，冲突 → `mod.tool-name-conflict`，**拒载不覆盖**。

## 运行态绑定

`tools` 在 `PayloadRequiredAxes` 里——**每个声明条目都必须有对应绑定**，
键 = `name`，值 = `VelaTool<any>`：

```ts
import { defineVelaTool } from '@velaros-ai/agent'

const acmeNotesSearch = defineVelaTool({ /* … */ })

const bindings: AgentModBindings = {
  tools: { 'acme.notes:search': acmeNotesSearch },
}
```

缺绑定 → `mod.binding-missing`：

> `tools 条目「acme.notes:search」缺运行态绑定；该轴必须提供实现，拒载而不静默降级成空贡献。`

`VelaTool` 是 `ToolContractRuntimeSpec<TInput, TCtx, any, ToolPermission>` 的别名，
默认上下文是 host 无关的核心面 `KernelToolContext`
（`packages/agent/src/tool-library/defineVelaTool.ts`）。
工具参数用宽容原语拼——铁律见 [conventions.md](../conventions.md#二工具参数的宽容铁律)。

## 消费面

```ts
projectAgentModTools(snapshot): Record<string, VelaTool<any>>
```

投影**不复制不包装**——`tools[record.key] = record.payload`，
载荷对象同一性逐项保持。这是「官方内置经同一 Loader 装载后行为零变化」的结构性保证。

## 自食狗粮：内置工具库就是第一个 mod

`createBuiltinAgentModPackage()`（`BuiltinAgentMod.ts`）把 Agent Runtime 自带的九个工具集合
展平成 `tools` 贡献：

```
activeDirectiveTools · agentWorkflowTools · backgroundJobTools · categoriesTools ·
contextDistillTools · contextRetrievalTools · dispatchAgentTools · goalTools · plansTools
```

（常量 `BuiltinAgentModToolCollections`；展平函数 `collectBuiltinAgentModTools()`，
内置集合之间重名**在此即抛**，不留到 Loader 才发现。）

manifest 条目由工具实体**派生**（`toToolContribution` 读 `category` / `summary` / `readOnly`），
不另立一份清单——所以内置清单与实现**不可能漂移**。

## 预算

工具的**常驻 surface** 计入既有上下文治理预算，不是另一套静态配额。
mod 可以在 manifest 顶层声明 `budget.residentPromptTokens` 作为提示；
超预算时由既有治理降级为按需通道（`tooling:map` / skill），
**不新造一套静态配额双脑**（裁决 5）。
