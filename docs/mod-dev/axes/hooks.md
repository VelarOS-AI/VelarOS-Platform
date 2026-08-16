# 轴：`hooks`

把一个 handler 挂到某个**拦截 seam** 上。**主键 = `id`；运行态绑定必需。**

机制、性质与 15 个 kind 的完整说明在 [seams.md](../seams.md)；本页只讲 manifest 侧。

> **命名警告**：这里的 `hooks` = **mod 内代码拦截 agent 运行时行为**。
> 它与 **velar-hooks**（外部进程经 loopback HTTP 驱动整个应用）是两个毫不相干的系统，
> 只是共用了「hook」这个词。定位边界见 [integration.md](../integration.md#二velar-hooks宿主自动化-api)。

## Schema

`AgentModHookContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                    // 主键
  seam: AgentModSeamKindSchema,           // 必填，15 值闭集
  priority: z.number().int().optional(),  // 缺省 100
  reason: z.string().optional(),          // 审计用：为什么要挂这个钩子
})
```

`seam` 必须是 `AgentModSeamKinds` 里的值，写别的 → `mod.manifest-invalid`。
**mod 只能挂接，不能发明新钩子。**

## 运行态绑定（必需）

`hooks` 在 `PayloadRequiredAxes` 里，键 = 条目 `id`，值 = `AgentModSeamHandler`：

```ts
const bindings: AgentModBindings = {
  hooks: {
    'acme.notes.guard': (event) => {
      if (event.toolName === 'bash') return { block: { reason: '本 mod 不允许 shell' } }
    },
  },
}
```

缺绑定 → `mod.binding-missing`。

handler 类型按 seam kind 精确定型：

```ts
type AgentModSeamHandler<TKind extends AgentModSeamKind = AgentModSeamKind> = (
  event: AgentModSeamEventMap[TKind]
) => AgentModSeamOutcomeMap[TKind] | void | Promise<AgentModSeamOutcomeMap[TKind] | void>
```

## 优先级与排序

`priority` 缺省 **100**，升序执行；同值按 `id.localeCompare` 稳定排序
（`AgentModSeamDispatcher.register`）。同一 mod 在同一 seam 上注册重复 `id` → 直接抛错。

## 两阶段注册

seam 注册面与贡献注册表一样是两阶段的：
`beginRegistration()` → `register()` → `seal()`。
**封存后注册即抛**——不允许运行中改注册表。摘除也一样（`removeMod` 在 sealed 状态抛）。

## 权限不可旁路

钩子的结果面**只有「拦下」和「改写」，没有「放行」字段**。
被策略门拒绝的调用，任何钩子都无法把它变成允许；
`tool-call:before` 的入参改写发生在策略门**之前**，改写后照样走完整策略 / 校验 / 审批管线。

## 异常隔离

单个钩子抛错只记诊断 `mod.seam-handler-failed` 并跳过该钩子，**绝不冒泡打断主链**。
同步 seam 的钩子返回 Promise → `mod.seam-sync-contract-violation`，本次结果被忽略。
