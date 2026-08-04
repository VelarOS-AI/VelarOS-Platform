# 门覆盖矩阵(包 × 门族)

> **什么时候该读它**:①想知道「我改的这个包,到底有哪些门在管着我」;②要给某个包补门之前——
> 先看这里有没有别的包已经在跑同一条判据;③怀疑「这条规则我们不是有门吗,怎么没拦住」时。
>
> **一句话结论**:Platform 的 eslint 面已与 Desktop 对齐(见 §1);arch-guard 写法门也已铺过来
> ——**QI 批(2026-07-30)劈包完成**,37 条语言级 `code-style/*` 由公开包
> `@velaros-ai/arch-guard/checks/code-style` 提供,两仓共依同一份判据,本仓门名
> `check:code-style`,存量 1915 条冻结进 `.arch-guard/baseline.json`,新增即红(见 §3)。
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
| `kernel` | 102 | 102 | 同上 |
| `cli` | 102 | 102 | 同上 |
| `office` | 102 | 102 | 同上 |
| `system` | 102 | 102 | 同上 |
| `project` | 102 | 102 | 同上 |
| `development` | 102 | 102 | 同上 |
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
| capabilities | `check:capabilities-arch` | 包集合冻结 + owners 表（browser / computer / game / cli / office / system / project / development 八包） | — |
| model | `check:model-arch` | 依赖方向 | — |
| memory | `check:memory-boundaries` | 产品边界棘轮(kernel 对 memory 零 import) | — |
| memory | `check:memory-knowledge-profile` | knowledge profile 集成 | — |
| memory | `probe:memory` | 11 个运行时探针(storage / authority / tree-store / dream / erasure / replay / query / files / vector / capability) | — |
| ui | `check:ui-form-closure` | §12.9 组件形态封闭(逃生口只降不升) | `baselines/ui/ui-component-form-closure-baseline.json` |
| ui | `check:ui-color-literal` | §12.9 双色种子(组件层禁裸色值) | `baselines/ui/ui-color-literal-closure-baseline.json` |
| ui | `check:ui-hook-deps` | `react-hooks/exhaustive-deps` 棘轮 + `--quiet` 吞噬护栏 | `baselines/ui/react-hook-deps.json` |
| ui | `check:ui-package-contracts` | 包导出契约 | — |
| ui | `check:ui-component-library` | 图鉴生成物新鲜度 / 独立性 | — |
| 全仓 | `check:code-style` | 语言级写法门(公开包 37 条,见 §3) | `.arch-guard/baseline.json`(1915 条) |
| html-artifacts | `check:html-artifacts-package` | 包导出契约 + dist 产物(QI 批挂链) | — |
| project | `check:project-arch` | 单包形态 + host/capability 边界 | — |
| **game** | 只被 `check:capabilities-arch` 的包集合冻结覆盖 | 无自己的 schema / 架构门 | — |

> **缺口 A 已闭合**(QI 批 2026-07-30):`html-artifacts` 的 `check:package-contract` + `check:dist`
> 与 `project` 的 `check:arch` 已分别包成 `check:html-artifacts-package` /
> `check:project-arch` 挂进根 `check:gates`。教训留档:**门写了但没挂链等于没有门,还多骗一层
> 安全感**——新写检查脚本时同一批就要挂链。

---

## 3. arch-guard 写法门 —— 已接门(QI 批 2026-07-30)

**门**:`bun run check:code-style`(= `arch-guard verify`,已挂进根 `check:gates`)。
配置 `arch-guard.config.mjs`,基线 `.arch-guard/baseline.json`,逐条看用 `check:code-style:report`,
收缩基线用 `check:code-style:baseline`。

### 3.1 判据从哪来(单源)

Desktop 原有的 44 条 `velaros/code-style/*` 已按判据分家:

| 族 | 条数 | 住在哪 | 谁在跑 |
| --- | ---: | --- | --- |
| **语言级通用**(缺席值表达 / 守卫单源 / 早返 / 表驱动 / 恒等转发 / 冗余严格比较 / 吞错 / React 条件渲染 / 注释团队语言…) | **37** | 公开包 `@velaros-ai/arch-guard/checks/code-style`,id `code-style/*` | **两仓**(Desktop 经私有插件、本仓经 `arch-guard.config.mjs` 直装) |
| **产品专属**(前后端强转分层 / unknown JSON 单源 / 注入式全局 / i18n 文案 / 桌面入口 extensions / `AppError` 具体类型 / `ToolContext` 能力面) | 7 | Desktop 私有插件,id 仍 `velaros/code-style/*` | 只有 Desktop |

