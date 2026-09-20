# 拍板记录（地基重构）

**2026-09-16 17:20：用户把剩下的拍板项全权交给我，下面逐条是我的裁决。** 原来的论证、影响面与建议保留在各节表里，裁决写在这一段；执行顺序在最后一节。
详细方案在 `refactor-plans/<包>.md`，流水账在 `foundation-refactor-log.md`。

## 裁决一览

| 组 | 裁决 |
| --- | --- |
| agent | A1 入口 23→4、升 1.0.0：**做**。A2 工具契约拆成独立包 `@velaros-ai/tool-contract`：**拆**——六个空间包只为写工具就依赖整个 agent 运行时，这是最深的一处耦合，拆完三件公共件（工具定义辅助、内核模块样板、失败回执构造器）才有落点。A3 工具面删改：**按判据逐条做**（判据＝别的工具替代得了、只剩仪式感才删）。A4 空间知识搬家：**做，放最后一轮**，它改发请求字节、要和重放基线一起动。A5 提示词修正：**做**。 |
| browser | B1 工具面 40→32：**做**。B2 `CdpBrowserRuntime`：**删**（零消费、无测试、`enter_site` 在它上面必失败；真要支持无 Electron 宿主时按需重写）。B3 `enter_site` 进常驻集：**做**。B4 提示词改写：**做**。B5 客居空间改宿主声明：**做**。B6 `bindToolApi`：**做**（两个宿主现在各写千行适配层）。B7 用户脚本高风险操作走审批端口：**做**。B8 `contentBoundary`：**删**。B9 懒加载门禁开口：**做**（加登记字段，只放行登记过的目标）。B10 四个入口、0.3.0：**做**。 |
| memory | M1 知识库拆成 `@velaros-ai/knowledge`：**拆**。M2 入口 8→2、0.5.0：**做**。M3 树 v2 不出包：**做**。M4 工具面删改：**做**。M5 `privacyClass` 从模型面拿掉：**做**。M6 宿主按作用域给可写根：**产品层待办**，本仓只保证拒收时说清楚。**以上由 ADR 0010 取代**：知识库删掉、记忆树与向量检索放弃，记忆只认宿主给的一个作用域。 |
| kernel | K1 入口 12→5、类不出包、0.3.0：**做**。K2 删 HostBridge/sidecar 整条链：**删**（ABI 里的 `'sidecar'` 取值一并删）。K3 身份注册 RPC：**删**。K4 `mods.*` RPC：**留**。K5 进程内调用带调用方归属：**做**。K6 事件订阅者失败隔离：**做**。K7 更新器强制 HTTPS 并默认验签、远程节点强制 `wss`（本机回环除外）：**做**。K8 守护进程权限策略注入口：**做**。 |
| model / office / computer | C1 三包入口收口与版本：**做**。C2 office 删 `cwd`：**删**。C3 安装建议与替代方案搬回宿主：**做**。C4 生成文档默认作者留空、`autoRefresh` 缺省 false：**做**。C5 computer 删 `screen_size`、`move` 绑定截图、`leftClick` 改名 `click`：**做**。C6「启用即授权」从工具说明拿掉、改由卡片与宿主表达：**做**。C7 `ModelErrorCodes`：**做**。C8 `ModelAdapter` 基类换注入点、删 `fetchTavily`：**做**；`reasoningLevel: ultra` 抬预算：**做，单独一轮**（改请求字节）。 |
| 七个小包 | S1 门禁加「原语包」档（只给 core）：**做**。S2 core 三处改名：**做，与全仓同车**。S3 cli 删 `velaros agent` 命名空间、帮助改中文：**做**。S4 document-renderer 删包内 `bin` 与 `./cli`：**删**。S5 html-artifacts 改 ui 五个文件、删空转的 `check:dist`：**做**。S6 agent-lab Hooks 驱动迁回 Desktop、预算口径改双账本、允许依赖 core：**做**。S7 development 两处语义如实上报：**做**。S8 标准补两条（可执行入口放包根 `bin/`、环境变量前缀）：**做**。 |
| 公共件 | P1 工具定义辅助、内核模块样板、失败回执构造器：**进拆出来的 `@velaros-ai/tool-contract`**。P2 资源包定位进 platform：**做**。P3 命令结果形状进 shell-command：**做**。 |

## 执行顺序（我按依赖排的）

