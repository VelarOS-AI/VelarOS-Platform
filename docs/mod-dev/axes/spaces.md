# 轴：`spaces` —— 自定义工作区开发规则

工作区（space）是 VelarOS 里**最大的一块贡献**：它一次性决定会话身份怎么算、能用哪些工具、
每回合往上下文里塞什么、记忆写去哪。本页是写一个新工作区的完整规则。

**主键 = `id`；纯数据轴，禁止运行态绑定。**

> **Desktop 接线状态：未接线**（`DesktopAgentModUnroutedAxes` 含 `spaces`）。
> 声明会被 Loader 接受并进注册表，但 Desktop 今天**不消费**它——三个内置工作区仍由
> 手写注册表 `DesktopCapabilityScopeRegistry` 供给。收敛批次见蓝图 M2c。

---

## 一、Schema

`AgentModSpaceContributionSchema`（`packages/agent/src/protocol/mods.ts`）：

```ts
z.strictObject({
  id: TrimmedIdSchema,                          // 主键，取代枚举值
  descriptor: z.strictObject({
    label: z.string(),                          // 必填
    hint: z.string().optional(),
    startTitle: z.string().optional(),
    order: z.number().int().optional(),
    localeKey: TrimmedIdSchema.optional(),
  }),
  iconId: TrimmedIdSchema.optional(),
  identityStrategy: z.enum(['ordinal', 'path', 'origin']),   // 必填，闭集
  surfaceProfileId: TrimmedIdSchema.optional(),
  boundCapabilityIds: tolerantArray(TrimmedIdSchema).optional(),
  toolCategoryIds: tolerantArray(TrimmedIdSchema).optional(),
  residentToolNames: tolerantArray(TrimmedIdSchema).optional(),
  turnContextSourceIds: tolerantArray(TrimmedIdSchema).optional(),
  promptSegmentIds: tolerantArray(TrimmedIdSchema).optional(),
})
```

> **命名提示**：这个类型叫 **`AgentModSpaceContribution`**。
> 蓝图 §3.3 里的伪代码块标题写作 `SpaceContribution`，Desktop 另有一个**同名不同形**的
> `SpaceDescriptor`（见 §四）。写代码时以 `AgentModSpaceContribution` 为准，
> 它是 Platform 侧唯一的 space 声明契约。

