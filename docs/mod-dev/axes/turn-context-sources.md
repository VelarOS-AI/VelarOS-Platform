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

## Desktop 现有的六个源（参考，2026-07-30 核对）

| id | producer | `scopes` |
| --- | --- | --- |
| `workspace.project-roots` | `createProjectRootsSource`（`main/chat/turncontext/ProjectRootsSource.ts`） | `[Project]` |
| `browser.current-page` | `createBrowserCurrentPageSource`（`main/chat/turncontext/BrowserCurrentPageSource.ts`） | `[Browser]` |
| `workspace.filesystem-touches` | `createTurnContextSources()`（`main/workspace/domain/signals/Coordinator.ts`） | `[Project]` |
| `browser.manual-activity` | `packages/browser/src/core/BrowserActivityCoordinator.ts` | `['browser']` |
| `memory.recall` | `MemoryTurnRecallCoordinator.createTurnContextSource`（`packages/memory/src/adapter-kernel/TurnRecallCoordinator.ts`） | 宿主注入；`rendererVisible: false` |
| `task.lifecycle` | `packages/agent/src/kernel/background-jobs.ts` | 宿主注入（必填，空数组直接抛） |

注册点集中在 `apps/desktop/src/main/bootstrap/composition/chat.ts`。

> **跨空间源一律不要手写 `scopes`**：Desktop 用
> `resolveTurnContextSourceScopes(sourceId)`（`apps/desktop/src/shared/capabilities/DesktopTurnContextPolicy.ts`）
> 从 gate1 白名单反查后注入，两道门永远同底。`task.lifecycle` 曾因空间化重构把常量数组降级成 `[]`，
> gate2 恒 false 让整条 task delta 通道静默失联（已修，`scripts/checks/kernelAssembly.mjs` ⑥ 锁）。
</content>
