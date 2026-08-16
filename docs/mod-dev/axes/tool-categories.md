# 轴：`toolCategories`

声明一个工具类别。**主键 = `id`；运行态绑定可选。**

## Schema

`AgentModToolCategoryContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,
  label: z.string(),
  description: z.string().optional(),
  order: z.number().int().optional(),
})
```

类别 id 在整个宿主内唯一。冲突以 `mod.contribution-conflict` 拒载，不允许后加载覆盖前加载。

## 运行态绑定

绑定类型是 `ToolCategoryDefinition`。提供 binding 时，
`projectAgentModToolCategories(snapshot)` 返回相同对象；只有声明而没有 binding 时，该条目保留在
注册和诊断面，但不会生成一个虚构的运行时类别。

```ts
projectAgentModToolCategories(snapshot): Record<string, ToolCategoryDefinition>
```

## 与产品空间的关系

类别描述“工具做什么”，产品空间策略描述“当前用户场景能看见和调用什么”，两者不能合并。
产品宿主负责把类别映射到自己的空间、权限和审批策略，并公开映射规则。mod 不能通过新增类别绕过
空间可见性或 capability broker。