1. **包内步骤先走完**（不改入口名、不删对外导出，产品零改动）：agent 第 4 步收尾 → 第 5 步工具文件与工具面；kernel 登记、去 barrel、删死代码（K2/K3）、搬家、拆文件；memory 拆 knowledge 包 + 搬家；browser 拆混合文件、合同、常量、中文；model / office / computer 各自搬家；小包按 E1–E5 编组。
2. **`@velaros-ai/tool-contract` 拆包（A2）**：在 agent 入口收口之前做，六个空间包一次改完。
3. **入口收口按顺序**：kernel（`./contracts/abi` 是全仓被引用最多的入口，必须最先）→ agent 1.0.0 → browser / memory / model / office / computer / 小包。全部收口后一次性发一班车，产品只迁一次。
4. **最后两轮**：agent 的空间知识搬家（A4）、model 的 ultra 抬预算（C8 后半）——都会改发请求的字节，与重放基线一起动。
5. 产品层接线（第八节）随发版排期，本仓不改。

## 一、agent

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| A1 | 对外入口 23 → 4（`.`、`./contracts`、`./chat`、`./tool-contract`），删 1,659 个零消费导出，升 **1.0.0** | 做。现在 2,951 个导出里真被用的只有 604 个 | Desktop 416 / Workbench 51 / Termel 17 / Extension 3 个文件跟着迁一次 |
| A2 | 工具契约（`./tool-contract` 与工具相关协议类型）**独立成包** `@velaros-ai/tool-contract` | 倾向拆。六个空间包现在只为「写工具」就把整个 agent 运行时列为依赖 | 六个空间包的依赖与 import；拆了之后工具定义辅助、内核模块样板、失败回执构造器三件公共件才好落 |
| A3 | 工具面删改：删 `context:distill`、合并 `goal:get`/`plan:get`、删 `tooling:map` 的 `op=read`、`job:cancel` 与 `interrupt` 二选一、`directive:list` 去留、`context:handoff` 接线 | 逐条定；判据是「别的工具替代得了、只剩仪式感才删」 | 模型面；提示词审核指纹重算 |
| A4 | 空间知识搬家（源码视图整条链、验证账本搬进 project）放到结构改造之后单独一轮 | 做，但单独一轮 | 会改发请求的字节，影响重放基线与前缀缓存，要 agent 与 project 同车发版 |
| A5 | 提示词修正（工具面评审第 3 节：冲突、冗余、失实、中英混用、约 44 处英文） | 照做 | 模型面；指纹重算 |

## 一·五、project 的工具面归并（你 09-16 提出，待定）

现状：`project:file`（整文件动作）、`project:edit`（文件内编辑）、`project:change`（前两者合成一次事务，外加 inspect/undo）三者语义重叠——`change` 本来就是 `file ∪ edit` 的超集，模型每次改代码都要先做一道无谓的选择题，选错要重来一轮。`project:code` 则是另一个极端：6 个动作 × 一堆交叉旋钮（`direction`、`kind`、`exact`、`exportedOnly`、`includeReExports`、`includeExternal`…）。

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| J1 | 改动三合一：删 `project:file`、`project:change`，只留一个入口，`action: apply/inspect/undo`，`steps[]` 是批量维度 | 做。说明字数从三份约 2,500 降到约 1,100，模型不用再选工具 | 模型面；界面工具卡目录与渲染、agent 里写死 project 工具名的两处、一批测试 |
| J2 | 合并后的名字 | `project:edit`（模型想的是「我要改代码」，这个词最容易命中） | 模型面 |
| J3 | `project:code` 改成命名意图：`outline`/`definition`/`references`/`callers`/`callees`/`imports`/`importers`/`impact`/`diagnostics`，字段只留 `target`、`path`、`limit`，罕用旋钮删掉或进缺省 | 做。它现在 70 多个字段、模型基本只能瞎填 | 模型面；宿主代码查询端口的入参映射 |
| J4 | `project:code-analysis`（trace/cycles/deadcode/routing）并进 code 还是保持独立 | 保持独立：它只在宿主有图后端时出现，并进去会让主工具的可用性时有时无 | 无 |
| J5 | `project:list` 的 `recursive` + `maxDepth` 收成一个 `depth` | 做 | 模型面 |

