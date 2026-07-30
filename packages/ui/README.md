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

## 出版级清单（一个组件"算不算做好了"的判据）

这一节是**可核对的验收表**，不是口号。新增或改动组件时逐条对；做不到的要在源文件头写明**为什么**
（判据注释，§5.3），不要默默留空——留空与"刻意不做"长得一样，这正是本节要消灭的歧义。

**A. 形态（有门，`check:ui-form-closure`）**

1. **variant 是封闭枚举**，用 `cva` 表达（现状 36/59 primitives 走 cva）。可枚举的东西不写
   `string`；`velar-x-size-${size}` 这类**模板拼接类名绕过一切静态审计**，别用。
2. **不开 `className` / `style` 逃生口，不做 `ComponentProps` 全展开**。需要单点特殊外貌 →
   消费方本地外貌层组合，**禁回灌组件库**。存量 99 条冻结在 baseline，只降不升。
3. **导出一个 `*Props` 命名的 props 类型**。门只认这个后缀——写成内联对象字面量 props 的组件
   （如 CardKit 六件）等于把自己从门的扫描面里摘出去，那不是合规，是隐身。

**B. 受控形态**

4. 本库取向是**纯受控**：`value`/`checked` 必填 + `onXChange`。选了纯受控就要把
   `defaultValue`/`defaultChecked` **一并 `Omit`**，否则它会经 `{...props}` 漏进底层元素，
   与受控值并存（React 告警 + 行为未定义）。
5. 要做**双模**（受控 + 非受控）就三件齐全：`value?` + `defaultValue?` + `onChange?`，且用一个
   `isControlled` 判定统一收口。范本 = `primitives/layout/Disclosure.tsx`。
6. **不许有影子 state**：内部 draft 与外部 value 两个 owner 必然长出 `useEffect` 同步补丁链
   （§4.2）。真需要中间态（输入法、半成品数字）就把"何时提交"写成判决注释。

**C. 可达性**

7. 交互件必须键盘可达：原生 `<button>`/`<input>` 优先；自造的浮层/菜单/选择器要给
   `role` + `aria-expanded`/`aria-haspopup`/`aria-controls`，列表型要 `aria-activedescendant`
   与方向键遍历。**半套 ARIA（有 role 无键盘）比没有更坏**——它对屏幕阅读器承诺了做不到的事。
8. **`aria-hidden` 不许包住可聚焦内容**：那会造出"看得见、能 Tab 到、读不出来"的元素。
9. 纯装饰图标一律 `aria-hidden`；有语义的图标按钮必须有 `label` → `aria-label`。

**D. 身份与性能**

10. **纯展示组件默认 `memo()`**；传给 memo 组件的对象/回调要引用稳定，否则 memo 是纯开销。
11. **`memo()` / `forwardRef()` 包出来的组件必须显式挂 `displayName`**：包装后 devtools 里是匿名的。
    泛型件因 `as` 断言会连 displayName 一起抹掉，更要补（见 `List` / `Select` / `SegmentedControl`）。
    **不要依赖 Radix 透传的 displayName**——生产构建可能不带，devtools 会显示 `Anonymous`。
12. 表单件应转发 `ref`（聚焦、校验定位、表单库注册都要）。**现状缺口最大的一条**：
    `Checkbox`/`Switch`/`Select`/`RadioGroup`/`NumberInput`/`Picker`/`TextSelect` 均未转发。

**E. 样式契约**

13. 样式住 `styles/components/**`，组件只给类名。**组件 CSS 是 pure CSS + design tokens**
    （文件头 `@velaros-no-tailwind`）——**不许在组件里写 Tailwind 工具类**，消费方不对
    `node_modules` 跑 Tailwind 时那些类根本不存在。
14. 颜色只引语义令牌，禁裸 hex/rgb/hsl（有门 `check:ui-color-literal`）。间距/圆角/字号走
    `--ui-*` 档位，见 [velaros 简约风格](./docs/velaros-style.zh-CN.md)。
15. 组件写的每个 `velar-*` 修饰类都要**真的有 CSS 规则**。（**已知欠账 4 条**：
    `velar-calendar-nav-button-{next,previous}`、`velar-number-input-step-down`、
    `velar-switch-tone-default` —— 类名在 TSX 里，CSS 全仓无定义。无门覆盖，见 Backlog。）

**F. 文档与门面**

