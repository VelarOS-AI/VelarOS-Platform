# Changelog

`@velaros-ai/ui` 的变更记录。遵循 [Keep a Changelog](https://keepachangelog.com/) 与
[Semantic Versioning](https://semver.org/)。门面包背 semver 承诺（§12「门面收口」）；内部原子演化
不进本记录。记录起点为 `@velaros-ai/ui` 公开门面与组件库成型。

## [Unreleased]

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
