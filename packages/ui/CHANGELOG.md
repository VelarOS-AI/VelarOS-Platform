# Changelog

`@velaros-ai/ui` 的变更记录。遵循 [Keep a Changelog](https://keepachangelog.com/) 与
[Semantic Versioning](https://semver.org/)。门面包背 semver 承诺（§12「门面收口」）；内部原子演化
不进本记录。记录起点为 `@velaros-ai/ui` 公开门面与组件库成型。

## [Unreleased]

## [0.2.32] — 2026-09-07

### Fixed

- Git 分支控件统一使用通用按钮、搜索框和浮层外观，普通加载与懒加载保持一致，修复额外边框、背景和阴影。
- Popover 显式排除桌面窗口拖拽区域；分支搜索在浮层定位可见后获得焦点。
- 关闭浮层时恢复实际触发按钮的焦点，点击外部输入框时保留外部焦点。

### Added

- `PopoverContent` 和 `AnchoredPopover` 提供 `onOpenAutoFocus`，由调用方在定位完成后选择聚焦目标。

## [0.2.31] — 2026-09-06

### Changed

- 包清单改用 GitHub 可识别的规范 HTTPS 源地址，使公开包页面能关联到唯一的 Platform 仓库。

## [0.2.30] — 2026-09-06

### Changed

- 发布包现随附 Apache-2.0 `NOTICE` 与 Tailwind CSS 第三方许可文本。

## [0.2.29] — 2026-09-02

### Fixed

- 聊天输入框的模型摘要只显示模型名，厂商仍保留在展开菜单中，给计划、目标等动态状态留出工具栏空间。

## [0.2.28] — 2026-08-30

### Fixed

- 输入框正文为空时按退格键会移除最后一张待发送图片，并保持共享会话输入行为一致。

## [0.2.17] — 2026-08-29

### Added

- `Select` 新增长列表搜索能力，搜索区固定在列表顶部，并提供无匹配结果提示。

### Fixed

- 下拉选项视口统一绘制可见滚动条，在 macOS 覆盖式滚动条设置下仍能明确展示可滚动状态。

## [0.2.16] — 2026-08-29

### Fixed

- Git 分支菜单的搜索区域直接复用共享 `SearchField`，图标、输入层、边框与聚焦态由同一个控件持有，避免基础输入框在外壳内再次绘制边框。

## [0.2.15] — 2026-08-28

### Added

- 会话消息新增可选归属字段 `peerOrigin` 与判据 `isPeerOriginMessage`：标记一条 `role: 'user'`
  的消息由**同组的另一条会话**写入，而不是用户本人。用户气泡据此显示同伴署名（`UsersThree`
  图标 + `chat.peerMessageFrom` 文案），与运行中引导标签互斥且优先——两者万一同时出现，
  「这不是用户说的」是更要紧的那条信息。
- 归属刻意不做成新的 `ChatMessageConversationKind` 成员：`conversationKind` 是结构轴（起不起
  一轮、能否回退、是不是分段边界），归属是另一根轴。同伴消息确实起一轮真实执行，必须保持
  `turn-input`——换成新 kind 会静默丢掉回退按钮、分页分段起点、「最近一次用户请求」映射与
  活动分组的轮次边界，而且一处编译错误都不会有。

## [0.2.14] — 2026-08-26

### Added

- 新增共享 `SearchField` 原语，统一搜索输入、清除和聚焦语义。
- 新增 `WorkspaceGitCommitControl`，在组件内部统一承载成熟分支菜单、文件夹分组与新建分支弹窗，并通过宿主端口执行 Git 动作。

## [0.2.13] — 2026-08-25

### Added

- 会话 Markdown 支持渲染 Mermaid 声明式图表，并可在右上角双向切换预览与源码。

### Changed

- HTML 与声明式图表代码块共用通用的预览/源码状态框架；流式生成期间稳定回退到源码，完整后再进入可视预览。

## [0.2.11] — 2026-08-25

### Fixed

- 折叠组件的自动收起由完成态实时信号统一驱动。

## [0.2.10] — 2026-08-25

### Fixed

- 会话正文只把绝对文件路径渲染为可打开的文件链接；文件名、`src/`、`test/` 等相对路径保持普通文本，避免被浏览器当作页面 URL。
- 用户向上滚动后，转录窗口与宿主滚动钉底状态同步暂停；模型首段输出和后续流式增长不再重建末尾窗口并夺回视口。
- 引导开始但新 assistant 消息尚未到达时，上一条已完成消息保持原有折叠状态。
- “已处理”的完成信号在容器已挂载后到达时仍会执行自动收起。

## [0.2.9] — 2026-08-25

### Changed

- 会话卡片契约统一为 `conversationCards` / `conversationCardContent`：宿主卡渲染到会话正文，`SessionStickyDock` 只承载由会话壳派生的 Plan / Goal 状态卡。
- Plan / Goal 在正文中保留通用工具调用行，完整状态卡集中到 `SessionStickyDock`。

## [0.2.8] — 2026-08-25

### Fixed

- 一次带引导的完整交流只生成一个“已处理”：运行中保持原 assistant 宿主，正常完成后由最终 assistant 统一承载此前内部活动，最终总结留在折叠外。
- 归组后的子消息不再各自生成嵌套折叠组件；引导内容保留在唯一的“已处理”内部。

## [0.2.7] — 2026-08-25

### Fixed

- 引导固定归属于插入前已挂载的 assistant，后续片段不会更换宿主或重置上方折叠状态；完成标记从整轮最后状态统一投影。
- 完成态内部的连续思考与工具折叠项跨消息横排，正文和引导仍保持独立行。
- 回顶和向上分节导航会先暂停自动跟随；内容重排和下一帧提交也不会把已离开底部的视口重新拉回。

## [0.2.6] — 2026-08-25

### Fixed

- 引导作为当前运行的内部状态插入时不改变前序活动块的折叠状态；已结束的旧会话仍保留每个活动块的折叠入口。
- 连续折叠的思考、工具与命令摘要合并到同一行展示。

## [0.2.5] — 2026-08-24

### Added

- `@velaros-ai/ui/conversation/composer` 新增 `ChatSurfaceComposer`：由共享的
  `default` / `side` 表面形态统一派生输入框密度，Desktop 与 Workbench 只注入
  `ChatComposerControl`，不再分别维护紧凑模式条件。
- 新增封闭契约的 `TaskWorkspace`、任务列表、详情与回放布局，并登记到组件图鉴。

### Changed

- `run-guidance` 只作为当前运行的内部状态：运行中不创建新会话分段，完成后与同一运行的
  assistant 活动统一折叠到一个“已处理”入口，展开后保留引导内容。

## [0.2.4] — Workbench composer parity

### Added

- `FileTypeIcon` recognizes `.vel` files and renders the official borderless
  VelarScript V/S mark with theme-aware contrast.
- Workbench 当前文件 chip 新增可选移除回调；未传回调时外观与交互保持不变，
  传入后复用 Desktop 同一套“悬浮图标变 ×”的 chip 行为。
- `@velaros-ai/ui/conversation/render-slots` 增两格**替换槽**：`messageMarkdown` / `messageCodeBlock`
  （+ props 契约 `ConversationMarkdownSlotProps` / `ConversationCodeBlockSlotProps`）。两格为**可选**
  属性，缺席 = 官方内置件原行为；替换件弃权（返回 `null`）或渲染抛错一律回落官方件。

## [0.2.2] — 第三方包边界与接口文档

### Added

- 补齐正式 npm 元数据、中文 API 文档与发布 tarball 契约门禁。
- 导出流式会话调度端口，并提供应用隔离的 `ToolRendererRegistry`。

### Removed

- 删除只做原样返回的工具注册辅助函数，注册声明改用显式类型。

## [0.2.0] — 运行时零依赖与封闭导出

### Changed

- `@velaros-ai/ui/conversation` 的消息、工具、运行态和宿主动作类型改为包内纯展示 DTO/ports；
  Result、计时器、JSON 读取、工具视觉目录与 composer feature 目录全部由 UI 仓自持。
- `@velaros-ai/ui` 的所有受支持组件深路径改为显式 exports，继续保留现有组件根门面与视觉行为。

### Removed

- 删除 `@velaros-ai/ui/conversation` 对 `@velaros-ai/core` 的依赖与全部源码 import。
- `@velaros-ai/ui` 不再发布 `src`，并移除开放式 `./*` export。

### Guarded

- 独立性门扩展到两包：基础 UI 禁止全部外部 VelarOS 包，Conversation UI 只允许 UI 与 HTML
  沙箱库；同时拒绝本地路径依赖、UI wildcard exports 和 source 发布。

## [0.1.3] — 独立组件库边界

### Changed

- `@velaros-ai/ui` 将基础类型判断、可选值辅助、界面计时器与空间图标语义收回包内，不再依赖
  `@velaros-ai/core`。
- 完整组件目录从公开组件 Props 推导示例类型，并使用目录本地 fixture 工具，不再直接引用 Kernel。

### Guarded

- 新增组件库独立性门禁，禁止完整目录、仓库根与 `@velaros-ai/ui` 引入 Kernel、Desktop、
  Workbench 或 HTML Artifacts 运行时依赖。

### Added

- 双色种子色彩体系（§12.9）：新增两个可配置种子令牌 `--velar-primary` / `--velar-accent`（+ 配套
  `-rgb`），品牌相关语义令牌改由双种子派生；官方预置组合 `seed-presets.css`（`velar-indigo` 默认 /
  `graphite-blue` / `forest-amber` / `plum-rose` / `slate-teal`），经 `data-velar-preset` 激活。
  用户配置接口形状见 `docs/ui-color-seeds.md`。默认预置视觉与既有单色现状**逐值等价**。
- 每个公开组件补规范头注释（职责一句话 / variant 封闭枚举 / 样式引用）。
- `README.md` 重写为组件索引（primitives / product 分区，每组件一行）+ 双色种子令牌表 + §12.9 存量
  收敛 Backlog 节。
- `publishConfig.access = public`（门面包对外发布）。
- 发布纪律：起卷 `CHANGELOG.md`。

### Changed

- `--primary` / `--primary-rgb` 由主题种子派生（历史令牌名保留为兼容别名）；`--memory-accent-*`
  由副色种子派生。既有主题（浅色）视觉逐值等价。

### Removed

- 删除死代码 `styles/components/index.monolith.css`（未被任何入口 @import / 未导出，被拆分后的
  `index.css` + `primitives/*.css` 取代）。

### Guarded

- arch-guard 新增 `velaros/ui-component-form-closure`（§12.9）：`packages/ui` 组件禁 className/style
  透传与 ComponentProps 全展开；存量入 baseline 冻结、新增即红。
- arch-guard 新增 `velaros/ui-color-literal-closure`（§12.9 双色种子）：组件层禁裸 hex/rgb/hsl 色值，
  令牌层豁免；存量入 baseline 冻结、新增即红。

## [0.1.2] — 可交互组件图鉴

### Added

- 独立预览页升级为完整组件目录，按动作、表单、展示与反馈、导航与布局、浮层、产品组件六类
  展示 30 个可交互现场示例。

### Fixed

- 提升 ghost 按钮文字对比度，并补齐键盘焦点与按下反馈。
- 修复 `useDisclosurePresence` 在 React StrictMode effect 重放后复用已释放 `TimerScope`、
  导致折叠组件预览崩溃的问题。

## [0.1.1] — 独立消费元数据

### Added

- npm 包随 `dist` 一并携带 `src`，作为组件图鉴构建期的类型、注释与 variant 默认值元数据。
  Desktop 只从已安装的版本化包读取，不再探测相邻 `VelarOS-UI` 工作区。

## [0.1.0] — 组件库重生

### Added

- 跨产品 **primitives**（buttons / display / forms / layout / overlays）与 VelarOS **product** 壳层
  组件（AppShell / ActionCard / CardKit / BusinessSurface / Settings / TopBarControlFrame 等）。
- 全局 `.velar-*` CSS 组件类层（纯 CSS + 设计令牌，无 Tailwind `@apply`）。
- 设计令牌入口 `styles/tokens/design-tokens.css`（浅色主题 + 暗色占位）。
- 组件库图鉴 registry 与「公开组件必须有 entry 覆盖」生成器硬门。
