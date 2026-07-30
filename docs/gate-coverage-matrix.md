# 门覆盖矩阵(包 × 门族)

> **什么时候该读它**:①想知道「我改的这个包,到底有哪些门在管着我」;②要给某个包补门之前——
> 先看这里有没有别的包已经在跑同一条判据;③怀疑「这条规则我们不是有门吗,怎么没拦住」时。
>
> **一句话结论**:Platform 的 eslint 面在 2026-07-30 之后已与 Desktop 对齐(见 §1),
> 但 **Desktop 的 44 条 `velaros/code-style/*`(arch-guard)在本仓一个包都不跑**(见 §3),
> 实测存量 1122 条违规。这不是纪律松,是门没铺过来。
>
> 数据全部**实测得来**,不是读配置推断:eslint 面用 `ESLint#calculateConfigForFile` 取每个包的
> 生效规则表;arch-guard 面用 Desktop 的插件按 `rootDir` 指向本仓逐包跑 `--no-baseline`。
> 复算方法见 §5。

---

## 1. eslint 面(实测生效规则条数)

尺子 = Desktop `apps/desktop/src` 的 **104 条**生效规则(severity ≠ off)。

| 包 | 本批前 | 本批后 | 与 Desktop 的差 |
| --- | ---: | ---: | --- |
| `agent` | 102 | 102 | 只差 react-hooks 两条(无 React,不适用) |
| `browser` | 102 | 102 | 同上 |
| `computer` | 102 | 102 | 同上 |
| `core` | 102 | 102 | 同上 |
| `game` | 102 | 102 | 同上 |
| `kernel-client` | 102 | 102 | 同上 |
| `kernel-serve` | 102 | 102 | 同上 |
| `capabilities/cli` | 102 | 102 | 同上 |
| `capabilities/office-tools` | 102 | 102 | 同上 |
| `capabilities/system-tools` | 102 | 102 | 同上 |
| `capabilities/workspace` | 102 | 102 | 同上 |
| `ui` | 103 | **104** | 已补 `react-hooks/exhaustive-deps`;齐平 |
| `memory` | **78** | **102** | 曾缺 28 条,已补齐 |
| `model` | **78** | **116** | 曾缺 44 条,已补齐(另有源仓自带的 tsPlugin recommended 18 条) |
| `html-artifacts` | **0** | **101** | 曾整包在根 `ignores` 里,一条规则不跑;已立域配置 |

**曾经的缺口清单(留档,便于判断历史代码为什么长那样)**

- `memory` 少的 28 条:`velaros-style/*` 两条、`@typescript-eslint/*` 八条
  (`no-floating-promises` / `return-await` / `unified-signatures` / `no-empty-object-type` …)、
  `no-lonely-if`、`prefer-template`、`one-var`、`prefer-object-spread`、`no-useless-*` 三条、
  `unicorn/*` 五条、`unused-imports/no-unused-vars`、`no-restricted-imports`。
- `model` 少的 44 条:整个 `unicorn` 族、`simple-import-sort` 族、`velaros-style` 族、
  `eslint-comments` 族,外加 `no-console` / `prefer-const` / `no-var` / `object-shorthand` /
  `eqeqeq` / `arrow-body-style` 等基础条目。
- `html-artifacts`:全部 104 条。

**根因**:并仓时八个源仓的 eslint 配置**原样**搬进 `eslint/<domain>.config.mjs`,公共规则集因此被
复制了七份;其中两份本来就是子集,没人看得出差异。现已抽出 `eslint/_shared.config.mjs` 作单一
权威源,`memory` / `model` / `html-artifacts` 三域引用它。
**欠账**:`agent` / `capabilities` / `core` / `kernel` / `ui` 五域仍各持一份副本
(前四份 `commonRules` 的 md5 与基座逐字相同,`ui` 只差 import 分组一处),迁移是纯机械动作。

---

## 2. `check:*` 域门面(谁在跑什么)

`bun run check` = `build` → `typecheck` → `lint` → `test` → `test:suites` → `check:gates`。
下表是 `check:gates` 的构成(**根 `package.json` 是唯一挂链处;不在这张表里的门等于没有门**)。