## 二、browser

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| B1 | 工具面 40 → 32：删 `export_page`（PDF 挪进 `files action=save_pdf`）、`get_element_bounds`、`space_manifest`；诊断四合一；`capture_region` 并入 `capture_screenshot`；`site_context` 并入 `get_page_state` | 做。常驻 6 个工具每轮约 1.7 万字符，`browser:act` 一个就 1.1 万 | 模型面；schema 基线重绑 |
| B2 | `CdpBrowserRuntime`（432 行，零消费、无测试、`enter_site` 在它上面必失败） | 删；真要支持无 Electron 宿主时按需重写 | 无（零消费） |
| B3 | `browser:enter_site` 放进常驻集 | 放。不放的话未进站点时六个常驻工具全隐身，模型得先换入 | 每轮多约 500 字符 |
| B4 | 提示词改写（方案 4.4 节 P1–P17，其中 6 处与实现相反） | 照做 | 模型面 |
| B5 | 「浏览器工具客居 project 空间」从 mod 清单里拿掉，改由宿主传 | 改由宿主传 | `createBrowserBundledModDefinition` 签名；Desktop 空间配方 |
| B6 | `ElectronBrowserRuntime` 加 `bindToolApi(...)`，产品面从 56 个成员收到约 20 个 | 做。两个宿主现在各写 800–1,200 行适配层，Desktop 还另存一份 431 行镜像 | Desktop、Workbench 的适配层大幅缩减 |
| B7 | 用户脚本的高风险操作（启用、切 main world、扩大 match）走审批端口，而不是只靠提示词 | 走审批端口 | `BrowserToolContext` 加 `approval` |
| B8 | 页面内容边界 `contentBoundary`（只有一个工具带、没人读） | 删；提示注入防护应在 agent 的上下文层统一做 | 模型面少一个字段 |
| B9 | 性能引擎 2.5 MB 懒加载：门禁禁止动态 `import()` | 门禁加登记字段只放行登记过的目标（改标准） | `module-ownership.md` 与 ADR |
| B10 | 入口 4 个还是 5 个（React 是否单开 `./react`）、宿主端口改名、版本 0.3.0 | 4 个 | Desktop、Workbench |

## 三、memory

> 本节已由 [ADR 0010](../decisions/0010-memory-slimming.md) 取代：知识库整个删掉，记忆树、向量检索、证据与回合召回一并去掉；留在这里只作记录。

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| M1 | **知识库拆成独立包 `@velaros-ai/knowledge`** | 拆。宪章本来就说记忆与知识永不合并，两边零共享代码 | 导出名不变，只换包名；Desktop 的 import |
| M2 | 入口 8 → 2（knowledge 另 2 个），导出 517 → 约 120，升 0.5.0 | 做 | Desktop 71 个符号按迁移表改 |
| M3 | 树 v2（25 个文件 10,414 行，全仓零消费）不出包 | 不出包，接线时按宿主真要的面再开 | 根入口 268 个名字里 191 个属于它 |
| M4 | 工具面删改：删 `archive` 的 `reason`、删 `save`/`search` 的 `workspaceRoot`、删 `search.mode`、`kind` 旧别名不进 schema、`save` 按「作用域+类别+标题+正文」算稳定去重键 | 照做 | 模型面 |
| M5 | `memory:save` 的 `privacyClass`（只落库、没有行为读它） | 先从模型面拿掉，披露闸门接线时再开 | 模型面 |
| M6 | 宿主要按作用域给可写根（否则一次运行之外采集的项目证据会被拒收） | 做，属产品层接线 | Desktop |

## 四、kernel

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| K1 | 入口 12 → 5、类不出包（`new Kernel()` → `createKernel()`）、升 0.3.0 | 做。777 个导出里真被用 59 个 | 65 个消费文件，真要动代码的只有四类 |
| K2 | 删 HostBridge / sidecar 整条链（约 600 行 + 两个环境变量） | 删。本轮只把权限闸补上了 | ABI 里的 `'sidecar'` 取值去留 |
| K3 | 身份注册 RPC 整块（152 行 + 8 个 RPC 方法）去留 | 删，全仓与三个产品零调用 | 协议面 |
| K4 | `mods.*` 三个 RPC 方法去留 | 留（mod 主干设计依赖 `mods/list`） | 协议面 |
| K5 | 进程内调用补「调用方归属」 | 加。现在宿主判不出是谁在调 | Desktop 可以删掉自己复刻的调用路径 |
| K6 | 事件订阅者失败隔离（现在一个订阅者抛错，后面的收不到、发布方也失败） | 隔离 + 记日志 | 行为变化 |
| K7 | 更新器强制 HTTPS 并默认验签；远程节点 `ws://` 明文传输 | 都加固 | 部署与配置 |
| K8 | `velaros-kernel-daemon` 的权限策略注入口（现在没有，缺省全拒） | 加 | 独立守护进程可用性 |
| **排期** | `./contracts/abi` 是全仓被引用最多的入口（八个能力包的内核模块都靠它） | **kernel 的入口收口要排在 model、office、computer 之前**，否则它们要为同一件事改两遍 | 全局顺序 |