规则本体**不硬编码任何仓库坐标**——扫描面(`scanRoots` / `runtimeRoots` / `frontendRoots` /
`skipPatterns` / `allowFiles`)由 `createCodeStyleDefaults()` 从本仓配置一处注入。改判据只改公开包,
**两仓都不许留副本**。

### 3.2 接门当天的存量(冻结基线)

`arch-guard verify --no-baseline` 实测:**1915 条**(1805 error / 87 warning / 23 info),24/37 条检查命中。
按检查聚合(≥ 20 条):

| 命中 | 检查 |
| ---: | --- |
| 420 | `code-style/forbid-redundant-strict-literal-comparison` |
| 380 | `code-style/prefer-loose-optional` |
| 255 | `code-style/forbid-raw-runtime-type-guards` |
| 178 | `code-style/prefer-emptiness-helpers` |
| 136 | `code-style/forbid-explicit-undefined-union` |
| 115 | `code-style/forbid-nullish-churn` |
| 84 | `code-style/require-chinese-comments` |
| 82 | `code-style/require-error-logging` |
| 67 | `code-style/prefer-is-plain-object-over-guarded-record-cast` |
| 44 | `code-style/forbid-swallowed-errors` |
| 26 | `code-style/prefer-is-plain-object-over-object-array-guard` |
| 23 | `code-style/prefer-table-branching` |
| 20 | `code-style/forbid-raw-timers` |

> **与 QH 批 1122 条的差异**:QH 用 Desktop 插件测量,那套规则被 Desktop 的 `RuntimeSourceRoots`
> 硬编码收窄,`packages/capabilities/**` 等根本没进扫描面;现在坐标由本仓声明(`runtimeRoots:
> ['packages/']`),覆盖面变全,数字随之上升。**同一批代码,量的是更大的面。**
> 另一处反向差异:`require-chinese-comments` 从 472 降到 84——公开 API JSDoc 分档豁免
> (见下)把「写给外部消费者的英文 API 文档」从违规里摘了出去。

### 3.3 `require-chinese-comments` 的分档(主控裁决)

- **`src/**` 实现代码注释仍须中文**(团队语言判据与「发布给谁」无关);
- **豁免面**:挂在**导出声明及其成员**上的 `/** */` JSDoc 块(那是外部 mod / 包消费者读的 API 文档,
  英文合理),由规则的 `exemptExportedJsDoc` 选项实现、默认开;README / docs / CHANGELOG 本来就在
  扫描面外(门只扫 `.ts/.tsx`);
- **本仓 severity 钉 error**(默认 warning 拦不住新增),存量 84 条冻结,**新增即红**。

### 3.4 扫描面与豁免(改门前必读)

- `files.roots = ['packages']`,`extensions = ['.ts','.tsx']`;`dist` / `test` / `tests` /
  `__tests__` / `examples` / `scripts` / `probes` / 生成物 / `*.d.ts` 全在面外。
- `frontendRoots = ['packages/ui/src/','packages/html-artifacts/src/']`:JSX 类规则只扫这两处。
- 守卫 / 缺席值 helper 的**实现本体**(`core/src/typeGuards.ts`、`core/src/logger/`、
  `utils/optionalWhen.ts`、`utils/mapDefined.ts`)不能套用自身 autofix,已在 `skipPatterns` 豁免;
  `core/src/utils/TimerScope.ts` 在 `forbid-raw-timers` 的 `allowFiles` 里。
- **负向自检**(接门时做过):在 `packages/core/src` 注入一条新违规 → `check:code-style` FAIL;
  删掉 → PASS。基线不会替新增违规背书。

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
- 2026-07-30 QI 批:arch-guard 缺口按「劈公共包」出路闭合——37 条语言级规则进
  `@velaros-ai/arch-guard/checks/code-style`(两仓共依、判据单源),本仓立 `check:code-style`
  并冻结 1915 条存量;`require-chinese-comments` 分档(公开 API JSDoc 豁免)并钉 error;
  §2 缺口 A 的两个包内检查挂进根 `check:gates`。
