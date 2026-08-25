# 壳级 UI 轴：`ui.dock` / `ui.actions` / `ui.sidePanels` 与三档渲染梯

> **状态：planned / not implemented。**
> 本页记录设计方向，不构成可用 API 或兼容承诺。
> **三轴的注册表今天还不存在**——壳里对应的三处是硬编码 JSX、计算数组与运行时数组。
> 实装必须先引入版本化 schema、注册表、宿主端口与契约测试。在这些 owner 落地前，往 `ui` 节写
> 这三根轴不会有任何效果。通用边界见
> [Platform boundaries](../../architecture/platform-boundaries.md)。

---

## 一、渲染三档信任梯

「让 mod 在聊天页画东西」不是一个开关，是**三档**。
档位由「谁写渲染代码 + 崩了炸到谁」决定，**不由功能大小决定**。

| 档 | 形态 | 谁写渲染代码 | 信任级门 | 隔离 | 失败模式 | 用途判据 |
| --- | --- | --- | --- | --- | --- | --- |
| **T1** | 声明式卡片 DSL（壳的 CardKit 词汇，mod 只交**数据**） | **壳**（mod 零渲染代码） | **任何信任级**（含 `local-dev`） | 天然——mod 代码从不进渲染树 | 词条不认识 → 该词条降级为纯文本，卡不碎 | 结构化结果、状态、行动卡——**九成 mod 需求** |
| **T2** | 沙箱 HTML（复用 `@velaros-ai/html-artifacts` 的 iframe 流式运行时） | mod（HTML/JS） | **任何信任级** | iframe + blob URL + 既有 sandbox / security 面 | 沙箱内崩溃 / 超时 → 框内显错，壳无感 | 任意 UI、图表、小交互——壳词表表达不了的 |
| **T3** | 原生 React 模块（远程模块装载，直接进壳渲染树） | mod（React） | **仅 `bundled-official` / `marketplace-signed`** | **无**——同进程同渲染树 | 逐贡献错误边界 + lazy 分包 | 深度集成件（可替换槽位、复杂面板）——**例外，不是默认** |

**为什么 T2 不设信任级门**：iframe 沙箱是**机制性**隔离，不是**承诺性**隔离——
它不需要信任发布者。这正是 T2 存在的全部意义：让不可信代码也能画任意 UI。

**为什么 T3 卡死在两档信任级**：同进程同渲染树 = 没有隔离，只有**责任**。
错误边界防的是 bug，防不了恶意；防恶意只能靠签名与审核。

> **这条改判了「壳级扩展 v1 一律 bundled-only」**：
> 「bundled-only」从**轴级**约束降为**档级**约束——T1 / T2 对任何信任级开放，
> 只有 T3（原生 React / 槽位替换）保留信任级限定。

### 跨档共同铁律（三条，违反即拒载）

1. **不得自带揭示层**：mod 渲染件**禁止**自带打字机 / 逐字揭示动画。
   屏显节奏的唯一权威是 `ChatStreamPacer`。两个节奏源 = 两套时间线，必然错位——
   组件级影子打字机已被删过一次。
2. **重件必 lazy**：T2 / T3 渲染件一律动态 `import` 单独分 chunk。
   现成先例：`widget.tool-render.tsx` 顶部写死
   *"PERF GUARD: 注册文件会被 eager 扫描；HtmlPreviewFrame/sandbox 尤其不能静态导入"*。
3. **逐贡献错误边界**：每个贡献独立包边界。
   mod 崩溃是常态事件，不是异常事件——一个 mod 的坏渲染不许把会话变白屏。

---

## 二、T1 词表 = 壳既有 CardKit 词汇

T1 的 DSL **不发明新视觉语汇**，它是既有零件盒的**数据化投影**。
词表是**封闭集合、由官方演进**。

物理落点：`@velaros-ai/ui`（本仓 `packages/ui/src/product/layout/`），不在 Desktop renderer 内。

