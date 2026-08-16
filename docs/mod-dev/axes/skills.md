# 轴：`skills`

贡献一个技能（Claude Code 式 `*.md` 技能的声明面）。**主键 = `id`；绑定可选。**

> Platform 提供声明、注册和投影。产品宿主必须在 `supportedAxes` 中显式启用该轴，
> 并把投影结果接入自己的技能目录；否则贡献会以 absent axis 报告。

## Schema

`AgentModSkillContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                                     // 主键
  name: z.string(),                                        // 必填
  description: z.string().optional(),
  skillKind: z.enum(['role', 'capability']).optional(),
  spaces: tolerantArray(TrimmedIdSchema).optional(),
  priority: z.number().int().optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `skillKind` | `role` = 全文常驻注入；`capability` = 指针 + 按需读取（渐进披露） |
| `spaces` | 技能在哪些 space 可见 / 可触发 |
| `priority` | 命中排序 |

`spaces` 接受标量（`tolerantArray` 会把 `"project"` 升成 `["project"]`）。

## 运行态绑定（可选）

绑定值类型是 `AgentSkillDefinition`（`packages/agent/src/skills/AgentSkillProvider.ts`），
它 `extends AgentSkillDescriptor` 并带 `markdown: string` 正文，以及
`baseDir?` / `resourcePaths?`（目录式技能的捆绑资源）/ `enabled` / `skillKind` /
`autoInjectPromptFeatures?` 等字段。

`projectAgentModSkills(snapshot)` **只收有 payload 的记录**——
没绑定的声明条目会被过滤掉。也就是说：只写 manifest 不给绑定，技能不会出现在技能列表里。

## 消费面

```ts
projectAgentModSkills(snapshot): AgentSkillDefinition[]
```

## 为什么内置轴里没有 skills

`createBuiltinAgentModPackage()` **刻意不声明 skills 轴**：
Agent Runtime 自身不带内置技能定义（技能由宿主的文件式供应方注入），
声明空轴只会制造零消费者的假贡献。
