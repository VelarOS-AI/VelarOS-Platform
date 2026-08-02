# VelarOS-Platform

**平台侧单版本火车(single version train)monorepo。** host 无关的平台包全部住这里,一次 `bun install`、
一条构建拓扑、一套质量门;版本随火车整体推进,不再逐仓对齐 semver 范围。

## 在四仓终局里的位置

```
VelarOS-Platform    ← 本仓。平台侧一切:kernel / agent / core / model / capabilities / memory / ui / html-artifacts
VelarOS-Desktop     Electron 宿主壳(消费本仓包)
VelarOS-Workbench   IDE 工作台
VelarOS-Cloud       云服务(entitlement / 账号 / 设备座位)
```

不在本仓:`VelarOS-Website`、`VelarOS-Extension`、`VelarOS-Arch-Guard`(独立工具仓,消费方仍走 github 依赖)。

## 布局

```
packages/<pkg>/            平台包,一律平铺(无例外)
scripts/build/…            全仓共享:构建拓扑排序
scripts/run-workspace-script.mjs  全仓共享:逐包跑同名 script
scripts/<domain>/…         各域自带的脚本,按域隔离
baselines/<domain>/…       各域质量门的基线文件
eslint/<domain>.config.mjs 各域 eslint 规则集
eslint.config.mjs          根共享基座:只做域作用域收敛 + 根锚定,不重写规则
tsconfig.json              共享基座:全平台包的 paths 单源
tsconfig.eslint.json       eslint 类型感知用的全仓 program
types/velaros-globals.d.ts 全仓共用的编译期类型别名单源
component-library/         UI 组件图鉴(ui 域)
tests/<domain>/            各域根级测试树
docs/<domain>/             各域文档;**总入口 [docs/readme.md](docs/readme.md)**
```

`workspaces` = `["packages/*"]`,共 **19 个平台包**(下表)。

**为什么平铺而不是 `packages/<domain>/<pkg>`**:包内 tsconfig 大量写 `baseUrl: "../.."` +
`paths: ["./packages/<pkg>/src/index.ts"]`,package.json 构建脚本写 `../../scripts/…`。平铺让这些
相对路径逐字成立,导入零改写;分域再嵌一层则要改写每个包的 tsconfig 与构建脚本。
**域不是目录,是 `velaros.domainPackages` 里的一行声明**。能力包全部平铺在 `packages/`：
Project、System、Browser 等聚合包通过子路径表达职责切片，Development 等单一职责包再由
Mod Loader 拼入具体空间。域归属不靠目录，由仓根 `package.json` 的
`velaros.domainPackages` 声明，各域架构门据此冻结包集合。

## 包目录索引

域归属看 `velaros.domainPackages`,不看目录深浅——browser / computer 属 capabilities 域但住在
`packages/` 顶层。

| 域 | 包 | 版本 | 目录 |
| --- | --- | --- | --- |
| kernel | `@velaros-ai/kernel-client` | 0.3.0 | `packages/kernel-client` |
| kernel | `@velaros-ai/kernel-serve`(`/daemon` `/updater`) | 0.3.2 | `packages/kernel-serve` |
| agent | `@velaros-ai/agent` | 0.5.0 | `packages/agent` |
| core | `@velaros-ai/core` | 0.3.2 | `packages/core` |
| model | `@velaros-ai/model` | 0.4.6 | `packages/model` |
| capabilities | `@velaros-ai/project` | 2.0.0 | `packages/project` |
| capabilities | `@velaros-ai/browser`(`/core` `/tools` `/composition` `/runtime`) | 0.2.6 | `packages/browser` |
| capabilities | `@velaros-ai/computer`(`/runtime` `/tools`) | 0.2.6 | `packages/computer` |
| capabilities | `@velaros-ai/game` | 0.1.0 | `packages/game` |
| capabilities | `@velaros-ai/system` | 1.0.0 | `packages/system` |
| capabilities | `@velaros-ai/office` | 1.0.0 | `packages/office` |
| capabilities | `@velaros-ai/development` | 1.0.0 | `packages/development` |
| capabilities | `@velaros-ai/cli` | 0.2.11 | `packages/cli` |
| memory | `@velaros-ai/memory`(`/knowledge` `/adapter-kernel`) | 0.3.5 | `packages/memory` |
| ui | `@velaros-ai/ui`(`/conversation`) | 0.2.2 | `packages/ui` |
| html-artifacts | `@velaros-ai/html-artifacts` | 0.1.3 | `packages/html-artifacts` |
| host | `@velaros-ai/serve-host` | 0.1.0 | `packages/serve-host` |
| surface | `@velaros-ai/surface-protocol` | 0.1.0 | `packages/surface-protocol` |
| evaluation | `@velaros-ai/agent-lab` | 0.1.0 | `packages/agent-lab` |

