# @velaros-ai/ui

VelarOS unified UI component library: cross-project **primitives** + VelarOS **product shell**.
门面包（§12「门面收口」），对外背 semver；内部原子在门面之内自由演化。

公共入口、组件约定、样式依赖和第三方接入示例见
[中文 API 文档](./docs/api.zh-CN.md)。

组件形态封闭（kernel-contract §12.9）：库**不搞通用、只做统一、可组合**。每个组件预设有限形态
（variant 封闭枚举，全仓共用一套），**不开 className/style 逃生口**、**不做 ComponentProps 全展开**；
tone / 主题走 CSS 变量单源（双色种子体系，见 [Design tokens](#design-tokens)）。存量逃生口冻结在
arch-guard baseline、只降不升，收敛计划见 [Backlog](#backlog)。

## Development

Run `bun run --cwd packages/ui dev` from the repository root to start the standalone Vite
component-library app. It imports package source through the public `@velaros-ai/ui` namespace,
supports hot reload, and is production-built by the root `bun run check` gate. The published package
contains only compiled `dist` artifacts and documentation; component metadata is generated inside this
repository, so consumers never need or receive the source tree.

## Responsibility

This package owns reusable UI primitives, product-level VelarOS shell components, shared CSS
component classes, and design token CSS for renderer surfaces. It must stay independent from
renderer features, IPC, storage, app-specific business models, and all other VelarOS runtime
packages. The repository gate rejects direct Kernel, Desktop, Workbench, or HTML Artifacts imports.

## Component Index

分区法则（§12「一包一义」/ 命名一致性）：**primitives** = 跨产品复用、无业务语义的原子；
**product** = VelarOS 产品壳层组合件（AppShell / ActionCard / 业务表面等）。每个组件的规范头注释
（职责一句话 / variant 封闭枚举 / 样式引用）在各自源文件顶部。

### primitives

`buttons`

| 组件         | 职责                                             |
| ------------ | ------------------------------------------------ |
| `Button`     | 文本 / 图标+文本命令按钮，统一强调层级           |
| `IconButton` | 纯图标动作按钮（工具条 / 行内锚点 / 标题附加动作）|

`display`

| 组件           | 职责                                    |
| -------------- | --------------------------------------- |
| `Badge`        | 状态 / 分类小标签                       |
| `Empty`        | 空状态占位块（图标 + 标题 + 说明 + 动作）|
| `FileTypeIcon` | 按文件类型渲染带品牌色的文件图标         |
| `Label`        | 表单字段标签                            |
| `Link`         | 行内文本链接                            |
| `Paragraph`    | 正文段落文本                            |
| `Progress`     | 线性进度条                              |
| `Result`       | 结果态大块反馈（成功 / 失败 / 信息）     |
| `Skeleton`     | 加载骨架占位                            |
| `Spin`         | 旋转加载指示器                          |
| `Tag`          | 可着色标签片                            |
| `Text`         | 行内文本原语（size / tone）             |
| `Title`        | 标题文本（层级字号）                    |

`forms`

| 组件               | 职责                                     |
| ------------------ | ---------------------------------------- |
| `Calendar`         | 日历选择面板（单日 / 范围）              |
| `Checkbox`         | 复选框                                   |
| `Input`            | 单行文本输入                             |
| `NumberInput`      | 数值输入（步进 + 范围）                  |
| `Picker`           | 通用弹层选择器                           |
| `RadioGroup`       | 单选组                                   |
| `SegmentedControl` | 分段控件（卡内策略 / 模式切换）          |
| `Select`           | 下拉选择                                 |
| `Switch`           | 开关（持久二元状态）                     |
| `TextSelect`       | 文本样式的轻量下拉                       |
| `Textarea`         | 多行文本输入                             |
| `TimePicker`       | 时间选择器                               |

`layout`

| 组件                    | 职责                                    |
| ----------------------- | --------------------------------------- |
| `Breadcrumb`            | 面包屑导航                              |
| `Card`                  | 基础卡片容器                            |
| `Center`                | 居中布局容器                            |
| `CollapsibleBlockFrame` | 可折叠区块外框                          |
| `DataTable`             | 数据表格原语                            |
| `DescriptionList`       | 键值描述列表                            |
| `Disclosure`            | 展开 / 收起披露原语（行为层）           |
| `Divider`               | 分隔线（含可选标题）                    |
| `Flex` / `Inline` / `Stack` / `Center` / `Space` | Flex / 横向 / 纵向 / 居中 / 间距 布局容器 |
| `Grid` / `RowCol`       | 网格 / 行列栅格                         |
| `HoverRevealRow`        | 悬停显隐行                              |
| `List` / `ListGroup`    | 列表 / 分组列表                         |
| `Panel`                 | 弱化背景的分区面板                      |
| `ScrollArea`            | 自定义滚动区域                          |
| `Separator`             | 语义分隔符                              |
| `Steps`                 | 步骤指示器                              |
| `Tabs`                  | 标签页容器                              |

`overlays`

| 组件                  | 职责                        |
| --------------------- | --------------------------- |
| `AnchoredPopover`     | 锚定浮层                    |
| `CascadingMenu`       | 级联菜单                    |
| `Dialog`              | 模态对话框                  |
| `ImagePreviewDialog`  | 图片预览对话框              |
| `Popover`             | 浮层气泡                    |
| `SettingsPanelDialog` | 设置面板对话框外壳          |
| `Tooltip`             | 悬停提示气泡                |

### product

| 组件                        | 职责                                             |
| --------------------------- | ------------------------------------------------ |
| `AppShell`                  | 应用外壳布局（侧边栏 + 主区）                    |
| `ActionCard` (+ CardKit)    | 对话内统一动作 / 通知卡与零件盒（能力层）        |
| `BusinessSurface`           | 业务浅色表面容器                                 |
| `BusinessDataTable`         | 业务数据表（DataTable 产品级封装）               |
| `CollapsibleNav`            | 可折叠导航侧栏                                   |
| `CompactToolRow`            | 紧凑工具调用行                                   |
| `ToolDisclosureCard`        | 工具披露卡                                       |
| `InteractionSuggestionCard` | 交互建议卡（AI 引导选项）                        |
| `Settings`                  | 设置页版式（分节 + 设置行）                      |
| `TopBarControlFrame`        | 跨产品顶栏控制视觉框架                           |
| `CopyButton` / `DeleteOutlineIconButton` | 复制 / 描边删除 图标动作按钮        |
| `BusinessCascadingMenu`     | 无状态业务级级联菜单组合（Desktop 与 Workbench 共用）|

## Design tokens

色彩体系走**双色种子**（§12.9，权威文档 [`docs/ui-color-seeds.md`](../../docs/ui-color-seeds.md)）：
全产品颜色只有两个可配置种子，其余从种子派生为语义令牌，组件只引语义令牌、禁裸色值。

| 层            | 令牌                                              | 说明                               |
| ------------- | ------------------------------------------------- | ---------------------------------- |
| 种子（可配置） | `--velar-primary` / `--velar-accent`（+ `-rgb`）  | 主题色 + 副色，唯一手设品牌色       |
| 品牌派生       | `--primary` / `--accent` / `--control-*` / `--shell-*` / `--memory-accent-*` | 从双种子 `color-mix` / `rgba` 派生 |
| 固定中性       | `--background*` / `--foreground*` / `--border*`   | 中性墨色，不随品牌种子             |
| 固定状态       | `--status-*`                                      | 语义状态调色板，不随品牌种子       |
| UI base        | `--ui-radius-*` / `--ui-space-*` / `--ui-border-*` / `--ui-shadow-*` / `--ui-font-*` | 布局与 chrome |
| Theme          | `[data-theme="light"]` / `[data-theme="dark"]`    | 主题切换（dark 当前为占位）        |

令牌入口 `styles/tokens/design-tokens.css`（@import `theme-light.css` + `theme-dark.css` +
`seed-presets.css`）。官方预置组合（`velar-indigo` 默认 / `graphite-blue` / `forest-amber` /
`plum-rose` / `slate-teal`）见 `styles/tokens/seed-presets.css`，经 `data-velar-preset` 激活；
用户自定义种子的配置接口形状见 [`docs/ui-color-seeds.md`](../../docs/ui-color-seeds.md)（改文件即生效）。

## CSS naming

Global component classes use the **`.velar-{component}[-{modifier}]`** namespace:

- Block: `.velar-button`
- Variant: `.velar-button-variant-outline`
- Size: `.velar-button-size-sm`

Component library CSS is **pure CSS + design tokens** (no Tailwind `@apply`). Files are marked
`/* @velaros-no-tailwind */`. 组件层 CSS 禁裸 hex/rgb/hsl（arch-guard `velaros/ui-color-literal-closure`
执法）；裸色值只许住令牌层 `styles/tokens/**`。

## Public Imports

- `@velaros-ai/ui` — all components
- Explicit component subpaths such as `@velaros-ai/ui/primitives/buttons/Button` and
  `@velaros-ai/ui/product/layout/AppShell` — every supported path is listed in package exports;
  undeclared source/dist paths are intentionally private.
- `@velaros-ai/ui/product/menus/BusinessCascadingMenu` — Desktop 与 Workbench 共用的无状态产品级菜单组合
- `@velaros-ai/ui/product/layout/TopBarControlFrame` — 两款产品各自组合动作与状态的共享顶栏视觉框架
- `@velaros-ai/ui/hooks/usePointerResize` — Desktop 与 Workbench 共用的无状态拖拽缩放控制器
- `@velaros-ai/ui/lib/cn` — class name helper (clsx only)
- `@velaros-ai/ui/utility-types` — explicit module-only utility types; the package installs no ambient globals
- `@velaros-ai/ui/styles/tokens/design-tokens.css`
- `@velaros-ai/ui/styles/tokens/theme-light.css`
- `@velaros-ai/ui/styles/tokens/theme-dark.css`
- `@velaros-ai/ui/styles/components/index.css`
- `@velaros-ai/ui/styles/components/product.css`

```tsx
import { Button, Stack, ActionCard } from '@velaros-ai/ui'
import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
import '@velaros-ai/ui/styles/components/product.css'
```

## Boundary

This package must not import renderer features, IPC, or app-specific business models. Business UI that is
shared only inside the current Desktop can remain in `src/renderer/src/components/business/`. UI shared by
independent VelarOS products must first be detached from Desktop stores and transport, then promoted into this
versioned component library (or a future product-level package such as `agent-ui`). Desktop and Workbench must
not import each other's pages or feature implementations.

## Backlog

§12.9 存量逃生口收敛（arch-guard baseline 冻结现状、只降不升；分批清）：

1. **ComponentProps 全展开 / className·style 透传**（`velaros/ui-component-form-closure`）。存量以
   ActionCard 家族的 DOM-prop 展开面 + 多 `*ClassName` 槽为首。分批：①先收 product 层富卡
   （ActionCard / CompactToolRow / ToolDisclosureCard）的 `*ClassName` 槽——把外貌覆盖需求下沉到消费方
   本地外貌层，复用能力层零件（CardKit）；②再收 primitives 薄封装的 DOM 全展开，改为按需暴露的
   有限 prop 面；③收尾把 baseline 清零。新组件即刻硬禁（新增即红）。
2. **裸 hex/rgb/hsl 色值**（`velaros/ui-color-literal-closure`）。存量集中在 `styles/components/primitives/*.css`
   与 `utils/filePresentation.ts`（文件类型品牌色）。分批：①把可映射到现有语义令牌的裸色值
   直接替换；②为反复出现的阴影 / 遮罩 rgba 抽语义令牌（如 `--ui-shadow-*` / overlay tint）；
   ③文件类型品牌色抽成一族 `--brand-file-*` 令牌。收敛随 renderer 收割批推进（不在组件正规化批内）。

进度看板对齐 [`docs/debt-census-2026-07.md`](../../docs/debt-census-2026-07.md) 口径（棘轮只降不升）。