| 域 / 包 | 门 | 管什么 | 基线 |
| --- | --- | --- | --- |
| kernel | `check:kernel-schemas` | wire schema 快照 | `baselines/kernel/kernel-wire-schema-snapshot.json` |
| kernel | `check:kernel-arch` | 依赖方向 / 包集合冻结 | `baselines/kernel/arch-boundaries-baseline.json` |
| core | `check:core-semantic-vocabulary` | 语义词汇墙(内核不得认识域词) | — |
| agent | `check:agent-schemas` | 工具 schema 快照 | — |
| agent | `check:agent-arch` | 依赖方向 / 包集合冻结 | `baselines/agent/arch-boundaries-baseline.json` |
| capabilities | `check:capabilities-schemas` | 能力包 schema 快照 | `baselines/capabilities/browser-input-schemas.json` |
| capabilities | `check:capabilities-arch` | 包集合冻结 + owners 表(**含 browser / computer / game / cli / office-tools / system-tools / workspace 七包**) | — |
| model | `check:model-arch` | 依赖方向 | — |
| memory | `check:memory-boundaries` | 产品边界棘轮(kernel 对 memory 零 import) | — |
| memory | `check:memory-knowledge-profile` | knowledge profile 集成 | — |
| memory | `probe:memory` | 11 个运行时探针(storage / authority / tree-store / dream / erasure / replay / query / files / vector / capability) | — |
| ui | `check:ui-form-closure` | §12.9 组件形态封闭(逃生口只降不升) | `baselines/ui/ui-component-form-closure-baseline.json` |
| ui | `check:ui-color-literal` | §12.9 双色种子(组件层禁裸色值) | `baselines/ui/ui-color-literal-closure-baseline.json` |
| ui | `check:ui-hook-deps` | `react-hooks/exhaustive-deps` 棘轮 + `--quiet` 吞噬护栏 | `baselines/ui/react-hook-deps.json` |
| ui | `check:ui-package-contracts` | 包导出契约 | — |
| ui | `check:ui-component-library` | 图鉴生成物新鲜度 / 独立性 | — |
| **html-artifacts** | **无** | 包内有 `check` / `check:dist` / `check:package-contract`,**没挂进根链** | — |
| **workspace** | **无** | 包内有 `check` / `check:arch`(118 行),**没挂进根链** | — |
| **game** | 只被 `check:capabilities-arch` 的包集合冻结覆盖 | 无自己的 schema / 架构门 | — |

> **缺口 A**:`html-artifacts` 与 `capabilities/workspace` 各自带着**已经写好**的检查脚本,但两者都
> 只在包内 `check` 脚本里,根 `check:gates` 不跑它们——CI 与 `bun run check` 都碰不到。
> 这是「门写了但没挂链」的典型,处置成本极低(两行脚本),留给后续批次。

---

## 3. arch-guard `velaros/code-style/*` —— 全仓零覆盖(最大缺口)

Desktop 侧有 **44 条** `velaros/code-style/*` 检查(缺席值八条族、`forbid-swallowed-errors`、
`forbid-trivial-function-wrapper`、`require-chinese-comments`、`prefer-is-plain-object-*`、
`forbid-raw-timers`、`forbid-console` …),由 `bun run check:architecture` 执行。
**Platform 一个包都不跑**(本仓没有 `arch-guard.config.mjs`,也没有 `.arch-guard/`)。

### 3.1 实测存量(把 Desktop 的插件按 `rootDir` 指向本仓逐包跑,`--no-baseline`)

| 包 | 总违规 | error | warning | 失败检查数 |
| --- | ---: | ---: | ---: | ---: |
| `core` | 233 | 161 | 71 | 11 |
| `memory` | 163 | 127 | 36 | 2 |
| `ui` | 145 | 122 | 21 | 21 |
| `capabilities/system-tools` | 123 | 114 | 9 | 1 |
| `agent` | 116 | 11 | 105 | 1 |
| `kernel-serve` | 63 | 5 | 58 | 2 |
| `game` | 55 | 48 | 7 | 2 |
| `html-artifacts` | 52 | 30 | 22 | 1 |
| `browser` | 38 | 9 | 29 | 1 |
| `computer` | 38 | 4 | 34 | 1 |
| `capabilities/workspace` | 25 | 3 | 22 | 1 |
| `kernel-client` | 24 | 1 | 23 | 1 |
| `model` | 24 | 0 | 24 | 0 |
| `capabilities/office-tools` | 18 | 11 | 7 | 1 |
| `capabilities/cli` | 5 | 0 | 5 | 0 |
| **合计** | **1122** | **646** | **473** | 24/44 条检查命中 |

按检查聚合(命中数 ≥ 10 的):

| 命中 | 检查 |
| ---: | --- |
| 472 | `require-chinese-comments` |
| 377 | `prefer-loose-optional` |
| 69 | `forbid-redundant-strict-literal-comparison` |
| 36 | `forbid-raw-runtime-type-guards` |
| 35 | `prefer-emptiness-helpers` |
| 28 | `forbid-explicit-undefined-union` |
| 20 | `forbid-nullish-churn` |
| 17 | `require-error-logging` |
| 16 | `prefer-is-plain-object-over-guarded-record-cast` |
| 13 | `forbid-console` |

