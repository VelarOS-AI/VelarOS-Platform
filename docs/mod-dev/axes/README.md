# 贡献轴参考

**贡献轴是封闭集合，由官方演进——mod 不能发明新轴。** manifest 里出现未登记的轴名 =
未知字段 = `mod.manifest-invalid` 拒载（`AgentModContributesSchema` 是 `z.strictObject`）。

## 九根 agent 轴（住 `agent.contributes`）

闭集常量 `AgentModContributionAxisNames`（`packages/agent/src/protocol/mods.ts`），
**顺序即声明顺序**：

| 轴 | 主键 | 运行态绑定 | Desktop 接线 | 文档 |
| --- | --- | --- | --- | --- |
| `tools` | `name` | **必需** | ✅ 已接线 | [tools.md](./tools.md) |
| `toolCategories` | `id` | 可选 | ✅ 已接线 | [tool-categories.md](./tool-categories.md) |
| `promptSegments` | `id` | 可选（否则须带 `text`） | ✅ 已接线 | [prompt-segments.md](./prompt-segments.md) |
| `skills` | `id` | 可选 | ✅ 已接线 | [skills.md](./skills.md) |
| `spaces` | `id` | **禁止** | ✅ 已接线（只消费工具配方那几格） | [spaces.md](./spaces.md) |
| `subAgentTypes` | `id` | 可选 | ✅ 已接线 | [sub-agent-types.md](./sub-agent-types.md) |
| `turnContextSources` | `id` | **禁止** | ⚠️ 未接线 | [turn-context-sources.md](./turn-context-sources.md) |
| `executionModes` | `id` | 可选 | ⚠️ 未接线 | [execution-modes.md](./execution-modes.md) |
| `hooks` | `id` | **必需** | ✅ 已接线（5/15 kind） | [hooks.md](./hooks.md) |

「⚠️ 未接线」= `DesktopAgentModUnroutedAxes`（`apps/desktop/src/main/kernel/AgentModRuntime.ts`，
由落点表 `DesktopAgentModAxisSinkNames` 取补集派生）：Desktop 还没把这条轴接进任何运行时消费者。
**这两条轴不在 Desktop 的 `supportedAxes` 里**，因此：

- 贡献它们不会报错，但**贡献会被 Loader 裁掉**（不进注册表），mod 状态落 `partial`；
- 设置页那一行显示「未接线轴」，诊断码 `desktop.mod.axis-unrouted`；
- 把它们写进 `requiredAxes` = **拒载**（fail-closed 如实生效）。别为了「保险」写上去。

「✅ 已接线（只消费工具配方那几格）」：`spaces` 轴 Desktop 真正读的是
`identityStrategy` / `boundCapabilityIds` / `inheritsSpaceIds` / `toolCategoryIds` / `residentToolNames`。
`descriptor` / `iconId` / `surfaceProfileId` / `turnContextSourceIds` / `promptSegmentIds` 是**空格子**
（schema 保留，随包官方 mod 已不再声明）：空间的文案、图标与每回合上下文源白名单权威在产品壳的
枚举表里。改这几格不会有任何变化，也不会有诊断——所以别改，去改壳。

## 两族 ui 轴（住 `ui`，产品壳读）

| 轴 | 内容 | 状态 | 文档 |
| --- | --- | --- | --- |
| `ui.settings` | 声明式设置分组 / 字段 DSL | ✅ 已实装（Desktop） | [ui-settings.md](./ui-settings.md) |
| `ui.dock` / `ui.actions` / `ui.sidePanels` | 应用头部 Dock 项 / 右侧按钮区 / 右侧栏选项卡 | 契约已定，实装批次 **W1** | [ui-shell.md](./ui-shell.md) |
| `pages` / `settingsRenderers` / `surfaces` / `tours` | 既有壳级轴 | 契约已定，硬编码引用 → 注册表收集未做 | [ui-shell.md](./ui-shell.md) |

**壳级 UI 轴不在 Agent 主干。** 在 `agent` 节里写 `pages` / `surfaces` / `tours` =
未知贡献点 = 拒载。它们住 `ui` 节，Agent 侧读都不读。

## 三条跨轴通则

### ① 绑定规则

```
PayloadRequiredAxes = { 'tools', 'hooks' }               // 缺绑定 → mod.binding-missing
DataOnlyAxes        = { 'spaces', 'turnContextSources' } // 带绑定 → mod.binding-not-allowed
```

`promptSegments` 特例：有 `text` 或有绑定，二选一，都缺即拒载。
其余轴（`toolCategories` / `skills` / `subAgentTypes` / `executionModes`）绑定可选——
没绑定就只是一条声明记录，`payload` 为 `null`。

### ② 主键唯一性

- **同一 mod 内**：轴内主键重复 → `mod.duplicate-contribution`（manifest 解析阶段）。
- **跨 mod**：轴内主键**全宿主唯一**。撞了就拒载，
  `tools` 轴给 `mod.tool-name-conflict`，其余轴给 `mod.contribution-conflict`。
  **不做「后者覆盖前者」**——静默覆盖会让用户看到的行为取决于加载顺序，不可复现。

主键取法（`readAgentModContributionKey`）：`tools` 用 `name`，**其余全部用 `id`**。

### ③ 形态层宽容，语义层零宽容

`tolerantArray` 只做一件事：**标量字符串 → 单元素数组**。
`TrimmedIdSchema` 只做一件事：**trim 后非空**。
除此之外——未知字段、非法枚举、重复主键、`requiredAxes` 越界——一律**拒载并给可读诊断**。

## 消费面投影

装配链不直接遍历注册表，读 `AgentModProjection.ts` 的纯函数投影（同一快照恒得同一结果，
且**保持载荷对象同一性**：装载不复制、不包装、不改写运行态载荷）：

| 投影 | 返回 |
| --- | --- |
| `projectAgentModTools(snapshot)` | `Record<string, VelaTool<any>>` |
| `projectAgentModToolCategories(snapshot)` | `Record<string, ToolCategoryDefinition>` |
| `projectAgentModPromptSegments(snapshot)` | `PromptSegmentDefinition[]` |
| `projectAgentModSkills(snapshot)` | `AgentSkillDefinition[]` |
| `projectAgentModSpaces(snapshot)` | `AgentModSpaceContribution[]`（纯声明） |
| `projectAgentModSubAgentTypes(snapshot)` | `SubAgentTypeDescriptor[]` |
| `projectAgentModTurnContextSources(snapshot)` | `AgentModTurnContextSourceContribution[]`（纯声明） |
| `projectAgentModExecutionModes(snapshot)` | `ExecutionModeDescriptor[]` |
</content>