16. 文件头一句话责任注释 + variant 闭集 + 样式引用（现状 primitives 58/59、product 19/19）。
17. 进 `package.json#exports` 子路径（现状 77/77 齐）、进本文组件索引表、进 component-library 图鉴。
18. 复杂核心件补 §5.3b 导览（不变量 / 时序 / 安全门 / 为什么不那样）。**本库最该补而未补的**：
    `Popover`（坐标系与嵌套层协议）、`CascadingMenu`（三条关闭通道竞态）、`DataTable`
    （三条状态轴的所有权非对称）、`lib/runtime.ts`（为何 fork 而不依赖 core）、`lib/timerScope.ts`。

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
| `MarqueeText`  | 溢出时横向滚动的单行文本                 |
| `Paragraph`    | 正文段落文本                            |
| `Progress`     | 线性进度条                              |
| `RenderErrorBoundary` | 渲染错误边界（坏一格降级一格，不拖垮整页）|
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
| `Settings`（Section/Card/Row） | 设置页版式（分节 + 设置卡 + 设置行）          |
| `SessionStickyDock`         | 会话内吸顶停靠条                                 |
| `ChatInteractionNotice`     | 对话内交互提示条（tone 三档）                    |
| `WorkspaceSpaceIcon` / `WorkspaceSpaceStatusIcon` | 空间图标 / 空间状态图标        |
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

**怎么用这些令牌**（克制的调色 / 层次靠间距与边框而非阴影 / 圆角与密度档位 / 暗色对称规则）
见 [velaros 简约风格](./docs/velaros-style.zh-CN.md) —— 每条带判据与反例，末尾有自查清单。

令牌入口 `styles/tokens/design-tokens.css`（@import `foundation.css` + `theme-light.css` +
`theme-dark.css` + `seed-presets.css`；后者只准覆盖前者）。`foundation.css` 承载**主题无关地基**
（字重 / 字号档 / 容器宽 / 动画 / 绝对中性色），取值对齐 Tailwind v4 默认主题——它的存在是为了
让本包发布的 CSS **自包含**，不再依赖消费方恰好装了 Tailwind（详见该文件头判决）。官方预置组合（`velar-indigo` 默认 / `graphite-blue` / `forest-amber` /
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

3. **门覆盖面缺口**（QU 深读实测发现，QH 批处置）：
   - ✅ **已补**：`react-hooks/exhaustive-deps` 已铺到本包（warn + 基线棘轮
     `check:ui-hook-deps`，存量 15 条 / 11 文件冻结在 `baselines/ui/react-hook-deps.json`）。
   - ⏳ **仍缺（结构性阻塞，需人拍板）**：code-standard 附录 A 那 44 条 `velaros/code-style/*`
     （缺席值八条族、`forbid-swallowed-errors`、`forbid-trivial-function-wrapper`、
     `require-chinese-comments`、`prefer-is-plain-object-*` …）在本包**一条都不跑**——
     实测本包存量 145 条违规 / 21 条检查失败（全 Platform 最高的失败检查数）。
     根因是这批 check 住 Desktop 的 `arch-guard-velaros`（private、未发布、extraction-map
     登记为「Desktop 自持」），不是纪律松。三条出路与全仓逐包数字见
     [`docs/gate-coverage-matrix.md`](../../docs/gate-coverage-matrix.md) §3。
4. ✅ **门口径盲区已修**（QH 批，两条；基线按新口径重算，不是违规增加）：
   ① `check:ui-color-literal` 的 CSS 面从 `styles/components/**` 扩为「全部 `src/**.css` 减令牌层」
   （补进 `*.module.css` 8 文件 73 条 + html-preview 沙箱样式表 60 条），并豁免 `*.generated.*`
   构建产物（旧基线里那 60 条产物指纹已移除，改记账其源 CSS）。基线 314 → **387**。
   ② `check:ui-form-closure` 的契约面从「名字以 `Props` 结尾的声明」扩为
   「`*Props` 声明 ∪ 全部参数类型标注 ∪ 导出的 `*ClassName` 函数」，补进内联对象字面量 props、
   `Pick<X,'className'>` / `Omit<DOM,…> & {className?}` 转发、`getXxxClassName` 拼接函数。
   基线 99 → **114**（passthrough 48 / dom-spread 62 / classname-helper 4）。
5. **悬空 `velar-*` 类名 4 条**（TSX 里写了、CSS 全仓无定义）：
   `velar-calendar-nav-button-{next,previous}`、`velar-number-input-step-down`、
   `velar-switch-tone-default`。无门覆盖；建议加一条"类名↔CSS 规则"的构造级探针。
6. **孤儿样式**：`styles/components/primitives/transient-popup.css` 被 `index.css` @import，
   但两仓源码零引用其类名。

进度看板对齐 [`docs/debt-census-2026-07.md`](../../docs/debt-census-2026-07.md) 口径（棘轮只降不升）。