| DSL 词条（建议名） | 真实组件 | 导入路径 | 封闭枚举 / 关键 props |
| --- | --- | --- | --- |
| **卡容器** | `ActionCard` | `@velaros-ai/ui/product/layout/ActionCard` | cva 三轴：`tone` = `neutral\|info\|success\|warning\|error`（默认 `neutral`）、`layout` = `row\|stack`（默认 `row`）、`density` = `default\|compact`；props `icon` / `title`(必填) / `description` / `actions` / `onDismiss` + `dismissLabel` / `muted` |
| `statusPill` | **`CardStatusPill`** | `@velaros-ai/ui/product/layout/CardKit` | `tone: CardPillTone`、`size`（`default\|mini`） |
| `meta` | **`CardMeta`** | 同上 | `icon?` + children |
| `disclosure` | **`CardDisclosure`** | 同上 | `summary`、`defaultOpen?`（原生 `<details>/<summary>`） |
| `footer` | **`CardFooter`** | 同上 | `align`（`right\|between`） |
| `textButton` | **`CardTextButton`** | 同上 | `tone: CardTextButtonTone`（`approve\|reject\|neutral`）、`icon?` |
| `resultBlock` | **`CardResultBlock`** | 同上 | `tone: CardPillTone` |
| `code` / `text` | `ActionCardCode` / `ActionCardText` | `…/ActionCard` | `<code>` / `<div>` props 的同名薄封装 |

**真名带 `Card` 前缀**：是 `CardStatusPill` / `CardMeta` / `CardDisclosure` / `CardFooter` /
`CardResultBlock`，**不是** `StatusPill` / `Meta` / …。
另一个易踩点：这几件从 **`CardKit`** 路径导，不是从 `ActionCard` 路径导。

**配色不给自由度**：`tone` 是封闭五值，经 CSS 变量 `--action-card-accent` /
`--action-card-accent-soft` 取色（定义在 `packages/ui/src/styles/components/product.css`）。
主题 / 明暗 / 对比度是壳的责任；放开颜色 = 放开无障碍与暗色模式的责任。

**词表演进通道**：新词条 = 官方演进（壳 API 版本 + `engines.shell` 兼容轴），**不是 mod 能力**。
觉得词表不够用 → 走 T2，不走「加个自定义词条」。

### T2 的既有基建（不新建）

| 件 | 落点 |
| --- | --- |
| 运行时 | `@velaros-ai/html-artifacts`，子路径 `.` / `./protocol` / `./browser` / `./sandbox` / `./runtime` |
| 协议 | `HtmlArtifactProtocolParser`、`HTML_ARTIFACT_PROTOCOL_VERSION`、`HtmlArtifactRenderPatch`（`./protocol`） |
| 沙箱面 | `./sandbox` 导出 `resolveHtmlArtifactFrameFit`、`normalizeHtmlArtifactExternalUrl`、`buildHtmlArtifactDocument`、`HTML_ARTIFACT_WHEEL_MESSAGE_TYPE` |
| 壳侧挂载点 | `HtmlPreviewFrame`（`packages/ui/src/conversation/html-preview/`，子路径 `@velaros-ai/ui/conversation/html-preview`）——iframe + blob URL + IntersectionObserver 懒挂 |

**为什么复用而不是新建**：沙箱的安全面**只能有一份**——第二份沙箱意味着第二组逃逸面，
且两份里最弱的那份决定实际水位。

---

## 三、三根新壳轴

| 轴 | 贡献什么 | 描述符（v1 形状） | 内容渲染 |
| --- | --- | --- | --- |
| **`ui.dock`** | **应用头部 Dock 项** | `id` / `iconId` / `label`(i18n key) / `command` / `badge?` / `order?` / `when?` | 无（只有图标 + 标签 + 徽标） |
| **`ui.actions`** | **右侧按钮区图标按钮** | `id` / `iconId` / `tooltip` / `command` / `order?` / `when?` | 无 |
| **`ui.sidePanels`** | **右侧栏选项卡** | `id` / `title` / `iconId` / `order?` / `when?` / **`renderer`**（T1/T2/T3 之一） | 走三档梯 |

- **`iconId` 不是组件引用**——沿用 `AgentModSpaceContribution.iconId` 的同一条修正。
  组件引用一进 manifest，`ui` 节就不再是纯数据信封。