> `ui` 的「21 条检查失败」是全仓最高——不是 ui 纪律最差,是它的代码形态(React + 大量缺席值分支)
> 最贴这批规则的靶面。反过来 `model` / `capabilities/cli` 零 error,只有 warning 级命中。

### 3.2 为什么本仓跑不了(结构性阻塞,需要裁决)

这 44 条住 Desktop 的 `packages/arch-guard-velaros`——`private: true`、**从未发布**,而且
Desktop `docs/package-extraction-map.md` 明确把它登记为「**Desktop 自持**」。
引擎 `@velaros-ai/arch-guard` 是公开 GitHub 包(本仓可以直接依赖),**插件不是**。
于是只有三条出路,都需要人拍板:

1. **把 `arch-guard-velaros` 的 `checks/code-style/` 劈出来发成公共包**
   (如 `@velaros-ai/code-style-checks`),两仓共同依赖。判据单源,成本最高但唯一干净。
2. **整包发布 `@velaros/arch-guard-velaros`**(GH Packages)。最省事,但会把 Desktop 专属的
   架构 / legacy 检查(含 `apps/desktop/src` 硬编码路径)一起带进 Platform 的依赖面。
3. **推翻 extraction-map 的「Desktop 自持」判决**,把插件整体迁进 Platform。

**不要做的**:把 44 条 check 复制一份进 Platform——判据立刻双源,漂移是时间问题。
**也不要做的**:做成「sibling 检出在就跑、不在就跳过」的 best-effort 探针——那正是
「没挂链的门等于没有门,还多骗一层安全感」。

> 铺法建议(裁决之后):arch-guard 自带 `.arch-guard/baseline.json` 棘轮,1122 条存量一次冻结,
> 新增即红;`require-chinese-comments` 需要单独议——Platform 是对外发布的库,英文注释与英文
> README 是有意为之,这条在本仓的判据可能与 Desktop 不同。

---

## 4. 已知的门口径盲区(判据上是违规,机械上看不见)

已修的两条留档,形态可作为后续补门的模板:

| 门 | 曾经的盲区 | 修法 |
| --- | --- | --- |
| `check:ui-color-literal` | CSS 面只有 `styles/components/**`,`*.module.css`(8 文件 73 条)与 html-preview 沙箱样式表(60 条)完全隐形;同时把**构建产物** `*.generated.ts` 的 60 条钉进人工基线,重新生成即红 | 面改「全部 `packages/ui/src/**.css` 减令牌层」;`*.generated.*` 一律豁免,只记账其源文件。基线 314 → 387 |
| `check:ui-form-closure` | 只认「名字以 `Props` 结尾的声明」,漏三类等价写法:内联对象字面量 props、`Pick<X,'className'>` / `Omit<DOM,…> & {className?}` 转发、导出的 `getXxxClassName` 拼接函数 | 契约面扩为「`*Props` 声明 ∪ 全部参数类型标注 ∪ 导出的 `*ClassName` 函数」。基线 99 → 114 |

**通用教训**:补门时先问「同一条判据的等价写法有几种」,再问「扫描面盖住几种」。
差集就是盲区,而盲区里的代码会长成"合规"的样子。

**仍未有门覆盖的已知项**(来自 `packages/ui/README.md` §Backlog):
悬空 `velar-*` 类名 4 条(TSX 写了、CSS 全仓无定义)、孤儿样式表 `transient-popup.css`。

---

## 5. 怎么复算这张表

**eslint 面**——对每个包的一个源文件取生效规则表:

```js
import { ESLint } from 'eslint'
const eslint = new ESLint({ cwd: repoRoot })
const cfg = await eslint.calculateConfigForFile('packages/<pkg>/src/<any>.ts')
Object.entries(cfg.rules).filter(([, v]) => (Array.isArray(v) ? v[0] : v) !== 'off').length
```

同样的脚本在 Desktop 仓对 `apps/desktop/src/**` 跑一次,得到尺子。

**arch-guard 面**——需要 Desktop 检出在旁(仅用于**测量**,不是可挂链的门):
写一个临时 config,`rootDir` 指向 Platform,`plugins` 只装 `velarosCodeStyleChecks`,然后
`arch-guard verify --config <临时config> --no-baseline`,逐包换 `files.roots`。

---

## 变更记录

- 2026-07-30 QH 批:首次实测建表;补 `ui` 的 `exhaustive-deps`、`memory` / `model` /
  `html-artifacts` 三域规则集;修两条门口径盲区。arch-guard 缺口待裁决。
