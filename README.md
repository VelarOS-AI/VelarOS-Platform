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
packages/<pkg>/            23 个平台包,平铺(不按域分子目录)
scripts/build/…            全仓共享:构建拓扑排序
scripts/run-workspace-script.mjs  全仓共享:逐包跑同名 script
scripts/<domain>/…         各源仓自带的脚本原样搬来,按域隔离
baselines/<domain>/…       各域质量门的基线文件
eslint/<domain>.config.mjs 各源仓 eslint 规则集原样保留
eslint.config.mjs          根共享基座:只做域作用域收敛 + 根锚定,不重写规则
tsconfig.json              共享基座:全平台包的 paths 单源
tsconfig.eslint.json       eslint 类型感知用的全仓 program
component-library/         UI 组件图鉴(源自 VelarOS-UI)
tests/<domain>/            各源仓根级测试树
docs/<domain>/             各源仓文档 + 导入时的源仓根 manifest(考古用)
```

**为什么平铺而不是 `packages/<domain>/<pkg>`**:包内 tsconfig 大量写 `baseUrl: "../.."` +
`paths: ["./packages/<pkg>/src/index.ts"]`,package.json 构建脚本写 `../../scripts/…`。平铺让这些
相对路径逐字成立,导入零改写;分域再嵌一层则要改写每个包的 tsconfig 与构建脚本。域归属改由
仓根 `package.json` 的 `velaros.domainPackages` 声明,各域架构门据此把「包集合冻结」收敛到本域。

## 包目录索引

| 域 | 包 | 版本 | 源仓 |
| --- | --- | --- | --- |
| kernel | `@velaros-ai/kernel-client` | 0.3.0 | VelarOS-Kernel |
| kernel | `@velaros-ai/kernel-daemon` | 0.3.2 | VelarOS-Kernel |
| kernel | `@velaros-ai/kernel-updater` | 0.1.0 | VelarOS-Kernel |
| agent | `@velaros-ai/agent` | 0.5.0 | VelarOS-Agent |
| core | `@velaros-ai/core` | 0.3.2 | VelarOS-Core + VelarOS-Kernel |
| model | `@velaros-ai/model` | 0.4.6 | VelarOS-Model |
| capabilities | `@velaros-ai/workspace` | 1.2.5 | VelarOS-Capabilities |
| capabilities | `@velaros-ai/browser`(`/core` `/tools` `/composition` `/runtime`) | 0.2.6 | VelarOS-Capabilities |
| capabilities | `@velaros-ai/computer`(`/runtime` `/tools`) | 0.2.6 | VelarOS-Capabilities |
| capabilities | `@velaros-ai/system-tools` | 0.2.8 | VelarOS-Capabilities |
| capabilities | `@velaros-ai/office-tools` | 0.2.7 | VelarOS-Capabilities |
| capabilities | `@velaros-ai/cli` | 0.2.10 | VelarOS-Capabilities |
| memory | `@velaros-ai/memory`(`/knowledge` `/adapter-kernel`) | 0.3.5 | VelarOS-Memory |
| ui | `@velaros-ai/ui`(`/conversation`) | 0.2.2 | VelarOS-UI |
| html-artifacts | `@velaros-ai/html-artifacts` | 0.1.3 | VelarOS-HTML-Artifacts |

## 源仓考古指引

每个源仓一个导入 commit(`git log --oneline`),message 里记了源仓与源 HEAD sha。要查某段代码
在拆仓前的历史,拿下表的 sha 去源仓 `git log` 即可。

| 域 | 源仓 | 导入 HEAD | 导入时该仓 HEAD 描述 |
| --- | --- | --- | --- |
| core | VelarOS-Core | `62cd3ec5e204e00fc9bb5e4bc79b9498a6f20a68` | chore: lock workspace dependencies for standalone core build |
| kernel | VelarOS-Kernel | `aa9fdfca155134117cf77da841871fe76d957d09` | fix(daemon): pack 加载改逐 pack 隔离 |
| agent | VelarOS-Agent | `25a454baf3d73f18ea9580db5167dcf8793dca19` | chore(release): agent-runtime 0.5.0 / agent-protocol 0.4.0(P7a 已合并为 `@velaros-ai/agent`) |
| model | VelarOS-Model | `3ef17b0ed35c24256146251b75f1f2e220f9d9f1` | Merge PR #14 codex/model-composition-cloud-contract-0.4.6 |
| capabilities | VelarOS-Capabilities | `ff464693026688a1d2b522ca23e3a75443c6e456` | Merge PR #19 codex/office-platform-contract-0.2.7 |
| memory | VelarOS-Memory | `a7aa33441d4a952f5f7c6150c145c9dbc6c83dad` | Merge PR #15 codex/memory-knowledge-contracts |
| ui | VelarOS-UI | `298c1247b1c3c53fc0014f1fea6cfcec1254cf66` | Merge PR #16 codex/ui-release-check-auth |
| html-artifacts | VelarOS-HTML-Artifacts | `7804a39640e83ffddb5a27e9c7fcef6661cd3ba0` | Merge branch 'codex/own-shell-wheel-test' |

导入方式:`git archive HEAD` 只读导出,**源仓工作树与 index 全程未动**。各源仓导入时的根
`package.json` / `tsconfig.json` / `tsconfig.eslint.json` 原样留在 `docs/<domain>/source-root-*.json`,
根共享基座就是从它们并集来的。

## 版本方案(单版本火车)

- 仓根 `version` = **火车版本号**,起 `0.6.0`。
- 各包版本**先保留导入时现值**(见上表),并在仓根 `velaros.domainVersions` 登记;域架构门
  (如 `check:model-arch`)比对的是这里,不是仓根 version。
- **首次里程碑发布时统一推进**:届时把全部包版本对齐到火车版本号,`velaros.domainVersions`
  退化为一个值,发布 tag = `v<火车版本号>`。本批只记方案、不实施。
- 仓内依赖一律 `workspace:*`,发布时由包管理器代换为具体版本。

## 常用命令

```bash
bun install
bun run build            # 按依赖拓扑逐包构建(23 包)
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
> 集成测试跑在 Electron 上,原生模块 ABI 必须匹配(沿用 VelarOS-Memory 源仓的做法)。

