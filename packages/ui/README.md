# @velaros-ai/ui

> **位置**:VelarOS-Platform 单版本火车 · `ui` 域唯一包 · 目录 `packages/ui`。
> 它是**门面包**(kernel-contract §12「门面收口」):对外背 semver,内部原子在门面之内自由演化。
> 装两半——跨产品复用的 **primitives / product 组件库**,以及 host 无关的**会话渲染件**(`./conversation`)。

## 这个包解决什么问题

Desktop 与 Workbench 是两个产品,但用户应该感觉它们是同一个软件。
本包让这件事**在结构上成立**:所有界面零件只有一份实现、一套令牌、一套形态。

关键判决:**库不搞通用,只做统一、可组合**。

每个组件预设**有限形态**(variant 是封闭枚举,全仓共用一套),
**不开 `className` / `style` 逃生口**、**不做 `ComponentProps` 全展开**;
tone 与主题一律走 CSS 变量单源。需要单点特殊外貌 → 在**消费方本地**做外貌层组合,
**禁止回灌组件库**。

理由很直接:一旦开了逃生口,「统一」就变成了建议而不是事实,而建议会在半年内失效。
存量逃生口冻结在 arch-guard baseline,**只降不升**(见 [欠账](#欠账))。

## 对外分区

| 入口 | 一句话职责 |
| --- | --- |
| `@velaros-ai/ui` | 全部稳定组件、Hook 与类型的总入口 |
| `@velaros-ai/ui/primitives/**` | 跨产品复用、**无业务语义**的原子(buttons / display / forms / layout / overlays) |
| `@velaros-ai/ui/product/**` | VelarOS 产品壳层组合件(AppShell / ActionCard + CardKit / 业务表面 / 设置版式 …) |
| `@velaros-ai/ui/conversation` | 会话渲染门面:消息块管线、工具卡族、流式起搏、组合层(见下节) |
| `@velaros-ai/ui/conversation/**` | 会话件的按需子入口(`contracts` / `composer` / `stream` / `tool-render` / `render-slots` / `markdown` / `artifacts` / `html-preview` / `i18n` / `status`) |
| `@velaros-ai/ui/styles/tokens/**` | 设计令牌 CSS(`design-tokens.css` 是入口) |
| `@velaros-ai/ui/styles/components/**` | 组件类 CSS(`index.css` + `product.css`) |
| `@velaros-ai/ui/hooks/usePointerResize` | Desktop 与 Workbench 共用的无状态拖拽缩放控制器 |
| `@velaros-ai/ui/i18n/UiLocalizationProvider` | 窄本地化 Provider |
| `@velaros-ai/ui/lib/cn`、`/lib/styleUtils` | class 合并与样式辅助(纯函数) |
| `@velaros-ai/ui/utility-types` | 显式模块化 utility types——**本包不安装任何 ambient global** |

**只有 `package.json#exports` 里声明的路径属于公共 API**;未声明的 `src` / `dist` 深路径
是**刻意私有**的。组件清单不在本文手工维护——看下面的组件图鉴。

## 组件图鉴(权威清单在这里,不在 README)

```bash
bun run --cwd packages/ui dev          # 启动独立 Vite 组件图鉴
bun run check:ui-component-library     # 重新生成 + 校验图鉴新鲜度与独立性
```

图鉴通过公共 `@velaros-ai/ui` 命名空间导入包源码,支持热更新,并由仓根 `check` 门做生产构建。
组件 API 条目由 `scripts/ui/component-library/generateComponentApi.mjs` **自动生成**
(当前 148 条),所以它不会腐烂——而手写在 README 里的组件表会。

发布产物只含编译后的 `dist` 与文档;组件元数据在本仓生成,消费者既不需要也拿不到源码树。

## 用法

```tsx
import { ActionCard, Button, Stack } from '@velaros-ai/ui'
import '@velaros-ai/ui/styles/tokens/design-tokens.css'
import '@velaros-ai/ui/styles/components/index.css'
import '@velaros-ai/ui/styles/components/product.css'
```

组件的 Props 类型与组件一起导出,按需收窄即可:

```tsx
import { Button, type ButtonProps } from '@velaros-ai/ui'

const SaveButton = (props: Pick<ButtonProps, 'disabled'>) => (
  <Button variant="primary" {...props}>保存</Button>
)
```

## 出版级清单(一个组件「算不算做好了」的判据)

这是**可核对的验收表**,不是口号。新增或改动组件时逐条对;做不到的要在源文件头写明**为什么**
(判据注释)——**不要默默留空**,留空与「刻意不做」长得一样,而这一节存在的目的就是消灭这种歧义。

**A. 形态**(有门 `check:ui-form-closure`)

1. **variant 是封闭枚举**,用 `cva` 表达。可枚举的东西不写 `string`;
   `velar-x-size-${size}` 这类**模板拼接类名会绕过一切静态审计**,别用。
2. **不开 `className` / `style` 逃生口,不做 `ComponentProps` 全展开。**
3. **导出一个 `*Props` 命名的 props 类型**。门只认这个后缀——写成内联对象字面量 props
   等于把自己从门的扫描面里摘出去,那不是合规,是隐身。

**B. 受控形态**

4. 本库取向是**纯受控**:`value` / `checked` 必填 + `onXChange`。选了纯受控就要把
   `defaultValue` / `defaultChecked` **一并 `Omit`**,否则它会经 `{...props}` 漏进底层元素,
   与受控值并存(React 告警 + 行为未定义)。
5. 要做**双模**就三件齐全:`value?` + `defaultValue?` + `onChange?`,且用一个 `isControlled`
   判定统一收口。范本 = `primitives/layout/Disclosure.tsx`。
6. **不许有影子 state**:内部 draft 与外部 value 两个 owner 必然长出 `useEffect` 同步补丁链。
   真需要中间态(输入法、半成品数字)就把「何时提交」写成判决注释。

**C. 可达性**

7. 交互件必须键盘可达:原生 `<button>` / `<input>` 优先;自造浮层 / 菜单 / 选择器要给
   `role` + `aria-expanded` / `aria-haspopup` / `aria-controls`,列表型要 `aria-activedescendant`
   与方向键遍历。**半套 ARIA(有 role 无键盘)比没有更坏**——它对屏幕阅读器承诺了做不到的事。
8. **`aria-hidden` 不许包住可聚焦内容**:那会造出「看得见、能 Tab 到、读不出来」的元素。
9. 纯装饰图标一律 `aria-hidden`;有语义的图标按钮必须有 `label` → `aria-label`。

**D. 身份与性能**

10. **纯展示组件默认 `memo()`**;传给 memo 组件的对象 / 回调要引用稳定,否则 memo 是纯开销。
11. **`memo()` / `forwardRef()` 包出来的组件必须显式挂 `displayName`**。泛型件因 `as` 断言会连
    displayName 一起抹掉,更要补。**不要依赖 Radix 透传的 displayName**——生产构建可能不带。
12. 表单件应转发 `ref`(聚焦、校验定位、表单库注册都要)。**现状缺口最大的一条**:
    `Checkbox` / `Switch` / `Select` / `RadioGroup` / `NumberInput` / `Picker` / `TextSelect` 均未转发。

**E. 样式契约**

13. 样式住 `styles/components/**`,组件只给类名。**组件 CSS 是 pure CSS + design tokens**
    (文件头 `@velaros-no-tailwind`)——**不许在组件里写 Tailwind 工具类**,
    消费方不对 `node_modules` 跑 Tailwind 时那些类根本不存在。
14. 颜色只引语义令牌,**禁裸 hex/rgb/hsl**(有门 `check:ui-color-literal`)。
    间距 / 圆角 / 字号走 `--ui-*` 档位,见 [velaros 简约风格](./docs/velaros-style.md)。
15. 组件写的每个 `velar-*` 修饰类都要**真的有 CSS 规则**(现有 4 条悬空,见欠账)。

**F. 文档与门面**

16. 文件头一句话责任注释 + variant 闭集 + 样式引用。
17. 进 `package.json#exports` 子路径、进组件图鉴。
18. 复杂核心件补导览注释(不变量 / 时序 / 安全门 / 为什么不那样)。**最该补而未补的**:
    `Popover`(坐标系与嵌套层协议)、`CascadingMenu`(三条关闭通道竞态)、
    `DataTable`(三条状态轴的所有权非对称)、`lib/runtime.ts`(为何 fork 而不依赖 core)、
    `lib/timerScope.ts`。

## 设计令牌:双色种子

全产品颜色**只有两个可配置种子**,其余从种子派生为语义令牌;组件只引语义令牌、禁裸色值。

| 层 | 令牌 | 说明 |
| --- | --- | --- |
| 种子(可配置) | `--velar-primary` / `--velar-accent`(+ `-rgb`) | 主题色 + 副色,**唯一手设的品牌色** |
| 品牌派生 | `--primary` / `--accent` / `--control-*` / `--shell-*` / `--memory-accent-*` | 从双种子 `color-mix` / `rgba` 派生 |
| 固定中性 | `--background*` / `--foreground*` / `--border*` | 中性墨色,不随品牌种子 |
| 固定状态 | `--status-*` | 语义状态调色板,不随品牌种子 |
| UI base | `--ui-radius-*` / `--ui-space-*` / `--ui-border-*` / `--ui-shadow-*` / `--ui-font-*` | 布局与 chrome |
| Theme | `[data-theme="light"]` / `[data-theme="dark"]` | 主题切换(dark 当前为占位) |

令牌入口 `styles/tokens/design-tokens.css`,`@import` 顺序为
`foundation.css` + `theme-light.css` + `theme-dark.css` + `seed-presets.css`
——**后者只准覆盖前者**。

`foundation.css` 承载**主题无关地基**(字重 / 字号档 / 容器宽 / 动画 / 绝对中性色),
取值对齐 Tailwind v4 默认主题。它存在的理由是让本包发布的 CSS **自包含**,
不再依赖「消费方恰好装了 Tailwind」(详见该文件头判决)。

官方预置组合(`velar-indigo` 默认 / `graphite-blue` / `forest-amber` / `plum-rose` / `slate-teal`)
在 `styles/tokens/seed-presets.css`,经 `data-velar-preset` 激活。

**怎么用这些令牌**(克制的调色 / 层次靠间距与边框而非阴影 / 圆角与密度档位 / 暗色对称规则)
见 [velaros 简约风格](./docs/velaros-style.md) —— 每条带判据与反例,末尾有自查清单。

## CSS 命名

全局组件类走 **`.velar-{component}[-{modifier}]`** 命名空间:

- 块:`.velar-button`
- 变体:`.velar-button-variant-outline`
- 尺寸:`.velar-button-size-sm`

组件层 CSS 是 pure CSS + design tokens(**无 Tailwind `@apply`**),文件标 `/* @velaros-no-tailwind */`。
组件层禁裸 hex/rgb/hsl(arch-guard `velaros/ui-color-literal-closure` 执法);
**裸色值只许住令牌层 `styles/tokens/**`**。

## 边界:本包不负责什么

组件**只拥有自身交互状态**,不读 Electron IPC、路由、业务 Store、Kernel 或任何宿主单例
——所以它同样能跑在普通 Web 应用、Electron、WebView 与独立组件预览里。

- **不拥有**聊天协议、Agent 状态、数据持久化、业务流程、导航。
- 带 `product` 名字的组件**仍然只是有明确视觉语义的组合件**,不含 VelarOS Desktop 数据模型。
- 仓库门**拒绝**直接 import Kernel / Desktop / Workbench / HTML Artifacts。
- 只在当前 Desktop 内共享的业务 UI 留在 Desktop 自己的 `components/business/`;
  要被多个独立产品共用,**必须先从 Desktop 的 store 与传输里摘干净**,才能升格进本库。
- **Desktop 与 Workbench 不许互相 import 页面或功能实现。**

注入方式:文案经 `UiLocalizationProvider`,行为经 `onClick` / `onChange` / `onOpenChange` 回调,
主题经 CSS 自定义属性与 `data-theme` / `data-velar-preset`,内容与操作区经明确的 React 节点槽位。

## 与相邻包的关系

- 上游:React 19(peer)、Radix 原语、`@phosphor-icons/react`、`streamdown`(会话 markdown)、
  以及 `@velaros-ai/html-artifacts`(会话件的 HTML 预览)。
- **不依赖任何其他 VelarOS 运行时包**(Kernel / Agent / Model / Memory / Workspace / Browser 全不依赖)。
- 消费方:VelarOS-Desktop 与 VelarOS-Workbench。

## 欠账

存量冻结在 arch-guard baseline,**棘轮只降不升**;分批清。

1. **`ComponentProps` 全展开 / `className`·`style` 透传**(`velaros/ui-component-form-closure`,
   基线 **114** 条:passthrough 48 / dom-spread 62 / classname-helper 4)。
   存量以 ActionCard 家族的 DOM-prop 展开面 + 多 `*ClassName` 槽为首。
   分批:① 先收 product 层富卡(ActionCard / CompactToolRow / ToolDisclosureCard)的 `*ClassName` 槽,
   把外貌覆盖需求下沉到消费方本地外貌层、复用能力层零件(CardKit);
   ② 再收 primitives 薄封装的 DOM 全展开,改为按需暴露的有限 prop 面;③ 收尾清零。
   **新组件即刻硬禁(新增即红)。**
2. **裸 hex/rgb/hsl 色值**(`velaros/ui-color-literal-closure`,基线 **387** 条)。
   集中在 `styles/components/primitives/*.css` 与 `utils/filePresentation.ts`(文件类型品牌色)。
   分批:① 可映射到现有语义令牌的直接替换;② 为反复出现的阴影 / 遮罩 rgba 抽语义令牌;
   ③ 文件类型品牌色抽成一族 `--brand-file-*`。
3. **门覆盖面缺口**:`react-hooks/exhaustive-deps` 已铺到本包(warn + 棘轮 `check:ui-hook-deps`,
   存量 15 条 / 11 文件冻结在 `baselines/ui/react-hook-deps.json`)。
   **仍缺**:code-standard 的 `velaros/code-style/*` 里有一批在本包**一条都不跑**
   ——根因是那批 check 住 Desktop 私有插件,不是纪律松。
   全仓逐包数字与三条出路见 [`docs/gate-coverage-matrix.md`](../../docs/gate-coverage-matrix.md) §3。
4. **悬空 `velar-*` 类名 4 条**(TSX 里写了、CSS 全仓无定义):
   `velar-calendar-nav-button-{next,previous}`、`velar-number-input-step-down`、
   `velar-switch-tone-default`。**无门覆盖**;建议加一条「类名 ↔ CSS 规则」的构造级探针。
5. **孤儿样式**:`styles/components/primitives/transient-popup.css` 被 `index.css` `@import`,
   但两仓源码零引用其类名。

## 兼容策略

根入口与显式子路径遵循语义化版本。新增组件可向后兼容发布;
**删除入口、修改 Props 语义或设计令牌含义需要主版本**。未导出的源码文件可以在不承诺兼容的情况下调整。