- **`when?` 是闭集条件表达式，不是谓词函数**——v1 只认已登记的条件键
  （如 `space` / `stageVisible` / `debugFeatures`）。函数进 manifest = 代码钩子越过白名单。
- **命名去歧义（重要）**：本轴的 **Dock = 应用头部 Dock**（`App.tsx` 里 `TopBar` 的兄弟层），
  **不是**会话内只承载 Plan / Goal 状态卡的 `SessionStickyDock`。
  两个「dock」今天同时存在于代码里，文档与实施必须始终带限定词。

**为什么恰好是这三根**：它们是聊天页**唯一三处「壳愿意让别人放东西」的常驻表面**
（头部 / 右侧动作 / 右栏）。少一根，mod 就得靠塞进消息流冒充 UI；
多一根，就开始把壳的布局权让渡出去。**不开「任意挂载点」轴**——
那等于 Eclipse 式运行时插件，挂载点一旦开放，壳的每次布局重构都变成生态破坏性变更。

### 迁移起点（今天这三处长什么样）

| 轴 | 今天在哪 | 今天是什么形状 |
| --- | --- | --- |
| `ui.dock` | `App.tsx` 局部常量 `chatSpaceDock` → `ChatTopBarControls`（`region: 'actions' \| 'dock'`）→ `ChatSpaceSwitcher`（`variant: 'topbar' \| 'dock'`） | **计算数组**：`resolveChatSpaceSwitcherItems()`（`chatSpaceSwitcherModel.ts`）按 `WorkspaceSpaceKind` 算项，**无注册表** |
| `ui.actions` | `ChatWorkspaceStageChrome.tsx` 局部常量 `topBarControls`，经 `createPortal` 投进 `App.tsx` 的宿主 div `ChatWorkspaceStageTopBarControlsId` | **手写内联 JSX**：4 个 `IconButton`，可见性靠 `hasProjectStage` / `debugFeaturesEnabled` 内联合取 |
| `ui.sidePanels` | 选项卡条 `CodeViewerTabBar`；`ChatWindow` 的 `sidePane` 槽 | **两族并存**：内容页签 `CodeViewerContentTab` = 判别联合（`file\|diff\|preview`）；辅助页签 `CodeViewerAuxiliaryTab` = 自由 string id + `kind` 的运行时数组，由 `buildChatWorkspaceStageAuxiliaryTabs()` 构建，现有 kind **只有** `worker-thread` / `skill` |

**事实校正（防按想象编码）**：右侧栏**今天没有** browser / memory / artifact 选项卡；
「右侧按钮区」**今天不是一个组件**，是一段内联 JSX + 一个 portal 宿主 div。

---

## 四、命令路由 = 声明式意图集（封闭四条）

三轴的 `command` 字段**不是函数**，是**意图**。v1 闭集：

| 意图 | 语义 |
| --- | --- |
| `send-prompt` | 往当前会话投递一条预置提示词（可带参数模板） |
| `open-panel` | 打开本 mod 声明的 `ui.sidePanels` 项 / 已注册页面。**唯一的导航原语**，不给任意路由跳转 |
| `invoke-capability` | 调用一个能力，**必过 Ring 0 permission broker**（默认 deny） |
| `open-url` | 外链（交宿主 URL 策略，不在应用内导航） |

- **为什么是意图不是回调**：回调 = 代码进 manifest；
  而声明式意图**可被索引、可被权限审计、可在 headless 宿主上不激活**。
- **`invoke-capability` 不得旁路 broker**——**UI 不是绕开权限门的后门**。
- **代码 handler 仅 T3**：T3 档的贡献可以挂真 handler（它本来就在渲染树里跑代码）；
  T1 / T2 永远只有意图。handler 的信任级门与 T3 的信任级门是同一道门。

---

## 五、「修改内置组件」= 具名可替换槽位，禁 monkey-patch

**禁止**任何形式的运行时打补丁：改原型、覆盖导出、拦截 render、全局 registry 即时改写。

「换掉内置件」的**唯一合法通道** = 壳枚举一张**具名槽位清单**，
mod 按 `slotId` 声明替换，**T3 档限定**（`bundled-official` / `marketplace-signed`）。

monkey-patch 的代价不在装的那天，在壳重构的那天——
被打补丁的内部件没有契约，壳每次改内部实现都在无声地炸生态。