## Kernel 的形态(P2 已落)

内核**是库不是进程**(宪章 §15.1 原则一 / §15.4「一个身份」):

| 位置 | 是什么 |
| --- | --- |
| `packages/core/src/kernel/` | **Kernel 库本体**:`abi`(Mod 开发面)/ `protocol`(wire 调用信封,唯一事实来源)/ `contracts`(服务面契约)/ `host`(module host + capability registry + 权限 broker + 事件流 + 状态)/ `runtime`(KernelService) |
| `packages/kernel-daemon/` | **serve 部署模式的配件**:daemon 生命周期 / 本机 RPC 前脸 / ModStore / 进程内传输 / 编译期 bundled pack 清单 |
| `packages/kernel-client/` | 瘦客户端与 serve 模式的接入面 |
| `packages/kernel-updater/` | 共享 Runtime 的安装、切换、回滚 |

依赖方向由 `check:kernel-arch` 锁死:**core 不得依赖 kernel-daemon / kernel-client / kernel-updater**
(库不知进程);反向依赖 core 合法。`check:core-semantic-vocabulary` 另外禁止内核认识
聊天 / 浏览器 / 工作区 / 记忆 / 办公 / 桌面控制这类具体域词。

## 已知欠账(P2 及以后)

1. **领域语义逐出 core 未做完**:`check:core-semantic-vocabulary` 的「待逐出清单」列了余量
   (最大一块是 `packages/core/src/types/index.ts`,1310 行聊天/执行/IPC 载荷);
   数据契约去 `agent/protocol`,运行时行为去 `agent` 主干。清单只减不增。
2. **serve 模式还没有能力宿主**:P4 已把 `importSibling` 与 `packs/` 整体退役——bundled pack 现在
   是编译期常量,daemon 自己只编进 sidecar 目录桩,具体能力(workspace / computer / system-tools)
   由**宿主的构建图**经 `bootKernelDaemon({ modPacks })` 注入(依赖方向 ⑤→④→③→②,宪章 §15.2)。
   Platform 内暂无 `velaros serve` 宿主包,所以这条注入线眼下只有契约与测试,没有生产消费者。
3. **发布流水线**:`.github/workflows/release-packages.yml` 目前只做 tag 身份核验 + 全量门;
   一次性发布 23 个包的火车发布器,以及各域 `scripts/<domain>/release/publish-packages.mjs`
   的合并,随版本推进方案一起做。
4. **消费者独立性门未接线**:各源仓的 `check:consumer` / `check:packages` / `check:lock`
   (打 tarball 后装到临时工程验证可独立消费)需要 npm registry 与逐包 pack,本批未挂进 `check`;
   脚本已随包迁入 `scripts/<domain>/`,路径已修好,接线时可直接用。
