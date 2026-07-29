# 轴：`turnContextSources`

声明一个 per-turn 上下文源。**主键 = `id`；纯数据轴，禁止运行态绑定。**

**这是 mod 贡献进入每回合上下文的唯一通道。**

> **Desktop 接线状态：未接线**（`DesktopAgentModUnroutedAxes` 含 `turnContextSources`）。

## Schema

`AgentModTurnContextSourceContributionSchema`：

```ts
z.strictObject({
  id: TrimmedIdSchema,                                  // 主键
  label: z.string().optional(),
  spaces: tolerantArray(TrimmedIdSchema).optional(),    // 空数组 = 不限 space
  rendererVisible: z.boolean().optional(),
  priority: z.number().int().optional(),
})
```

| 字段 | 说明 |
| --- | --- |
| `spaces` | 本源在哪些 space 生效。**空数组表示不限 space** |
| `rendererVisible` | 这条 delta 要不要在渲染层露出（chips / note） |
| `priority` | 排序 |

## 纯数据轴

`turnContextSources` 在 `DataOnlyAxes` 里，传绑定即 `mod.binding-not-allowed`。
`projectAgentModTurnContextSources(snapshot)` 直接返回 `record.declaration`——
**它只是声明，不是 producer**。

## 与运行时 source 契约的关系（重要）

真正产出 delta 的是 `TurnContextDeltaSource`（`packages/core/src/types/turnContext.ts`）：

```ts
interface TurnContextDeltaSource {
  id: TurnContextSourceId
  scopes: readonly CapabilityScopeId[]      // 注意：叫 scopes，不叫 spaces
  rendererVisible?: boolean
  peekCached(input): TurnContextSourcePeekResult
}
```

manifest 上的 `spaces` 与运行时的 `scopes` **今天没有翻译层**——
该轴在 Desktop 未接线，所以贡献一条声明不会凭空长出一个 producer。
真正落地时需要的两件事：① 声明 → 注册；② producer 的 `scopes` 与 space 声明对齐。

## 两道门（写空间的人必读）

一条源要在某空间产出 delta，必须**同时**过两道门：

- **gate1**：该空间的 `turnContextSourceIds` 白名单里有它；
- **gate2**：该源自己的 `scopes` 里有这个空间 id。

合取判定在 `ChatTurnContextFanIn.peek()`
（`apps/desktop/src/main/chat/turncontext/FanIn.ts`）。
详见 [spaces.md §三](./spaces.md#三turncontextsourceids两道门不是一道)。

## Desktop 现有的六个源（参考）

| id | producer | `scopes` |
| --- | --- | --- |
| `workspace.project-roots` | `createProjectRootsSource`（`main/chat/turncontext/ProjectRootsSource.ts`） | `[Project]` |
| `browser.current-page` | `createBrowserCurrentPageSource`（`main/chat/turncontext/BrowserCurrentPageSource.ts`） | `[Browser]` |
| `workspace.filesystem-touches` | `createTurnContextSources()`（`main/workspace/domain/signals/Coordinator.ts`） | `[Project]` |
| `browser.manual-activity` | `packages/browser/src/core/BrowserActivityCoordinator.ts` | `['browser']` |
| `memory.recall` | `MemoryTurnRecallCoordinator.createTurnContextSource`（`packages/memory/src/adapter-kernel/TurnRecallCoordinator.ts`） | 宿主注入；Desktop 传三空间全集，`rendererVisible: false` |
| `task.lifecycle` | `packages/agent/src/kernel/background-jobs.ts` | `[]` |

注册点集中在 `apps/desktop/src/main/bootstrap/composition/chat.ts`。

> **两条现状提醒**（写新源前值得知道）：
> ① `task.lifecycle` 声明 `scopes: []`，gate2 恒 false ——三个空间的 gate1 白名单都列了它，
> 但 FanIn 会把它过滤掉；
> ② `workspace.editor-focus` / `workspace.editor-selection` 在 gate1 白名单与渲染层 id 允许表里，
> 但**没有对应的 producer**。
> 两条都记录在 [conventions.md 的文档-代码漂移清单](../conventions.md#附文档-代码漂移清单)。
</content>
