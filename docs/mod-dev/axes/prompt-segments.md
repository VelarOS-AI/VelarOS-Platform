# 轴：`promptSegments`

往系统提示词里加一段。**主键 = `id`；正文二选一：`text` 或运行态绑定。**

> 权威轴名是 `promptSegments`。它对应 `PromptRegistry` 中的 prompt 段；特性 id 只是段的
> 激活条件输入，不是独立注册面。manifest 中使用其他轴名会被严格 schema 拒载。

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
| `stability` | **声明意图，不决定落点**（2026-08-06 行为知识三层）。mod 段一律落 Tier1（活动尾）；写 `stable` 也进不了稳定前缀 |
| `priority` | 排序优先级，越小越靠前 |
| `retention` | 与 `stability` 同款：**声明意图，不决定落点**。声明段一律投影成 `normal`；`protected`（预算裁剪免死）由宿主按上下文治理发放，不接受第三方自报 |
| `text` | 静态正文。缺席时正文由运行态绑定提供 |

## 正文的两条路

**① 静态 `text`**——纯数据 mod 的路子：

```json
{ "id": "acme.notes.guidance", "stability": "dynamic", "priority": 500,
  "text": "查笔记时优先用 acme_notes_search，不要 grep 整个仓库。" }
```

**② 运行态绑定**——需要按上下文渲染时：

```ts
const bindings: AgentModBindings = {
  promptSegments: {
    'acme.notes.guidance': {
      id: 'acme.notes.guidance',
      tier: 'runtime',
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
  tier: PromptSegmentTier          // 'core' | 'runtime' | 'skill'；mod 绑定一律 'runtime'
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
`tier` 强制 `'runtime'`、`source` 统一打上 `` `mod:${record.modId}` ``——调试面板据此解释「这段从哪来」。

**为什么 mod 段不许进稳定前缀**：稳定前缀是 Tier0（身份 / 安全 / 不可变纪律），逐字不变。
放第三方文本进去有两个后果——它能排在安全类段之前，且只要它随上下文变一次，所有人的
provider 前缀缓存连同其后的整段历史一起失效（成本以 token 计、静默发生）。
同 ContextBuilder 的「mod 只能追加、不能重排官方段」判决。

## 预算与注入面

mod 贡献的常驻段计入**既有上下文治理预算**（`ProviderRequestCompiler` 出口 + `residentTools` schema），
不是新造的一套配额。超预算由既有治理降级，不做静态双脑。

> **注入面提醒**：mod 贡献的文本（提示词段 / 工具描述 / skill 正文）是 prompt injection 面。
> 「标注来源信任级 + 非 bundled 文本不与系统指令同权」是**净新建能力，尚未落地**——
> 外部代码 mod 必须同时兑现来源标注、权限隔离和资源预算。不要沿用 bundled-only 环境的
> 信任假设，也不要假设当前已有未文档化的隔离层。
