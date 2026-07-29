# 轴：`executionModes`

贡献一个执行模式（目标模式 / 计划模式 / 方案模式那一类）。**主键 = `id`；绑定可选。**

> **Desktop 接线状态：未接线**（`DesktopAgentModUnroutedAxes` 含 `executionModes`）。
> 但注意：**官方执行模式本身已经走 mod 轴**——它们是随包 mod `velaros.agent.builtin` 的贡献，
> 由 Loader 装载（见下）。未接线指的是**外部 pack 贡献的**执行模式还没有落点。

## Schema

`AgentModExecutionModeContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                                       // 主键
  label: z.string(),                                         // 必填
  promptFeatureId: TrimmedIdSchema.nullable().optional(),
  sessionSticky: z.boolean().optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `promptFeatureId` | 该模式对应的 prompt feature id；**可为 `null`**（模式不挂特性） |
| `sessionSticky` | 模式是否会话粘性（切了以后跟着会话走，而不是一轮就掉） |

`sessionSticky` 是真实踩过的坑：模式的权威源必须**会话级稳定**，
靠一次性参数传递会在续流 / hook 触发时丢失。

## 运行态绑定（可选）

绑定值类型 `ExecutionModeDescriptor`
（`packages/agent/src/execution-modes/ExecutionModeDescriptor.ts`），比 manifest 声明宽：

```ts
interface ExecutionModeDescriptor {
  id: ExecutionModeId
  label: string
  prompt: ExecutionModePromptProjection
  toolProjection: ExecutionModeToolProjection
  stickiness: ExecutionModeStickiness
  completion: ExecutionModeCompletion
}
```

manifest 三字段是它的**投影**——`BuiltinAgentMod.ts` 的 `toExecutionModeContribution` 就是这么派生的：

```ts
{
  id: descriptor.id,
  label: descriptor.label,
  promptFeatureId: descriptor.prompt.promptFeatureId,
  sessionSticky: descriptor.stickiness.sessionSticky,
}
```

`projectAgentModExecutionModes(snapshot)` **只收有 payload 的记录**。

## 消费面

```ts
projectAgentModExecutionModes(snapshot): ExecutionModeDescriptor[]
```

## 官方模式就是 mod 贡献

`createBuiltinAgentModPackage()` 的 `executionModes` 轴由 `listExecutionModes()` 派生，
绑定直接引用原 descriptor 对象。这是「注册机不空转 / 官方功能自食狗粮」的验收面之一：
官方执行模式与外部 mod 走**同一条** validate → resolve → activate 管线，
且探针断言 id / 顺序 / 载荷对象 `toBe` 同一性——**不可能漂移**。
</content>
