# VelarOS-Platform 文档索引

> **本页是本仓 docs 的唯一可信入口**:每行给一句「什么时候该读它」。不在索引里的文档 = 没人找得到。
> 仓本身是什么、18 个包在哪、门怎么跑,看 [../README.md](../README.md)。

> **三条阅读纪律**
> ① **判决源不在本仓**。架构裁决住 VelarOS-Desktop 仓的 `docs/kernel-contract.md` 与
>    `docs/mod-architecture-blueprint.md`;本仓 docs 绝大多数是**参考手册与落地地图**,
>    与判决源冲突时改本仓、不改判决源。唯一例外见 §二末尾的 `memory-tree-spec-freeze.md`。
> ② **活文档必须与代码同步修实;历史档不修实**——§六登记的文档记的是当时的事实,改掉等于伪造历史。
> ③ **「契约已定」≠「能用了」**。mod-dev 套件对未实装的部分一律标注「契约已定,实装批次 X」,
>    axes 各页另有「Desktop 接线状态」一行,读之前先看那行。

> **2026-07-30 全仓实况**(读任何路径前先记住这三条)
> 1. **平台侧七仓已并入本仓**(Kernel / Agent / Core / Capabilities / Model / Memory / UI)。
>    `../VelarOS-Kernel` 一类 sibling 路径**已不在磁盘上**,取证路径见 README「源仓考古指引」。
> 2. **并仓时合包改名**:`agent-runtime`→`agent`、`browser-*`→`browser/*`、`model-runtime`→`model`、
>    `knowledge`→`memory/knowledge`、`conversation-ui`→`ui/conversation`。全表在 Desktop 仓
>    `docs/ecosystem-repo-topology.md` §2。
> 3. **`docs/<域>/` 只剩三个目录**:`agent/` `memory/` `mod-dev/`。其余域没有本仓侧文档
>    (并仓遗留的源仓根 manifest 副本已于 2026-07-30 删除)。

---

## 一、第一次阅读

| 顺序 | 文档 | 什么时候该读它 |
| --- | --- | --- |
| 1 | [../README.md](../README.md) | 第一次进本仓:布局、18 个包与目录、单版本火车、常用命令与各域门、源仓考古 |
| 2 | [mod-dev/README.md](./mod-dev/README.md) | 想给 VelarOS 加一个工具 / 一段提示词 / 一个工作区 / 一块设置区——mod 是什么、分节信封、两级注册机、信任级 |
| 3 | [mod-dev/getting-started.md](./mod-dev/getting-started.md) | **要动手了**:最小 mod → 本地安装 → 启停 → 诊断四态与全部诊断码;含现状与限制 |
| 4 | Desktop 仓 `docs/kernel-contract.md` | 拿不准「这该进内核还是产品」「这接口能不能动」时——**边界唯一裁决依据**,不在本仓 |

---

## 二、契约与判决(拿不准时以这些为准)

**本仓 docs 里没有判决源。** 下面四份都住 VelarOS-Desktop 仓,改本仓任何东西前以它们为准:

| 文档(Desktop 仓) | 什么时候该读它 |
| --- | --- |
| `docs/kernel-contract.md` | 内核宪章。四环分层 / §12 九条法(一包一义·组合式装配·门面收口)/ §15 进程拓扑判决 / §15.7 记忆后端 mod 化 / §15.8 壳 UI 轴 |
| `docs/mod-architecture-blueprint.md` | 蓝图 v6。要加扩展点、加 mod 轴、动插件市场或设置页时 |
| `docs/ecosystem-repo-topology.md` | **写任何跨包路径之前**:四仓终局、本仓内部包身份、旧名→新名对照表 |
| `docs/code-standard.md` | 动笔写第一行代码前:三条不可协商 + 八章判决 + 附录 A 可机械化清单 |

**本仓侧唯一的冻结规范**:

| 文档 | 什么时候该读它 |
| --- | --- |
| [memory/memory-tree-spec-freeze.md](./memory/memory-tree-spec-freeze.md) | 碰记忆树 v2 的 canonical 序列化 / 哈希公式 / 域字符串 / TreeDiff 构造之前。**它是现行规范且冲突时压过架构文档**;附录 A.2 的锚点可纯从文档手工复算。⚠️ 文内多处以现在时声称 `check:memory-anchors` 门在 `bun run check` 链里机械复跑——**该门今天没接线**(探针文件 `packages/memory/src/memory-tree/v2/treediff-v2-probe.ts` 在,门不在),详见 [../README.md](../README.md)「已知欠账」第 5 条 |

---

## 三、架构与模块(当前实现长什么样)

| 文档 | 什么时候该读它 |
| --- | --- |
| [agent/agent-mod-trunk.md](./agent/agent-mod-trunk.md) | 要改 `packages/agent/src/mods/` 的两级注册机第二级时:九轴注册面落在哪些文件、宿主对接契约、**已登记的偏离与残余清单** |
| [agent-lab/architecture.md](./agent-lab/architecture.md) | 要改 Agent Lab 包边界、连续旅程、Driver/Verifier、归档或认证信任边界之前 |
| [agent-lab/methodology.md](./agent-lab/methodology.md) | 要解释回归门、跨执行体公平性、方差/显著性/attrition 或上下文治理实验口径时 |
| [agent-lab/integration.md](./agent-lab/integration.md) | 要接新执行体、加 Journey、Verifier、Detector 或 CLI Runtime 时 |
| [agent-lab/legacy-equivalence.md](./agent-lab/legacy-equivalence.md) | 要核对旧 Desktop agent-lab 的 52 份历史归档、19 个 detector 与已判决语义变化时 |
| [memory/memory-backends.md](./memory/memory-backends.md) | 要加或改记忆后端时:三档后端(`memory-files` 默认 / `memory-vector` 增强 / `memory-tree` 未来)的端口收口落在本仓哪些文件、留了哪些接缝 |
| [../README.md](../README.md)「Kernel 库与独立 Host 进程」 | 想知道「库优先、进程可选」在目录上长什么样:`core/src/kernel/` 五分区 vs `kernel-serve` / `serve-host` / `kernel-client`,以及 `check:kernel-arch` 锁的依赖方向 |
| [mod-dev/seams.md](./mod-dev/seams.md) | 要在运行时**拦一下** agent 行为时:15 个 seam kind、哪 4 个已接线、为什么权限不可旁路 |
| [mod-dev/capabilities.md](./mod-dev/capabilities.md) | 要跨 mod 边界拿能力时:capability token 与权限 broker 的形状,记忆后端当案例 |

---

## 四、工程规范

| 文档 | 什么时候该读它 |
| --- | --- |
| [mod-dev/conventions.md](./mod-dev/conventions.md) | 写 mod 或改本仓 mod 相关代码时的硬规则:数据生命周期与 `ownerModId` 归属、i18n、**语义词汇墙**(内核不得认识具体域词)、依赖方向;文末附**文档-代码漂移清单**(8 条 + 2 个疑似运行时缺陷的处置记录) |
| [gate-coverage-matrix.md](./gate-coverage-matrix.md) | ①想知道「我改的这个包到底有哪些门管着我」;②要给某个包补门之前(先看有没有别的包已在跑同一判据);③怀疑「这条规则我们不是有门吗,怎么没拦住」时。**包 × 门族实测矩阵**,含 arch-guard 44 条在本仓零覆盖的结构性缺口与三条出路 |
| [../README.md](../README.md)「常用命令」 | 要跑门时:`check` 总门的组成,以及 `check:gates` 里那些域门(`check:kernel-arch` / `check:agent-schemas` / `check:memory-boundaries` / `probe:memory` …)怎么单跑 |
| `eslint/_shared.config.mjs` + `eslint/<domain>.config.mjs` + 根 `eslint.config.mjs` | 想知道某条 lint 规则为什么只对某个域生效:公共规则集住 `_shared`(单源),域配置只放私有增量,根基座做域作用域收敛与根锚定 |