## 五、model / office / computer

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| C1 | 三包入口收口与版本：model 9→3（0.7.0）、office 6→3（2.0.0）、computer 3→2（0.3.0）；类不出包改工厂 | 做，与 agent、kernel 同车 | 各附逐符号迁移表 |
| C2 | office：删 10 个工具的 `cwd`（本轮只把越界堵上了） | 删。路径一律相对工作区 | 模型面 |
| C3 | office：缺转换器时的安装建议卡、「用浏览器线上处理」的替代方案搬回宿主（ADR 0004 在 system 那边已经这么定了） | 搬回宿主 | 宿主端口 |
| C4 | office：生成文档默认作者与公司写「VelarOS」；`autoRefresh` 缺省 | 作者留空、`autoRefresh` 缺省 false | 产物内容 |
| C5 | computer：删 `computer:screen_size`、`move` 绑定截图、`leftClick` 改名 `click` | 照做 | 模型面 |
| C6 | computer：「启用即授权」的口径（提示词现在说了 4 处，与卡片、README 互相矛盾） | 从工具说明里拿掉，改由卡片与宿主表达 | 模型面与产品文案 |
| C7 | model：`ModelErrorCodes` 错误码表（Desktop 现在按报错文字判断「缺 key」） | 做 | Desktop 判据 |
| C8 | model：`ModelAdapter` 基类换成注入点、删零调用的 `fetchTavily`、`reasoningLevel: ultra` 抬预算（会改请求字节） | 前两条做；抬预算单独一轮 | 扩展点与请求字节 |

## 六、七个小包

| # | 事项 | 我的建议 | 影响 |
| --- | --- | --- | --- |
| S1 | core：门禁加「原语包」档（`publicUtils` + `publicClasses: ['AppError']`，只给 core） | 加。否则 core 要把 1,455 个消费方在用的函数全包成类 | 标准与门禁 |
| S2 | core 三处改名：`Result` 值改 `results`（约 190 处）、`TimerScope` 改 `timerScopes.*`（约 120 处）、`logRuntime` 统一成 `Log`（约 180 处） | 都改，一次 codemod，与全仓同车 | Platform 约 300 个文件 |
| S3 | cli：`velaros agent` 命名空间读的目录已无人写；帮助与报错整体改中文 | 删该命名空间、改中文 | 命令行用户 |
| S4 | document-renderer：包内 `bin` 与 `./cli` 去留（真正的可执行文件在产品里） | 删 | 无消费方 |
| S5 | html-artifacts：允许机械改 ui 的 5 个文件（约 20 行）；删空转的 `check:dist` | 都做 | ui 编译 |
| S6 | agent-lab：Velar Hooks 驱动与客户端迁回 Desktop；预算口径改成「整程按整程、段按本段」；允许依赖 core | 都做 | 多段旅程的判定与策略摘要会变 |
| S7 | development：`referenceCount` 停扫时标「至少」；外部语言服务的诊断带上「是否完整」 | 都做 | 模型看得到的字段语义；Termel 跟改 |
| S8 | 标准补两条：可执行入口放包根 `bin/`；环境变量表目前只认 `VELAROS_*` 前缀 | 都补 | `module-ownership.md` |

## 七、跨包公共件（等 A2 定了才好落）

| # | 事项 | 我的建议 |
| --- | --- | --- |
| P1 | 工具定义辅助（四个包各一份 `defineXTool`）、内核模块样板（三份逐行同构）、工具失败回执构造器（`not-applied`/`skipped`/`failed` 三种写法） | 都进 agent 的工具契约；A2 若拆包就进新包 |
| P2 | 可选资源包定位（office、computer、Desktop 三份同算法） | 进 `@velaros-ai/platform/shared-resources` |
| P3 | 命令结果形状（system、project、office 三份同形） | 公共核心进 `@velaros-ai/shell-command/contracts`，三包各自 `extends` |

## 七·五、跨仓欠账（本仓改不了，发版前必须处理）