## 源仓考古指引

下表的源仓**已全部退役,且不在磁盘上**——别再去 `../VelarOS-Kernel` 这类兄弟目录找它们。
拆仓前的历史有两条取证路径:

1. **本仓的导入 commit**:每个源仓一个,`git show <导入 commit>` 即是那一刻源仓的完整快照。
   导入方式是 `git archive HEAD` 只读导出,所以导入 commit 里没有源仓的逐条历史,只有终态。
2. **源仓完整 git 历史**:归档在仓外 `../_retired-repo-bundles/VelarOS-<域>-20260729.bundle`。
   要逐条历史就 `git clone <bundle> /tmp/<域>` 再 `git log`,下表的「源仓 HEAD」就是 bundle 的 tip。

| 域 | 已退役源仓 | 本仓导入 commit | 源仓 HEAD | 该 HEAD 描述 |
| --- | --- | --- | --- | --- |
| core | VelarOS-Core | `61bb9ef` | `62cd3ec5e204e00fc9bb5e4bc79b9498a6f20a68` | chore: lock workspace dependencies for standalone core build |
| kernel | VelarOS-Kernel | `039d320` | `aa9fdfca155134117cf77da841871fe76d957d09` | fix(daemon): pack 加载改逐 pack 隔离 |
| agent | VelarOS-Agent | `2b3f525` | `25a454baf3d73f18ea9580db5167dcf8793dca19` | chore(release): agent-runtime 0.5.0 / agent-protocol 0.4.0(P7a 已合并为 `@velaros-ai/agent`) |
| model | VelarOS-Model | `e4cf561` | `3ef17b0ed35c24256146251b75f1f2e220f9d9f1` | Merge PR #14 codex/model-composition-cloud-contract-0.4.6 |
| capabilities | VelarOS-Capabilities | `5e2731d` | `ff464693026688a1d2b522ca23e3a75443c6e456` | Merge PR #19 codex/office-platform-contract-0.2.7 |
| memory | VelarOS-Memory | `6d1d15f` | `a7aa33441d4a952f5f7c6150c145c9dbc6c83dad` | Merge PR #15 codex/memory-knowledge-contracts |
| ui | VelarOS-UI | `3ebd44b` | `298c1247b1c3c53fc0014f1fea6cfcec1254cf66` | Merge PR #16 codex/ui-release-check-auth |
| html-artifacts | VelarOS-HTML-Artifacts | `e61dcad` | `7804a39640e83ffddb5a27e9c7fcef6661cd3ba0` | Merge branch 'codex/own-shell-wheel-test' |

**各源仓导入时的根 manifest 曾以 `docs/<域>/source-root-*.json` 副本形式留在 docs 面,已删**
(2026-07-30 QD 清理):根共享基座 `package.json` / `tsconfig.json` / `tsconfig.eslint.json` /
`types/velaros-globals.d.ts` 就是它们的并集,已经是活的单源;副本只是并仓过程工件,而证据在上面
两条路径里都齐。要看原件:`git show <导入 commit>:docs/<域>/source-root-package.json`。

## 文档

全仓文档索引 = **[docs/readme.md](docs/readme.md)**(六分区,每行一句「什么时候该读它」)。

## 面向 mod 开发者

想给 VelarOS 加一个工具、一段提示词、一个工作区或一块设置区,从
**[docs/mod-dev/](docs/mod-dev/README.md)** 开始:

| 文档 | 一句话 |
| --- | --- |
| [README](docs/mod-dev/README.md) | mod 是什么:分节信封 `velaros.mod.json` / 两级注册机 / 生命周期 / 信任级 / partial activation |
| [getting-started](docs/mod-dev/getting-started.md) | 最小 mod → 本地安装 → 启停 → 诊断四态与全部诊断码;**含现状与限制** |
| [axes/](docs/mod-dev/axes/README.md) | 九根 agent 轴 + 两族 ui 轴,一轴一文;[spaces.md](docs/mod-dev/axes/spaces.md) 是自定义工作区开发专章 |
| [seams](docs/mod-dev/seams.md) | 拦截 seam:15 个 kind、4 个已接线、权限不可旁路 |
| [capabilities](docs/mod-dev/capabilities.md) | capability token + 权限 broker;记忆后端当案例 |
| [integration](docs/mod-dev/integration.md) | MCP / velar-hooks / 旧插件市场 三者的定位边界 |
| [distribution](docs/mod-dev/distribution.md) | bundled / installed / 市场 / 整合包 + 认证模型 |
| [conventions](docs/mod-dev/conventions.md) | 数据生命周期 / `ownerModId` / i18n / 语义词汇墙 / 文档-代码漂移清单 |

判决源不在本仓:架构裁决住 VelarOS-Desktop 的 `docs/mod-architecture-blueprint.md`(蓝图 v6)
与 `docs/kernel-contract.md` §15;本套件是参考手册,冲突时以那两份为准。
本仓侧的落地形态与残余清单见 [docs/agent/agent-mod-trunk.md](docs/agent/agent-mod-trunk.md);
**宿主侧怎么接**(Desktop 的装配、安装器、市场入口、MCP 判决)见 Desktop 仓
`docs/desktop-agent-mod-wiring.md`。

## 版本方案(单版本火车)

两根轴,各管一件事(2026-08-02 定案,取代原「首次里程碑统一对齐」计划):

**① 包版本 —— 各自独立走 semver。** 每个包按自己的变更升自己的版本位,互不牵连。
0.x 阶段 minor 位就是破坏位(`^0.2.6` 不会升到 `0.3.0`),1.x 之后按标准 semver。
消费者逐包声明 range、逐包升级——Desktop 现在就是这么做的(`agent ^0.5.0` / `workspace ^1.2.5`)。

**② 平台代 `velaros.platform` —— 表达「这批包同属一代、互相兼容」。** 现值 `0.6`。
仓根声明一次,**每个包在自己的 manifest 里声明同一个值**,随包发布,消费者装完也读得到。
跨代才是整体破坏性升级,应用方看这一个数就知道要不要整批动。

- 为什么不把「代」塞进包版本号:那样任何一个包的破坏性变更都会强推全部包跳代,代号变成
  「任意包破坏性变更」的公倍数,对没变的包是假信号;而且每个包只剩 patch 位一个自由度,
  没法表达「加了功能但没 break」。
- 一致性有门:`check:platform-generation`(已挂进 `check:gates`)与 releaseTopology 的
  不变量④,对全部已声明发布包核对代号一致。
- 仓根 `version`(`0.6.0`)只是**火车号**,给整列发车的 tag 命名用,不参与任何包的版本。
- 仓内依赖一律 `workspace:*`,发布时由包管理器代换为具体版本。

发版有两种 tag,都能独立触发:

| 想发什么 | tag | 结果 |
| --- | --- | --- |
| 单个包 | `agent-lab@0.1.0`(或 `@velaros-ai/agent-lab@0.1.0`) | 只发这一个;tag 里的版本必须与该包 manifest 逐字相同,否则红 |
| 整列火车 | `v0.6.0` | 发全部已声明的包;可再用 workflow_dispatch 的 `only` 手动收窄 |

单包 tag 自带身份,此时传 `only` 直接红——开关不许推翻身份。

## 常用命令