> 本仓没有自己的写码规范文档——写码尺子是 Desktop 仓 `docs/code-standard.md`(见 §二)。

---

## 五、领域专题

### 5.1 mod 开发套件(`mod-dev/`)

面向**外部 mod 开发者**的参考手册。总入口 [mod-dev/README.md](./mod-dev/README.md);
宿主那一半(Desktop 怎么装配)在 Desktop 仓 `docs/desktop-agent-mod-wiring.md`。

| 文档 | 什么时候该读它 |
| --- | --- |
| [mod-dev/axes/README.md](./mod-dev/axes/README.md) | 先读这页再挑轴:十一根贡献轴的索引与总表(九根 agent 轴 + 两族 ui 轴),以及**贡献轴是封闭集合、mod 不能发明新轴**这条铁律 |
| [mod-dev/integration.md](./mod-dev/integration.md) | 分不清 MCP / velar-hooks / 旧插件市场 跟 mod 各自该干什么时 |
| [mod-dev/distribution.md](./mod-dev/distribution.md) | 要把 mod 发出去时:bundled / installed / 市场 / 整合包四种形态与认证模型 |

**九根 agent 轴**(住 `agent.contributes`,一轴一页):

| 轴 | 什么时候该读它 |
| --- | --- |
| [tools.md](./mod-dev/axes/tools.md) | 给 agent 加一个工具(主键 `name` 全宿主唯一;运行态绑定必需) |
| [tool-categories.md](./mod-dev/axes/tool-categories.md) | 要给工具分类、供 `tools` 轴的 `categoryId` 引用时 |
| [prompt-segments.md](./mod-dev/axes/prompt-segments.md) | 要往系统提示词里加一段时(注意:蓝图叫 `promptFeatures`,落地名是 `promptSegments`) |
| [spaces.md](./mod-dev/axes/spaces.md) | **写一个新工作区**时的完整规则——一次性决定会话身份、可用工具、每回合上下文、记忆去向。本套件最大的一页 |
| [turn-context-sources.md](./mod-dev/axes/turn-context-sources.md) | 要让 mod 的信息进入**每回合上下文**时——这是唯一通道 |
| [hooks.md](./mod-dev/axes/hooks.md) | 要把 handler 挂到某个 seam 上时(机制看 seams.md,本页只讲 manifest 侧) |
| [execution-modes.md](./mod-dev/axes/execution-modes.md) | 要加目标模式 / 计划模式那一类执行模式时 |
| [sub-agent-types.md](./mod-dev/axes/sub-agent-types.md) | 要加一个 `dispatch_agent` 可派发的子 agent 角色时 |
| [skills.md](./mod-dev/axes/skills.md) | 要贡献 `*.md` 技能时(注意:今天 Desktop 的技能仍走文件式供应方,本轴未接线) |

**两族 ui 轴**(住 `ui` 节,由产品壳解析):

| 轴 | 什么时候该读它 |
| --- | --- |
| [ui-settings.md](./mod-dev/axes/ui-settings.md) | 要给 mod 加设置项时——**`ui` 节里今天唯一真正落地的轴** |
| [ui-shell.md](./mod-dev/axes/ui-shell.md) | 要动 dock / 快捷动作 / 侧边面板时。**契约已定,实装批次 W1–W3**:三轴注册表今天还不存在,壳里对应处仍是硬编码 |

### 5.2 记忆

| 文档 | 什么时候该读它 |
| --- | --- |
| [memory/memory-backends.md](./memory/memory-backends.md) | 见 §三。改记忆后端的第一站 |
| [memory/memory-tree-spec-freeze.md](./memory/memory-tree-spec-freeze.md) | 见 §二。碰冻结面之前必读 |
| [memory/memory-tree-product-architecture.md](./memory/memory-tree-product-architecture.md) | 想理解记忆树**为什么这么设计**:五物理根 / Evidence 溯源 / Dream / TreeDiff / crypto-shred / 统一意义模型。读前先记住它已改判为「三档后端里的未来档」,不是记忆库本体 |
| [memory/memory-tree-product-requirements.md](./memory/memory-tree-product-requirements.md) | 要判断记忆树某个行为「该不该这样」时的产品需求基线(同上,宿主形态已改判) |