| # | 事项 | 现状 | 谁来改 |
| --- | --- | --- | --- |
| X1 | VelarScript-Libraries 的 `packages/contract-codegen/tests/support/platform.mjs:20` 读 `packages/kernel/dist/contracts/protocol/index.js` | kernel 搬家后该产物路径不存在，新位置是 `dist/contracts-protocol.js`（53 个 schema、内容一致）；kernel 入口收口后还会再变一次 | 那个仓：改这一行并重生成已提交的 `kernel.manifest.json`、`kernel.report.json`。**建议等 kernel 收口到 0.3.0 之后一次改到位** |
| X2 | Desktop 的 `arch-guard-velaros` 两处按 dist 布局钉路径（memory 三切片、`memory/dist/memory-tree/v2/storage/AtomicFile.js`），以及 browser 的 `dist/composition/`、`dist/tools/` | 三个包的 dist 布局都变了 | Desktop：随升级重写这几处检查 |
| X4 | browser 工具面 40→32 之后，Desktop 与 Workbench 里点名了被删工具的地方 | Desktop：`UnattendedTaskToolPolicy.ts` 的名单、两份技能文档（a11y-debugging、debug-optimize-lcp）、`docs/modules/infrastructure-browser.md`；Workbench：`WorkbenchBrowserToolHost.ts` 的初始可见工具名单含 `browser:site_context` 及其测试 | 两个产品：随升级改名或删名 |
| X3 | Desktop 删掉知识库与旧记忆的全部接线（`@velaros-ai/memory`、`@velaros-ai/memory/knowledge`、LanceDB 插件、嵌入设置、采集开关、`memory.recall` 回合上下文源）；记忆照 ADR 0010 接：`createMemoryStore({ root })` 造一次，每个会话定一个作用域，开场 `renderIndex()` 放进系统提示词（Tier0 之后单独一段、整场不变），`velaros:memory` 设成常驻 | ADR 0010：知识库删掉，记忆只剩一个作用域一个目录的 Markdown 与三个操作 | Desktop：随升级接线 |
| X8 | 验证判据接上 `CodingSessionPolicy` | 两张代码文件知识表（42 扩展名 + 27 构建清单）随 A4 搬进 project，出包为 `projectVerificationPolicy.isVerificationRelevantPath`；agent 1.3.0 改从注入的判据拿结论 | Desktop：升级时把 `projectVerificationPolicy.isVerificationRelevantPath` 接上 `CodingSessionPolicy`。**不接不会坏，但行为偏保守**——验证失败之后只改 `.png` 这类非代码资产也仍算「有待验证的改动」，提醒比现在多 |
| X6 | 宿主声明「请求用户动作该调哪个工具」 | agent 1.2.0 加了可选字段 `userActionRequestToolName`（`AgentRuntimeCapabilityPorts` 与 `AgentRuntimeCapabilityExtension` 各一个）；不填不会坏，只是指引改走不点名那条路 | Desktop：组装 `AgentRuntimeCapabilityPorts` 时填 `userActionRequestToolName: 'interaction:show_action_cards'`。补上之后再回头把 `solo-run-plan-preparer.ts` 里三处保底名单也改成读声明（现在改会先丢保护） |
| X7 | kernel `./serve` 收窄，Termel 改两行 | `5b1020f3`，kernel 0.4.0 | Termel `packages/serve-host/src/host.ts`：删掉 `createDefaultKernelModStorePaths` 的 import；`modStorePaths: createDefaultKernelModStorePaths(paths.modsRoot)` → `modsRoot: paths.modsRoot`。依赖版本提到 `^0.4.0`（两个 `package.json` 与 `bun.lock`）。Termel 还停在 0.2.3，与 0.3.0 那一刀一次做完 |
| X5 | `run` 的 `shell` 字段要能用起来，产品端三处接线 | 字段、词表、拒绝语义、可用性探测都在包内了（`ba7ac608`），但值在产品端 | ① 把 `inspectEnvironment().shells` 的种类按原序写进 `AppRuntimeFacts.availableShells`（第一项是默认那个），**不写则 Windows 上这个能力等于没有**；② project 宿主的 `runCommand` / `runInSandbox` 透传 `options.shell`，做不到就拒绝、别忽略换默认 shell 照跑；③ `SystemEnvironmentInspection` 多了必填的 `shells`，测试替身与 IPC 镜像形状要补 |

## 八、产品层接线（本仓不改，列给你排期）

- Desktop：project 端口新增的两个方法（已自动满足）、memory 照 ADR 0010 接线（作用域由产品定）、browser 适配层（B6）、office 安装建议卡（C3）、model 按错误码判「缺 key」（C7）、各包入口收口后的 import 迁移。
- Workbench：project 的 `runInDirectory` 删除后按 `options.cwd` 接线、browser 适配层、命令执行策略。
- Termel：agent、kernel、surface-protocol、development 的入口迁移。