```bash
bun install
bun run build            # 按依赖拓扑逐包构建(18 包)
bun run typecheck        # 逐包 typecheck
bun run test             # 逐包 test
bun run lint             # 全仓 eslint(域规则集各自生效)
bun run check            # 总门:build + typecheck + lint + test + test:suites + 各域门
bun run check:gates      # 只跑各域质量门
```

域门单跑:`check:kernel-schemas` `check:kernel-arch` `check:core-semantic-vocabulary`
`check:agent-schemas` `check:agent-arch`
`check:capabilities-schemas` `check:capabilities-arch` `check:model-arch` `check:memory-boundaries`
`check:memory-knowledge-profile` `probe:memory` `check:ui-form-closure` `check:ui-color-literal`
`check:ui-package-contracts` `check:ui-component-library`。

> `postinstall` 会跑 `electron-rebuild -f -w better-sqlite3`:memory 的探针与 knowledge profile
> 集成测试跑在 Electron 上,原生模块 ABI 必须匹配(memory 域自拆仓时期沿用至今的做法)。

## Kernel 库与独立 Host 进程(P2 已落)

Kernel 本体仍是可注入的库；`serve-host` 是可选的独立产品进程。Desktop / Workbench 可以继续
进程内组合 Kernel，也可以在后续按产品需要切换为 Host 客户端，两种形态不共享数据库或产品 UI。

| 位置 | 是什么 |
| --- | --- |
| `packages/core/src/kernel/` | **Kernel 库本体**:`abi`(Mod 开发面)/ `protocol`(wire 调用信封,唯一事实来源)/ `contracts`(服务面契约)/ `host`(module host + capability registry + 权限 broker + 事件流 + 状态)/ `runtime`(KernelService) |
| `packages/kernel-serve/src/daemon/` | **serve 部署模式的配件**(`@velaros-ai/kernel-serve/daemon`):daemon 生命周期 / 本机 RPC 前脸 / ModStore / 进程内传输 / 编译期 bundled pack 清单 |
| `packages/kernel-serve/src/updater/` | 共享 Runtime 的安装、切换、回滚(`@velaros-ai/kernel-serve/updater`) |
| `packages/kernel-client/` | 瘦客户端与 serve 模式的接入面 |
| `packages/serve-host/` | 独立 Velar Host 产品组合根:`velaros serve` / 独立数据根 / fail-closed 能力开关 / 轻量控制页 / Extension Bridge |
| `packages/surface-protocol/` | Provider Agent Surface 的 Host 中立 wire contract；Web / 插件 / 移动端与具体宿主解耦 |

依赖方向由 `check:kernel-arch` 锁死:**core 不得依赖 kernel-daemon / kernel-client / kernel-updater**
(库不知进程);反向依赖 core 合法。`check:core-semantic-vocabulary` 另外禁止内核认识
聊天 / 浏览器 / 工作区 / 记忆 / 办公 / 桌面控制这类具体域词。

## 已知欠账(P2 及以后)

1. **领域语义逐出 core 未做完**:`check:core-semantic-vocabulary` 的「待逐出清单」列了余量
   (最大一块是 `packages/core/src/types/index.ts`,1310 行聊天/执行/IPC 载荷);
   数据契约去 `agent/protocol`,运行时行为去 `agent` 主干。清单只减不增。
2. ~~**serve 模式还没有能力宿主**~~ **独立 Host v1 已接线(2026-08)**:
   `@velaros-ai/serve-host` 提供 `velaros serve`,拥有独立数据根、Kernel local RPC、轻量控制页、
   Extension Bridge，以及 Workspace / Computer 的动态 fail-closed 权限策略。Computer sidecar 由用户
   显式安装到 Host 数据根；网页模型拥有模型与 Agent 循环，Host 不接触模型凭据。Browser、内建
   Model / Agent 与远端 Web/Mobile 认证网关仍按后续产品里程碑接入。