### 槽位铁律（四条）

1. **封闭集合**，由官方演进；版本化为**壳 API**，兼容性走 `engines.shell`。
2. **单槽位单 owner**：两个 mod 抢同一槽 → **拒载并给可读诊断**。
   静默「后者胜」会让界面取决于加载顺序，不可复现。
3. **替换件按 T3 规矩**：lazy 分包 + 逐贡献错误边界；**边界降级 = 回落官方实现**，不是空白。
4. **槽位缺席可接受**：宿主不提供某槽 → partial-activation 语义，不残废激活。

### 首批槽位候选（实施时定案）

| 候选 slotId | 今天的实现 |
| --- | --- |
| `message.markdown` | `MessageMarkdownBlock` / `StreamingTextBlock` / `ThinkingBlock`（`packages/ui/src/conversation/blocks/MessageMarkdownBlocks.tsx`） |
| `message.codeBlock` | `useMessageMarkdownComponents(...)`，内含 `ExpandableCodeBlockFrame` / `RenderableHtmlCodeBlockFrame`，闭集 `NonExpandableCodeBlockLanguages`（`mermaid`）/ `RenderableHtmlCodeBlockLanguages`（`html`, `htm`） |

### 已经是注册表的先例（照抄形状即可）

- **`ToolRendererRegistry`**（类）/ **`ToolRenderRegistry`**（单例实例）
  ——`packages/ui/src/conversation/tool-render/ToolRenderRegistry.ts`，
  注册项类型 `ToolRenderRegistration { toolNames: readonly string[]; component: ToolRenderComponent }`，
  未注册工具回落默认 `ToolCallBlock`。
  ⚠️ 类名与实例名只差一个字母，别写错。
- `CodeViewerPreviewRendererRegistry`：
  `defineCodeViewerPreviewRenderer({ id, extensions, matchesMediaType?, maxBytes?, component })`，
  由 `CodeViewerPreviewPane` 以 **Suspense + 错误边界**托管。
- `ConversationRenderSlots` / `desktopConversationRenderSlots`：源码注释已写死
  「**有限具名集合**，非任意 children 洞」，缺注入时各 slot 默认渲染 `null`。
  这是槽位注册表应复用的形状：为它定义公开名称、版本和扩展入口，
  不是从零发明一套机制。

---

## 六、自食狗粮：内置件走同一注册表

验收线不是「注册表能用」，而是**专有代码路径被删掉**。

| 内置面 | 今天 | 迁移后 |
| --- | --- | --- |
| 空间切换器 Dock | `resolveChatSpaceSwitcherItems()` 计算数组 | 官方 `ui.dock` 贡献项（空间 mod 各自贡献自己的 Dock 项） |
| 舞台四按钮 | `ChatWorkspaceStageChrome` 内联 JSX + portal | 官方 `ui.actions` 贡献项，`when` 表达既有的 `hasProjectStage` / `debugFeaturesEnabled` |
| 辅助页签（worker-thread / skill） | `buildChatWorkspaceStageAuxiliaryTabs()` 运行时数组 | 官方 `ui.sidePanels` 贡献项 |
| 卡片渲染 | 各卡件直接 import CardKit | 官方卡逐步改走 T1 词表（**先做新卡，不为迁移而迁移**） |

**内容页签 `file/diff/preview` 不迁**——它是查看器**内核形状**，有判别联合和专属 pane，
迁进注册表只会把类型安全换成字符串。**自食狗粮不等于什么都塞进注册表。**

---

## 七、实现顺序

本页目前是设计记录，不是路线图承诺。采用此设计的产品宿主应按依赖顺序交付：

1. 先定义版本化 schema、注册表、宿主端口和契约测试；
2. 再实现 T1 数据 DSL，并迁移至少一个内置消费者验证单一路径；
3. 然后接入 T2 沙箱渲染和逐贡献错误边界；
4. 最后评估 T3 原生模块、命令总线、签名和回退机制。

每一步都必须删除被替代的专用路径，避免新旧两套权威并存。结构先于渲染内容，否则只能得到
无法证明宿主集成边界的演示代码。
