# 轴：`promptSegments`

往系统提示词里加一段。**主键 = `id`；正文二选一：`text` 或运行态绑定。**

> **偏离登记**：蓝图 §3.2 写的是 `contributes.promptFeatures`。主干实际的领域轴是
> **prompt 段注册表**（`PromptRegistry`）——特性 id 是段的激活谓词输入，不是独立注册面。
> 故本仓落地名为 `promptSegments`（已在 [`docs/agent/agent-mod-trunk.md`](../../agent/agent-mod-trunk.md)
> 的「偏离与理由」登记）。

## Schema

`AgentModPromptSegmentContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                                  // 主键
  label: z.string().optional(),
  stability: z.enum(['stable', 'dynamic']),             // 必填
  priority: z.number().int(),                           // 必填，越小越靠前
  retention: z.enum(['normal', 'protected']).optional(),
  text: z.string().optional(),                          // 与运行态绑定二选一
})
```

| 字段 | 说明 |
| --- | --- |
| `stability` | `stable` = 稳定段，进前缀缓存区；`dynamic` = 每轮可变段。**放错档会破坏 provider 前缀缓存** |
| `priority` | 排序优先级，越小越靠前 |
| `retention` | `protected` 表示该段必须逐轮保留，由独立生命周期负责控制容量 |
| `text` | 静态正文。缺席时正文由运行态绑定提供 |

## 正文的两条路

**① 静态 `text`**——纯数据 mod 的路子：

```json
{ "id": "acme.notes.guidance", "stability": "stable", "priority": 500,
  "text": "查笔记时优先用 acme_notes_search，不要 grep 整个仓库。" }
```

**② 运行态绑定**——需要按上下文渲染时：

```ts
const bindings: AgentModBindings = {
  promptSegments: {
    'acme.notes.guidance': {
      id: 'acme.notes.guidance',
      stability: 'stable',
      source: 'mod:acme.notes',
      priority: 500,
      render: (context) => `当前笔记库：${context /* … */}`,
    } satisfies PromptSegmentDefinition,
  },
}
```

`PromptSegmentDefinition`（`packages/agent/src/prompts/registry.ts`）：

```ts
interface PromptSegmentDefinition {
  id: string
  label?: string
  stability: PromptSegmentStability
  source: PromptSegmentSource
  priority: number
  retention?: PromptSegmentRetention
  tags?: string[]
  when?: (context: PromptRenderContext) => boolean     // 激活谓词，false 时跳过该段
  render: (context: PromptRenderContext) => Nullable<string>   // 空值会被跳过
}
```

**两者都缺 → 拒载**（`mod.binding-missing`）：

> `promptSegments 条目「…」既没有 text 也没有运行态绑定，无正文可注入。`

## 消费面

```ts
projectAgentModPromptSegments(snapshot): PromptSegmentDefinition[]
```

有绑定的**原样返回**（同一性保持）；只有 `text` 的声明段在投影里被物化成定义，
`source` 统一打上 `` `mod:${record.modId}` ``——调试面板据此解释「这段从哪来」。

## 预算与注入面

mod 贡献的常驻段计入**既有上下文治理预算**（`ProviderRequestCompiler` 出口 + `residentTools` schema），
不是新造的一套配额。超预算由既有治理降级，不做静态双脑。

> **注入面提醒**：mod 贡献的文本（提示词段 / 工具描述 / skill 正文）是 prompt injection 面。
> 「标注来源信任级 + 非 bundled 文本不与系统指令同权」是**净新建能力，尚未落地**——
> 蓝图裁决 8 明确：该防护随外部代码 mod 一同兑现，v1 阶段因为只有 bundled mod 而非 load-bearing。
> 不要假设今天有这层隔离。
</content>