3. ~~**发布流水线**~~ **已接线(2026-08)**:七份逐仓 `scripts/<domain>/release/*` 已合成一条
   `scripts/release/`(`releaseTopology.mjs` 发布清单单源 + `verify-release-ref.mjs` 预检 +
   `publish-packages.mjs` 发布器),`release-packages.yml` 在质量门之后接上 publish 步骤。
   **仍未做**的是版本推进本身:各包版本保留导入时现值,统一对齐火车号留到首次里程碑
   (见上「版本方案」);发布器因此**不**校验「包版本 == 仓根 version」,理由写在
   `scripts/release/releaseTopology.mjs` 文件头。本地验明用 `bun run release:dry-run`。
4. **消费者独立性门未接线**:各域的 `check:consumer` / `check:packages` / `check:lock`
   (打 tarball 后装到临时工程验证可独立消费)需要 npm registry 与逐包 pack,本批未挂进 `check`;
   脚本已随包迁入 `scripts/<domain>/`,路径已修好,接线时可直接用。
5. **`check:memory-anchors` 门没接线(文档已声称接线)**:`docs/memory/memory-tree-spec-freeze.md`
   多处以**现在时**写「由 `bun run check` 链的 `check:memory-anchors`
   (`scripts/checks/memoryTreeDiffProbe.mjs`)机械复跑,46/46 逐字节一致」。实况:探针本体
   `packages/memory/src/memory-tree/v2/treediff-v2-probe.ts` **在**,但 `check:memory-anchors`
   脚本、`scripts/checks/memoryTreeDiffProbe.mjs`、以及 `packages/memory` 侧对应的 `probe:treediff-v2`
   **三者都不存在**;`probe:memory` 那条链跑的 11 个探针里没有它。
   → **落点**:照 `probe:storage-v2` 的形状加 `packages/memory` 的 `probe:treediff-v2`
   (`bun --conditions=source src/memory-tree/v2/treediff-v2-probe.ts`),再挂进根 `probe:memory` 链;
   接线后把 spec-freeze 的门名与本条一起改实。**在接线之前,该冻结面的 D1 类 canonical/排序漂移无门可拦。**
6. **`agent/protocol` 的 span 契约没有快照锁**:`check:kernel-schemas` 给
   `packages/core/src/kernel/protocol` 做了 wire 形状保形(基线
   `baselines/kernel/kernel-wire-schema-snapshot.json`),但 `packages/agent/src/protocol/observability.ts`
   的 `ExecutionSpanSchema`(判别联合,六类 `run`/`turn`/`model`/`tool`/`capability`/`policy`)、
   `RunSpanSchema`、`ExecutionSpanMetricsSchema` 只有 zod 定义,**没有基线**——
   `check:agent-schemas` 的三道防线(零参数退化 / IR 解释器无宿主能力 / 纯 IR contract)都不覆盖它,
   该脚本头部注释「wire protocol 快照基线归 Kernel 仓自持(kernel-protocol 不在本仓)」也已随并仓过期。
   消费方是 Desktop 的执行 span 账本(`storage/chat/execution-spans/*.jsonl`),字段悄改即静默坏账。
   → **落点**:`scripts/agent/check-schemas.mjs` 加第四道防线,照 kernel 的形状把
   `agent/protocol` 的 span schema 快照进 `baselines/agent/`。上游记录见 Desktop 仓
   `docs/kernel-observability.md`。
7. ~~**arch-guard 的 44 条 `velaros/code-style/*` 在本仓一个包都不跑**~~ → **已闭合(QI 批
   2026-07-30)**:按「劈公共包」出路处置——37 条语言级规则迁进
   `@velaros-ai/arch-guard/checks/code-style`(两仓共依、判据单源、谁都不留副本),7 条认识产品
   概念的仍归 Desktop 私有插件。本仓门 `bun run check:code-style` 已挂进 `check:gates`,存量
   **1915 条**冻结在 `.arch-guard/baseline.json`(口径与 QH 的 1122 不同:那次被 Desktop 硬编码
   的扫描根收窄,`packages/capabilities/**` 等根本没进面)。详见
   [docs/gate-coverage-matrix.md](docs/gate-coverage-matrix.md) §3。
8. ~~**两个包的检查脚本写了但没挂链**~~ → **已闭合(QI 批)**:`check:html-artifacts-package`
   与 `check:project-arch` 已挂进根 `check:gates`。
