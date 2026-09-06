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
  permissions: tolerantArray(TrimmedIdSchema).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  handler: AgentModCommandHandlerSchema.optional(),
  /** 只绑定可用类别，不强制常驻 schema。 */
  availableInSpaces: tolerantArray(TrimmedIdSchema).optional(),
  /** 声明本工具在哪些 space 常驻（数据条目，由宿主常驻集算法消费）。 */
  residentInSpaces: tolerantArray(TrimmedIdSchema).optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `name` | 工具名。**这是模型看到的名字**，同时是注册表主键 |
| `categoryId` | 归入哪个工具类别；类别本身可由 [`toolCategories`](./tool-categories.md) 轴贡献 |
| `summary` | 简述（宿主诊断面 / 工具目录展示用） |
| `readOnly` | 只读工具标记；内置工具优先由 `capabilities.effectKind` 派生，旧工具回退 `role=inspect` |
| `permissions` | 工具行为权限上界；运行态 `VelaTool.permissions` 必须保留 |
| `inputSchema` | 外部 command 工具的标准 JSON Schema；根类型必须是 `object` |
| `handler` | 外部受控载体：`{ type: 'command', entry, permissions? }`；编译期绑定省略 |
| `availableInSpaces` | 声明本工具在哪些 space 可用；只绑定类别，可按预算换入，不强制每轮发送 schema |
| `residentInSpaces` | 声明本工具在哪些 space 常驻。**纯数据条目**——由宿主的常驻集算法消费，主干不解释 space 语义 |

## 命名规则

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

### 外部 command binding

外部 `.velarmod` 不向宿主暴露可 import 的 main 模块。宿主 reader 识别同一 contribution 上的
`inputSchema + handler`，先把 JSON Schema 编译成运行态 schema，再物化同名 `VelaTool` binding；
从进入 `AgentModLoader` 开始，它与编译期 binding 完全共用注册、投影与执行主链。

```json
{
  "name": "acme.notes:search",
  "categoryId": "knowledge",
  "permissions": ["fs:read"],
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"],
    "additionalProperties": false
  },
  "handler": {
    "type": "command",
    "entry": "tools/search.mjs",
    "permissions": ["network"]
  }
}
```

协议只定义可移植声明；包内路径、进程沙箱、权限 broker、JSON stdin/stdout、输出上限与中止语义
由具体宿主实现。`module.isolation` 是 Kernel module 装载元数据，不表示 command handler 载体，
宿主不得要求它等于 `sidecar`。运行态工具权限必须取
`tools[].permissions ∪ handler.permissions` 的明确并集，不能在适配时丢失。

若外部工具引用同一包通过 `toolCategories` 声明的类别，宿主适配器必须同时提供对应
`ToolCategoryDefinition` binding，再把类别与工具交给同一个 Loader；只保留 declaration 会因没有运行态
payload 而在投影时被丢弃。类别的宿主域与初始装载状态由具体宿主确定，不能由外部包越权指定。

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

manifest 条目由工具实体**派生**（`toToolContribution` 读 `category` / `summary`，并按
`capabilities.effectKind` → `role` 的顺序派生 `readOnly`），
不另立一份清单——所以内置清单与实现**不可能漂移**。

## 预算

工具的**常驻 surface** 计入既有上下文治理预算，不是另一套静态配额。
mod 可以在 manifest 顶层声明 `budget.residentPromptTokens` 作为提示；
超预算时由既有治理降级为按需通道（`tooling:map` / skill），
**不要新造一套静态配额双脑。**
