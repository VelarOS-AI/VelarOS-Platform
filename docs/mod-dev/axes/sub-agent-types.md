# 轴：`subAgentTypes`

贡献一个子 agent 类型（`agent:dispatch` 可派发的角色）。**主键 = `id`；绑定可选。**

> Platform 提供声明、注册和投影。产品宿主必须在 `supportedAxes` 中显式启用该轴，
> 并将投影结果并入自己的子 Agent 类型目录。

## Schema

`AgentModSubAgentTypeContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                                        // 主键
  label: z.string().optional(),
  description: z.string().optional(),
  toolCategoryIds: tolerantArray(TrimmedIdSchema).optional(),
  toolNames: tolerantArray(TrimmedIdSchema).optional(),
  readonlyDefault: z.boolean().optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `toolCategoryIds` | 该子 agent 可用的工具类别 |
| `toolNames` | 额外点名的工具 |
| `readonlyDefault` | 默认只读（不给写工具） |

## 运行态绑定（可选）

绑定值类型 `SubAgentTypeDescriptor`
（`packages/agent/src/sub-agent/SubAgentTypeRegistry.ts`）——比 manifest 声明宽得多：

```ts
interface SubAgentTypeDescriptor {
  id: SubAgentTypeId
  workerType: TeamWorkerType
  roleId: AgentRoleId
  routeCategory: TeamModelRouteCategory
  workerPhase: TeamExecutionPhase
  toolCategories: readonly ToolCategoryId[]
  toolNames: readonly string[]
  resourceLeaseScope: Nullable<string>
  readonlyDefault: boolean
  promptAppend: Nullable<string>
}
```

`projectAgentModSubAgentTypes(snapshot)` **只收有 payload 的记录**——
manifest 声明是给注册表 / 诊断面看的索引项，真正可派发的类型必须有绑定。

> Agent Runtime **没有内置 worker 分类法**（源码注释：*"Agent Runtime has no built-in worker
> taxonomy. Hosts inject a complete catalog."*）。子 agent 目录整份由宿主注入，
> `SubAgentTypeProvider` 带 `defaultTypeId` / `listDescriptors()` / `getDescriptor(id)`。

## 消费面

```ts
projectAgentModSubAgentTypes(snapshot): SubAgentTypeDescriptor[]
```

## 防滥用提醒

派子 agent 有既定纪律：并发上限、嵌套硬禁、避免「什么事都派子 agent」。
贡献新类型时把 `description` 写清**什么时候该用它**——那段文字会进模型面，
它是抑制滥用的第一道也是最便宜的一道。