### 逐字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 空间 id。**取代枚举值**——新空间不需要改 `WorkspaceSpaceKind` |
| `descriptor.label` | ✅ | 切换器上的名字 |
| `descriptor.hint` | | 一句话说明 |
| `descriptor.startTitle` | | 空会话起始页标题 |
| `descriptor.order` | | 切换器排序 |
| `descriptor.localeKey` | | i18n key 前缀；见 [conventions.md](../conventions.md#四i18n-现状) |
| `iconId` | | **icon-id，不是组件引用**——打进 bundled 图标注册表 |
| `identityStrategy` | ✅ | 闭集 `'ordinal' \| 'path' \| 'origin'`。见 §二 |
| `surfaceProfileId` | | 绑定的 `AgentSurfaceProfile` id（引用既有闭集） |
| `boundCapabilityIds` | | 声明绑定的**重运行时主体**（浏览器引擎 / 编辑器）。**声明绑定，不重实现** |
| `toolCategoryIds` | | 本空间的工具包 |
| `residentToolNames` | | 常驻工具集（作为数据条目进宿主的 residentTools 算法） |
| `turnContextSourceIds` | | per-turn 上下文源白名单。**这是 mod 进入每回合上下文的唯一通道** |
| `promptSegmentIds` | | 本空间激活的提示词段（计入预算） |

### 三条不许越界的约束

1. **`iconId` 不是组件引用。** 组件引用一进 manifest，声明式就破了。
   图标降格为 id，由 bundled 图标注册表解析。
2. **`identityStrategy` 是闭集 id，不是 resolver 函数。**
   新增身份策略 = 内核演进，不是 mod 能力。同理不接受 `entityKeyResolver` 之类的函数字段。
3. **纯数据轴，零绑定。** `spaces` 在 `DataOnlyAxes` 里，
   传任何运行态绑定 → `mod.binding-not-allowed`：
   > `spaces 是纯数据轴，不接受运行态绑定（代码钩子只允许出现在工具 handler 与 seam 钩子上）。`

---

## 二、`identityStrategy`：会话成员身份怎么算

一个 folder 里可以有多个 member 会话。**成员身份策略决定「什么时候复用已有成员、什么时候开新的」**：

| 策略 | 身份键 | 语义 |
| --- | --- | --- |
| `ordinal` | 序号 | 每次新建都是新成员；没有「同一个目标」的概念 |
| `path` | 文件系统路径 | 同一个项目根复用同一个成员；换根 = 换成员 |
| `origin` | URL origin | 同一个站点复用同一个成员；导航在成员内改 URL，不新建 |

Desktop 今天的等价物是 `SpaceBinding`（`'none' | 'root' | 'site'`），落在
`selectOrCreateFolderMemberSession`
（`apps/desktop/src/renderer/src/hooks/chat/state/session/chatSessionPersistence.ts`）：
`isRootBoundSpace` 的空间按 `rootPath` 比对复用，`site` / `none` 复用第一个成员。
标题去重另有 `dedupeFolderMemberTitle`（`基名` → `基名 2` → `基名 3`），
对所有空间一视同仁——**它是标题级去重，不是身份策略**。

---

## 三、`turnContextSourceIds`：两道门，不是一道

这是最容易踩空的一条。per-turn 上下文源受**双门控**：

**gate1 —— 空间白名单**：`AgentModSpaceContribution.turnContextSourceIds`
（Desktop 现形：`SpaceDescriptor.turnContextSourceIds` → `TurnContextSourcesBySpace`）。

**gate2 —— 源自己的作用域声明**：每个源 producer 自带一个作用域数组。
契约在 `packages/core/src/types/turnContext.ts`：

```ts
interface TurnContextDeltaSource {
  id: TurnContextSourceId
  scopes: readonly CapabilityScopeId[]      // ← gate2
  rendererVisible?: boolean
  peekCached(input): TurnContextSourcePeekResult
}
```

合取判定在 `ChatTurnContextFanIn.peek()`
（`apps/desktop/src/main/chat/turncontext/FanIn.ts`）：

```ts
for (const sourceId of TurnContextSourcesBySpace[space]) {
  const source = this.sources.get(sourceId)
  if (!source || !source.scopes.includes(space)) continue
```

**新空间 id 只加进 gate1 白名单是不够的**——源的 `scopes` 里没有你的空间 id，
它照样拿零 delta。这是 mod 化 space 时的已知工位（蓝图 §3.3 C 修正）。

> **字段名校正**：蓝图 §3.3 把 gate2 写作 `source.spaces`。
> 真实字段名是 **`scopes`**（类型 `CapabilityScopeId[]`）。

`AgentModTurnContextSourceContribution` 轴（[turn-context-sources.md](./turn-context-sources.md)）
声明的字段名同样是 `spaces` ——那是 **manifest 上的声明字段**，与运行时的 `scopes` 是两个东西，
今天没有代码把前者翻译成后者（该轴在 Desktop 未接线）。

---

## 四、三个内置工作区（官方示例，逐字段）

内置三空间**今天还不是 mod**——它们住手写注册表
`apps/desktop/src/shared/capabilities/DesktopCapabilityScopeDescriptors.ts`，
形状是**另一个** `SpaceDescriptor`（7 字段）：

```ts
export type SpaceBinding       = 'root' | 'site' | 'none'
export type SpaceToolScope     = 'system' | 'project' | 'browser'
export type SpaceMemoryScopeKind = 'system' | 'project-root' | 'site-origin'

export interface SpaceDescriptor {
  id: WorkspaceSpaceKind
  text: { labelKey: string; hintKey: string; startTitleKey: string }
  iconName: 'desktop' | 'folder-open' | 'browser'
  binding: SpaceBinding
  toolScope: SpaceToolScope
  memoryScope: SpaceMemoryScopeKind
  turnContextSourceIds: readonly string[]
}
```

注册表类 `DesktopCapabilityScopeRegistry`（`list()` / `get(id)` / `resolve(id)`），
单例 `spaceRegistry`，辅助 `getSpaceDescriptor(id)` / `buildWorkspaceSpaceRecord<T>(project)`。
枚举 `WorkspaceSpaceKind = { Project: 'project', Browser: 'browser', System: 'system' }`
（`apps/desktop/src/shared/capabilities/DesktopCapabilityScopes.ts`）。

下面把三个空间逐字段映到 `AgentModSpaceContribution`，
**标注每个字段今天有没有真正的声明式来源**。

### 4.1 `system` —— 日常任务

| mod 字段 | 值 / 今天在哪 |
| --- | --- |
| `id` | `'system'` |
| `descriptor.label` | i18n key `workspace.systemRoot` → 「日常任务」/ "Daily tasks" |
| `descriptor.hint` | `workspace.systemRootHint` → 「处理日常事务与轻量编码」 |
| `descriptor.startTitle` | `workspace.systemStartTitle` → 「开始处理日常任务」 |
| `descriptor.order` | ❌ **无数字字段**——顺序 = `WORKSPACE_SPACE_ORDER` 的数组位次（`['system','project','browser']`） |
| `iconId` | `SpaceDescriptor.iconName = 'desktop'` |
| `identityStrategy` | 对应 `binding: 'none'`（复用第一个成员，无目标身份） |
| `toolCategoryIds` | 默认集 `['general', 'web', 'system-control']`（由 `getDefaultToolCategoriesForSpace` 反向算出） |
| `turnContextSourceIds` | `['task.lifecycle', 'memory.recall']` |
| `memoryScope`（蓝图字段，未进 schema） | `'system'` → scope id 字面量 `'system'` |

### 4.2 `project` —— 项目开发

| mod 字段 | 值 / 今天在哪 |
| --- | --- |
| `id` | `'project'` |
| `descriptor.label` | `workspace.projectRoot` → 「项目开发」/ "Project coding" |
| `descriptor.hint` | `workspace.projectRootHint` → 「绑定项目目录，专注写代码」 |
| `descriptor.startTitle` | `workspace.projectStartTitle` → 「开始一个项目工作区」 |
| `iconId` | `'folder-open'` |
| `identityStrategy` | 对应 `binding: 'root'` ≈ **`'path'`**：同一根复用同一成员，落 `selectOrCreateFolderMemberSession` 的 `rootPath` 比对 |
| `toolCategoryIds` | 默认集 `['general', 'workspace-inspect', 'workspace-edit', 'workspace-execute']` |
| `turnContextSourceIds` | `['workspace.editor-focus', 'workspace.editor-selection', 'workspace.filesystem-touches', 'workspace.project-roots', 'task.lifecycle', 'memory.recall']` |
| `boundCapabilityIds`（概念） | 编辑器。❌ **无 capability id 清单**——绑定是隐式的 |
| `memoryScope` | `'project-root'` → `` `project:${activeProjectRoot}` ``（`buildProjectMemoryScope`） |

### 4.3 `browser` —— 网页办公

| mod 字段 | 值 / 今天在哪 |
| --- | --- |
| `id` | `'browser'` |
| `descriptor.label` | `workspace.browserSite` → 「网页办公」/ "Web work" |
| `descriptor.hint` | `workspace.browserSiteHint` → 「在受控浏览器中执行网页任务」 |
| `descriptor.startTitle` | `workspace.browserStartTitle` → 「开始一个网页任务」 |
| `iconId` | `'browser'` |
| `identityStrategy` | 对应 `binding: 'site'` ≈ **`'origin'`**：导航改 `browserSiteUrl`，不新建成员 |
| `toolCategoryIds` | 默认集 `['general', 'browser']`；注意 `web` 类别在 browser 空间被 `deniedIn` 显式拒绝 |
| `turnContextSourceIds` | `['browser.manual-activity', 'browser.current-page', 'task.lifecycle', 'memory.recall']` |
| `boundCapabilityIds`（概念） | 浏览器引擎（kernel 模块 id `'velaros.desktop.browser'`，permissions `['browser:control']`）。❌ 不由 space 声明 |
| `memoryScope` | `'site-origin'` → `` `site:${new URL(url).origin}` ``（`buildSiteMemoryScope`） |

### 4.4 已知的三处未落地

| `AgentModSpaceContribution` 字段 | 今天 |
| --- | --- |
| `surfaceProfileId` | ❌ 无「每空间一个 profile」。profile 按 **surface** 建（`'chat'` / `'browser-control'` / `'scheduled-task'`），空间在 `deriveRunPolicy` 里作为正交过滤器进来 |
| `boundCapabilityIds` | ❌ 概念不存在 |
| `promptSegmentIds` | ❌ 无「每空间提示词段」。最接近的是 `DesktopPromptFeatureDefinition.allowedScopes`，方向是「特性 → 空间」而不是「空间 → 段」 |

`residentToolNames` 也不是声明的：Desktop 在
`DesktopAgentCapabilityPorts.scopePolicy.getResidency(facts)` 里**算**出来
（`ResidentControlToolNames` ∪ 该空间默认类别展开的工具名）。

---

## 五、声明式优先，运行态推断退为派生视图（铁律）

kernel 的空间原语只有两样：

1. **会话上的声明式 `spaceId`（一等字段）**——空间归属由会话自己声明，不是从运行态猜；
2. **空间 descriptor 注册轴**（本轴）。

**运行态推断（`isBrowserModeActive` 等）仅为派生视图，不得参与可见性 / scope 合取。**

这条不是洁癖，是真机实锤：browser 空间起始页「声明了 browser 空间却推断不出 browser 态」
导致工具全隐身死锁。在 headless / web 桥这类**没有 Electron webview 运行态**的宿主下，
该推断永远返回 `false`，双脑分裂从边缘 bug 变成**必然复现**。

Desktop 今天的正确形状（`apps/desktop/src/main/agent/context/ToolContext.ts`）：

```ts
const isBrowserModeActive = () => getActiveSpaceBinding() === 'site'          // 身份：走声明
const isBrowserSiteBound  = () => isBrowserModeActive() &&
  args.workspaceRootService.isBrowserModeActive(browserSessionId)             // 可用性：走运行态
```

**身份走声明 binding，可用性走运行态**——写新空间时照这个分法。

---

## 六、写一个新工作区的检查表

```json
{
  "id": "acme.notebook",
  "descriptor": {
    "label": "笔记本",
    "hint": "在笔记库里做检索与整理",
    "startTitle": "开始整理笔记",
    "order": 400
  },
  "iconId": "notebook",
  "identityStrategy": "path",
  "toolCategoryIds": ["general", "acme-notes"],
  "residentToolNames": ["acme_notes_search"],
  "turnContextSourceIds": ["acme.notes.recent"],
  "promptSegmentIds": ["acme.notes.guidance"]
}
```

- [ ] `id` 不与既有空间撞（撞了 → `mod.contribution-conflict`）
- [ ] `identityStrategy` 在闭集内，且与你的「什么算同一个目标」一致
- [ ] `iconId` 是 id 不是组件
- [ ] `toolCategoryIds` / `residentToolNames` / `turnContextSourceIds` / `promptSegmentIds`
      引用的条目**要么是官方既有的，要么由你自己的 mod 在对应轴上贡献**——
      引用不存在的 id 今天不会在 Loader 阶段报错（跨轴引用完整性校验尚未实装），
      但运行时就是静默拿不到东西
- [ ] 没有传任何运行态绑定
- [ ] 如果你的空间**必须**有 space 轴才有意义，把 `'spaces'` 写进顶层 `requiredAxes`——
      headless 宿主不支持时会明确拒载而不是残废激活

### 存储分区提醒

**v1 不建 storage 分区抽象层。** 会话内 `archive/` / `workspace/` / `browser/<site>/`
三个物理目录的计算由宿主的 `PathService` 负责，
三者的差异是**安全边界**（是否在沙箱根内 / 是否模型可见 / 是否按成员子键分片），
不是命名偏好，扁平 `key → dir` 映射表达不了。
第四空间要持久化时，走宿主既有分区或非持久化——
**存储分区抽象是「第一个真正需要持久化的第四空间落地时」的已知前置**，现在不要自己造。
</content>