---

## 六、历史档(**不要当作当前实现**)

这些文档记的是**当时的事实**,路径、包名与结论都不修实。

| 文档 | 它是什么 |
| --- | --- |
| [memory/memory-tree-third-round-review.md](./memory/memory-tree-third-round-review.md) | 记忆树第三轮独立评审报告(2026-07-13,结论 NEEDS REVISION)。P0/P1 均已处理,留档是为了能追「为什么改成现在这样」 |
| [memory/memory-tree-fifth-round-review.md](./memory/memory-tree-fifth-round-review.md) | 记忆树第五轮独立评审报告(2026-07-13,结论 NEEDS REVISION),范围是 Erasure Saga / 内容加密外置 / Dream 并发 / 物化基点 |
| [memory/memory-tree-revision-notes.md](./memory/memory-tree-revision-notes.md) | 第二 / 四 / 六轮修订的索引:每项修订的动因、证据与影响面。**注意文首那条撤销声明**——「首次启动记忆告知门」整条已撤销,文内相关历史条目全部作废 |
| [memory/0.3-migration.md](./memory/0.3-migration.md) | memory `0.3.0` 迁移说明(产品域 DTO 从 Kernel Core 撤出,无兼容别名)。当年的升级指南,不是现行架构 |
| [agent/migrations/0.3-capability-injection.md](./agent/migrations/0.3-capability-injection.md) | Kernel `0.3` capability-injection 迁移说明(产品显式装配模型与能力包并注入运行时端口)。同上 |

---

## 按任务阅读

### 写一个 mod
[mod-dev/README.md](./mod-dev/README.md) → [getting-started.md](./mod-dev/getting-started.md) →
[axes/README.md](./mod-dev/axes/README.md) 挑轴 → 对应轴页 → [distribution.md](./mod-dev/distribution.md) 发布

### 改 agent 主干 / 加一根轴
Desktop 仓 `docs/mod-architecture-blueprint.md`(判决)→ [agent/agent-mod-trunk.md](./agent/agent-mod-trunk.md)(本仓落地)
→ Desktop 仓 `docs/desktop-agent-mod-wiring.md`(宿主接线)

### 改记忆
[memory/memory-backends.md](./memory/memory-backends.md) → 碰冻结面则必读
[memory/memory-tree-spec-freeze.md](./memory/memory-tree-spec-freeze.md) → 想懂设计意图再翻 §5.2 的架构与需求

### 加一个包 / 动包边界
Desktop 仓 `docs/kernel-contract.md` §12 九条法 + `docs/package-extraction-map.md` →
[../README.md](../README.md)「布局」与 `velaros.domainPackages`(新增包必须同时登记仓根与该域 owners 表)

### 跑门 / 门红了
[../README.md](../README.md)「常用命令」→ 对应域门脚本在 `scripts/<domain>/`,基线在 `baselines/<domain>/`

### 补一道门 / 怀疑某条规则没人在跑
[gate-coverage-matrix.md](./gate-coverage-matrix.md)(先查现状与已知缺口,别重复造门)→
根 `package.json` 的 `check:gates`(**唯一挂链处**,不挂进去等于没有门)

---

## 文档生命周期

- **新增文档必须挂进本页**,否则等于没写(团队里每个人 / 每个 AI 实例的私有缓存互不相通)。
- **判决类内容不进本仓**——先并进 Desktop 的 `kernel-contract.md` 或蓝图,本仓只写落地形态与参考手册。
- 文档失效时**移进 §六历史档并标注,不要原地删**;真正的一次性工件(如并仓期的源仓 manifest 副本)
  才删,且删之前确认 git 历史或仓外归档里有完整证据。
