# 轴：`turnContextSources`

声明一个每回合上下文源。**主键 = `id`；这是纯数据轴，不接受运行态绑定。**

## Schema

`AgentModTurnContextSourceContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,
  label: z.string(),
  defaultEnabled: z.boolean().optional(),
  budgetTokens: z.number().int().nonnegative().optional(),
  priority: z.number().int().optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `id` | 全宿主唯一的稳定标识符 |
| `label` | 供诊断和产品界面使用的名称 |
| `defaultEnabled` | 宿主首次发现该源时的建议缺省值，不覆盖用户已有选择 |
| `budgetTokens` | 该源的提示词预算上限 |
| `priority` | 多源 fan-in 时的稳定优先级 |

## 为什么不接受 binding

manifest 只声明上下文源的身份和预算，不能携带生产上下文的函数。若 bindings 中为该轴提供
payload，Loader 会以 `mod.binding-not-allowed` 拒载。

产品宿主负责把声明映射到自己公开的 `TurnContextDeltaSource` 实现，并明确来源权限、可访问数据、
失败策略和预算执行。缺少宿主实现时，该轴只能作为 absent axis 报告，不能生成空上下文冒充成功。

## 宿主实现要求

一个支持此轴的宿主至少应保证：

1. source id 到生产者的映射是显式注册，不依赖命名猜测；
2. 每个源独立执行权限和 token 预算；
3. 单源失败不会破坏其他源，并留下结构化诊断；
4. 同一回合使用固定配置与 generation 快照；
5. 用户关闭的源不会被 pack 更新静默重新启用。

Platform 的投影入口为：

```ts
projectAgentModTurnContextSources(snapshot): AgentModTurnContextSourceContribution[]
```
