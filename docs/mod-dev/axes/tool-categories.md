# 轴：`toolCategories`

定义一个工具类别，供 [`tools`](./tools.md) 轴的 `categoryId` 引用。
**主键 = `id`；绑定可选。**

> **Desktop 接线状态：未接线**（`DesktopAgentModUnroutedAxes` 含 `toolCategories`）。
> 贡献不会报错，会在设置页显示为「未接线轴」，但不会进入 Desktop 的工具类别表。

## Schema

`AgentModToolCategoryContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,               // 主键
  label: z.string(),                 // 必填
  description: z.string().optional(),
  order: z.number().int().optional(),
})
```

## 运行态绑定（可选）

绑定值类型是 `ToolCategoryDefinition`（`@velaros-ai/agent/protocol`）：

```ts
interface ToolCategoryDefinition {
  id: ToolCategoryId
  label: string
  description: string
  toolOs: ToolCategoryOsDefinition
}
```

没绑定就只有声明记录，`payload` 为 `null`；`projectAgentModToolCategories` 会**跳过**
没有 payload 的记录（它只收 `record.payload` 非空的条目）。
也就是说：**想让类别真正进入宿主的类别表，就得给绑定。**

## 消费面

```ts
projectAgentModToolCategories(snapshot): Record<string, ToolCategoryDefinition>
```

## 与空间的关系（重要）

**类别与空间的绑定方向今天是反的**：不是 space 列出自己的类别，而是**类别声明自己属于哪个 scope**。
Desktop 的真实规则表是 `ToolSpaceCategoryRules`
（`apps/desktop/src/shared/capabilities/DesktopToolSpacePolicy.ts`），每条形如
`{ scope: 'shared' | 'system' | 'project' | 'browser' | 'virtual', tier: 'resident' | 'space-base' | 'space-extension' | 'on-demand', … }`。

`AgentModSpaceContribution.toolCategoryIds`（[spaces 轴](./spaces.md)）是**声明式方向的目标形态**，
今天在 Desktop 无消费者。两个方向最终会收敛成一个——收敛前，
往 `toolCategories` 轴贡献不影响任何空间可见性判定。
</content>
