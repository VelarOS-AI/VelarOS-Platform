# 轴：`executionModes`

贡献一个执行模式（目标模式 / 计划模式 / 方案模式那一类）。**主键 = `id`；绑定可选。**

> Platform 提供声明、注册和投影，内置执行模式也经过同一条 mod 装载链。
> 产品宿主必须在 `supportedAxes` 中声明支持并消费投影结果。

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
| `promptFeatureId` | 该模式**拆轴前**用来激活自己的 prompt feature id；**可为 `null`**（模式不挂特性）。2026-08-06 起模式的权威源是 `executionModes` 轴，这个 id 只用于把存量数据/旧宿主请求里的旧形态折算回模式轴（descriptor 侧字段名已改实为 `legacyPromptFeatureId`，manifest 字段名保持不变以免破线上 manifest） |
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
  legacyPromptFeatureId: descriptor.prompt.legacyPromptFeatureId,
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
