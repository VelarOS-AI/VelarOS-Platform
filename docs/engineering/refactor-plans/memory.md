# packages/memory 按仓库标准改造方案

> 对象：`~/Desktop/VelarOS/projects/VelarOS-Platform/packages/memory`（`@velaros-ai/memory` 0.4.6）。分析从 Platform `da737f17` 开始，写完时 HEAD 是 `d769bfad`；本包自 `3c6e7c19`（09-13）起没有改动。期间别的实例提交了：agent 第 2 步整文件搬家（`540de0e6`，agent 0.6.33，`./tool-contract`、`./run-context` 两个入口照旧在）、platform 的路径包含判断（`c9564d45`）、core 的 `utils/RealPath`（`7c39d5c9`）、公共件 `@velaros-ai/text-files`（`b9c2746e`，system 与 project 已改用）、宿主契约消费检查改成按依赖自动补齐打包表（`0ac2b5f1`）——D-1 的修法用得上路径包含判断与 RealPath；text-files 的写入是异步的，文件后端要先把 IO 端口异步化才能用它（见 2.2 节 `files/` 一行）。
> 标准：`docs/architecture/module-ownership.md`、门禁 `scripts/ownership/check-module-ownership.mjs`、登记表 `scripts/ownership/governed-modules.mjs`、ADR 0003/0004/0005/0007/0008；样板 `packages/system`、`packages/project`、`packages/shell-command`、`packages/rehearsal-sandbox`；流水账里已定的事（agent 入口收成 4 个、`./run-context` 第 6 步删、工具契约第 6 步再定拆不拆、text-files 抽包、门禁「迁移中」状态）不重新论证。
> 方法：只读。数字来自草稿区 `plan-memory/` 的脚本（TypeScript AST + 类型检查器解析到声明文件）：`census.mjs`（逐文件声明）、`inventory.mjs`（入口导出）、`consumers.mjs`（消费方，覆盖 Platform 的 `packages/*`、`tests/`、`scripts/`、`products/`，姊妹仓 Desktop、Workbench、Termel、Extension、Cloud）、`whatif.mjs`（按门禁判据估算）、`gate/check.mjs`（门禁副本，把 memory 以「迁移中」登记后 `--only memory`）；缺陷都在 `exp/` 下用内存 IO 或草稿区里的真实文件复现过。
> 基线：`packages/memory` 下 `bun test test` 58 pass / 0 fail（8 个文件）；仓库层记忆测试 5 个文件 13 例、`scripts/memory` 自带测试 4 个文件 19 例、`src/` 里 12 个探针（`probe:memory`，在 `check:gates` 链上，树 v2 的几个要 Electron 的原生 SQLite）。

## 0. 结论先行

1. **规模**：`src/` 121 个 `.ts`、30,542 行，其实是四样东西拼在一个包里——长期记忆（后端契约、文件权威层、树 v1、向量派生层、叠加编排、作用域、4 个工具，42 个文件 8,727 行）、**没接线的树 v2**（25 个文件 10,414 行，全仓与产品零消费方）、**工作区知识库**（`src/knowledge/`，42 个文件 6,488 行，3 个工具，和记忆零共享代码）、12 个探针（4,913 行，放在 `src/` 里）。46 个类只有 7 个 `implements` 接口，19 个 barrel，8 个入口导出 517 个名字（按声明去重 451 个），**真被用到的 95 个（18%）**：Desktop 71 个，其余 24 个只有 Platform 自己的测试和发版夹具在用；根入口 268 个名字里 191 个来自树 v2。
2. **结构问题**：五个目录一个都没有；工具定义函数 `defineMemoryTool` 写在类型文件里，`memoryTools` 在入口文件里计算；`MemoryApi`（工具的宿主端口）12 个方法里工具只调 6 个；树 v2 整个挂在根入口上；`EvidenceBridge` 写死了 computer 的 6 个工具名和 project/development 的 4 个类别 id；`TurnRecallCoordinator` 从 `@velaros-ai/agent/run-context` 值导入账本类（这个入口 agent 第 6 步要删）；知识库与记忆两套工具、两个宿主端口、两份可移植数据，门禁一个登记项装不下。
3. **实现层缺陷**（第 5 节 19 条，前 3 条是 P0，都已复现）：**文件后端的条目 id 与索引行不做路径约束**——`memory:get` 能读记忆目录外的任意文件（包括 `~/.ssh`），`memory:archive` 能改写任意已存在的文件，一个自带 `.velaros/memory/MEMORY.md` 的恶意仓库能让回合自动召回把 `~/.aws/credentials` 注进模型上下文；**文件后端（出厂默认权威层）不打码不截断**，用户在聊天里贴的密钥原样写进 `<仓库>/.velaros/memory/`（这个目录按设计跟着 git 走）；`memory:archive` 没有读门、对不存在的 id 也回「已归档」。另有：归档的条目再被同一来源采集就复活、标题带 `]` 的条目从索引里消失、写入找不到对应作用域根时静默落进别的项目、叠加召回的语义通道不认归档/类别/会话过滤、profile 召回在 24 份全文读取上限之后才按类别过滤、每次写入把索引里所有文件读一遍（400 条时写 1 条读 403 个文件，每次保存会话快照重放整段对话）。
4. **目标**：拆成两个按标准治理的包——`@velaros-ai/memory`（记忆产品 + 宿主胶水 + 内部的树 v2）与新包 `@velaros-ai/knowledge`（工作区知识库）；各自五个目录、一个工具文件、一个宿主端口、一个可移植数据文件、两个入口（`.`、`./contracts`）。memory 的 impl 分 `host/ backends/ files/ vector/ tree/ tree-v2/` 六个子目录、6 层；树 v2 不再出包（接线时按消费方再开面）；探针搬出 `src/` 到 `probes/`。
5. **要拍板的**（第 7 节 11 项）：知识库拆包；入口收口（memory 8→2，0.5.0，破坏性，附逐符号迁移表）；树 v2 不出包；宿主端口收窄（`MemoryApi` 12→6、`MemoryService` 11→4、删 `mount` 的 `store` 口子、回合账本改注入）；工具面删改（`memory:archive` 加读门并如实回执、删 `reason`、删 `workspaceRoot`、删 `search.mode`、kind 旧别名不进 schema、改写两处失实提示）；文件后端行为对齐树后端（打码、写错池子改为拒收、归档不复活）；采集桥里的空间知识交给宿主；产品问题两条（偏好是否跨空间共享、知识库能否索引任意目录）。
6. **步骤**（第 6 节）：先修 P0（不动入口，可以单独发 0.4.7）与 P1 → 去 barrel → 拆出 knowledge 包 → 整文件搬家 → 拆混合文件与常量归位 → 接口与工具文件 → 入口收口与迁移表 → 登记治理；去 barrel、搬家、拆文件、接口这几步不改任何对外名字和模型看到的字节，拆包那一步只把知识库换成新包名（导出名不变），第 7 步一次性收口；Platform 发版前这些都不到 Desktop 手里，Desktop 升级时按迁移表一次改完（同时要改它的 `memoryProductBoundary` 检查）。

## 1. 现状

### 1.1 目录与职责

| 目录 | 文件 | 行 | 职责 |
| --- | ---: | ---: | --- |
| `src/`（根） | 6 | 328 | `index.ts`（根入口：通配转发 backend、memory-tree（含 v2）、MemoryScope，外加在入口里算出 `memoryTools`）、`contracts.ts`（`export type *` 树 v1 的 DTO）、`Types.ts`（工具上下文、宿主端口 `MemoryApi`、`defineMemoryTool` 函数）、`Runtime.ts`（`DefaultMemoryRuntime` 与值别名 `MemoryRuntime`）、`MemoryScope.ts`（作用域两轴与可见性判据）、`Capabilities.ts`（两份工具能力声明） |
| `tools/memory/` | 2 | 382 | 4 个模型面工具 `memory:save/search/get/archive` 的定义与执行 |
| `backend/` | 5 | 819 | 后端窄端口 `MemoryStoreBackend`（6 个动词）、派生索引契约、叠加编排 `createLayeredMemoryStoreBackend`（闭包对象）、树后端适配 `MemoryTreeStoreBackend` |
| `files/` | 7 | 1,495 | 出厂默认权威层 `memory-files`：每个作用域一个目录，`entries/*.md`（frontmatter）加一份 `MEMORY.md` 索引；IO 端口、内存实现、Node 实现；探针 |
| `vector/` | 5 | 1,017 | 市场可选的语义派生索引 `memory-vector`：嵌入端口（BYOK）、穷举余弦、内存与单 JSON 文件两种索引存储；探针 |
| `memory-tree/`（v1） | 10 | 4,001 | SQLite 记忆树：`MemoryTreeDomain`（门面）、`MemoryTreeRepository`（1,829 行）、`MemoryDream`（确定性整理，971 行）、清洗与打码、语义候选抽取、树投影与哈希、schema SQL |
| `memory-tree/v2/`（含 `storage/`） | 34 | 14,260 | 加密树后端 v2：权威库、证据摄入、意义整理、Dream 运行账本、TreeDiff 链、树存储、查询门面、彻底清除 saga、legacy 回放迁移与切换判定、五物理根、keyring、内容密钥、blob、索引代；**产品没有接线**，只被 9 个探针（3,846 行，已计入本行）用 |
| `adapter-kernel/` | 10 | 1,752 | 宿主胶水：`mountMemoryAdapter`（装配三端口）、证据采集桥 `MemoryEvidenceBridge`、回合召回 `MemoryTurnRecallCoordinator`、树治理门面 `MemoryService` 与空闲整理调度 `MemoryDreamScheduler`、后端能力令牌族与内核模块、宿主数据契约；探针 |
| `knowledge/`（含 `embedding/ knowledge/ shared/ tools/`） | 42 | 6,488 | 工作区知识库：工作区摄入（文档、配置、代码候选）、分块、SQLite FTS + LanceDB 向量混合检索、嵌入请求与缓存、向量 profile 隔离迁移、诊断与重建、3 个工具 `knowledge:diagnostics/sync/search` |

另外：`test/` 8 个测试文件、`examples/` 3 个示例（发布门禁用 NodeNext 编译 `minimal.ts`）、`docs/adapter-kernel/`、`docs/knowledge/` 两份随包发布的说明。

### 1.2 子系统怎么串起来

- **自动采集**：Desktop 聊天服务在发送被接受时调 `evidenceBridge.captureUserMessage`，每次保存会话状态调 `captureSessionSnapshot`（整段对话的 user/assistant 消息），执行协调器调 `captureComputerUseObservation / captureWorkspaceToolObservation / captureExecutionObservation`，删会话调 `markSessionSourceDeleted` → 桥按四个类别开关与会话豁免放行，把事件规整成 `MemoryEvidenceInput`（信任级：用户消息 `user_stated`、观察 `system_observed`、助手 `agent_derived`）→ 串行排队 `store.captureBatch(inputs, { consolidate: false })` → 后端有 `dream` 动词时即时整理 25 条。
- **回合召回**：发送后 `turnRecall.notifyUserMessage`（后台，结果进只对模型可见的增量账本 `memory.recall`，下一轮注入，每会话每条只注入一次、每轮至多 3 条）；外部引擎走可等待的 `recallUserMessage`（2 秒硬预算）。两路都排除运行轨迹来源、会话观察与本会话证据，普通召回为空时可自动降级深层召回。
- **工具**：`memory:save` 把模型写的内容以 `agent_tool / agent_derived` 采集；`memory:search` 按当前空间作用域召回并投影成紧凑条目；`memory:get` 按 id 读全文，经可见性读门；`memory:archive` 归档。上下文里的宿主端口 `ctx.memory` 由 Desktop 的 `createSessionMemoryToolApi` 实现，落在与自动采集同一个后端上。
- **后端装配（Desktop）**：注册 files 与 tree 两个权威档（加上 LanceDB 插件提供的 vector）→ 按 `systemConfig.memory.storeBackends`（出厂 `['files']`）选权威层 → 按 `derivedIndexBackends`（出厂空）选派生层 → `createLayeredMemoryStoreBackend` 叠加 → `mountMemoryAdapter({ backend, tree: { domain, idleSignal }, config, hostContext })`。所以**生产上的权威层是文件后端**，树 v1 只剩「治理」（诊断、立即整理、空闲整理调度）还挂着。
- **知识库**：Desktop 自己的 `KnowledgeService` 与 IPC 调 `knowledgeDomainService` 的同步、搜索、诊断、重建；工具 `knowledge:search` 零命中时自动补一次增量同步再搜。Desktop 的记忆向量嵌入器借用知识库的 `EmbeddingApi`（请求构造与响应解析）。

### 1.3 对外入口：导出了什么、谁在用

口径：「导出」是入口经类型检查器解析出的名字；「被用」指至少一个消费方文件 import 了这个名字（仓内按 `packages/memory` 以外算）。

| 入口 | 导出（值） | 被用 | Desktop | 只有 Platform 在用 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| `.` | 268（124） | 16 | 15 | 1 | 191 个来自树 v2（97 个值）；31 个来自树 v1（24 个 DTO，另有 `MemoryTreeDomain`、`MemoryDream`、`MemoryTreeRepository`、`MemoryTreeRecall` 四个类、别名 `MemoryDomain`、建表 SQL 与建表函数）；24 个与 `./backend` 重复 |
| `./contracts` | 24（0） | 2 | 2 | 0 | 渲染进程与 `@velaros/ipc` 只用 `MemoryDreamRunResult`、`MemoryTreeDiagnostics` |
| `./backend` | 24（9） | 11 | 11 | 0 | |
| `./files` | 19（12） | 5 | 4 | 1 | 发版夹具用 `createInMemoryMemoryFilesIo` |
| `./vector` | 12（6） | 4 | 4 | 0 | 渲染进程 `useEmbeddingSettings.ts` 从这里取 `MemoryVectorBackendId` |
| `./knowledge` | 109（47） | 34 | 17 | 17 | 17 个只被仓库层测试拿来直接测内部类 |
| `./knowledge/contracts` | 20（0） | 5 | 5 | 0 | |
| `./adapter-kernel` | 41（14） | 18 | 13 | 5 | |
| 合计 | 517（按声明去重 451） | 95 | 71 | 24 | |

真实被用的符号（Desktop 除特别注明外；`(P)` = 只有 Platform 的测试或发版夹具）：

- `.`：`memoryTools`、`createMemoryRuntime`、类型 `MemoryRuntime`（P 另用它的值做 `instanceof`）、`MemoryDomain`（类 `MemoryTreeDomain` 的别名）、`MemoryApi`、`MemoryRecallItem`、`MemoryRecallOptions`、`MemoryScopeId`、`MemoryDreamRunResult`、`MemoryTreeDiagnostics`、`MemoryTreeRuntimeProviders`(P)、`MemoryTreeSchemaSql`（Desktop 第 1 号存储迁移）、`SYSTEM_MEMORY_SCOPE`、`buildProjectMemoryScope`、`buildSiteMemoryScope`、`scopeTypeForScopeId`。
- `./adapter-kernel`：`mountMemoryAdapter`、`MountMemoryAdapterInput`、`MemoryAdapterConfigPort`(P)、`MemoryAdapterHostContextPort`(P)、`MemoryAdapterTreePort`(P)、`MemoryAdapterRuntime`（P 当类型与类用）、`HostIdleSignalPort`、类型 `MemoryEvidenceBridge`、`MemoryHostSessionSnapshot`、`MemoryHostUserMessageEvent`、类型 `MemoryService`、`MemoryStoreCapabilityRegistry`、`MemoryStoreCapabilityService`、类型 `MemoryTurnRecallCoordinator`、`memoryStoreCapabilityId`、`resolveMemoryStoreBackend`、`resolveMemoryDerivedIndexBackends`、`listRegisteredMemoryStoreBackends`。
- `./backend`：`MemoryStoreBackend`、`MemoryBackendDescriptor`、`MemoryBackendStats`、`MemoryBackendVerb`、`MemoryDerivedIndexBackend`、`LayeredMemoryStoreBackend`、`createLayeredMemoryStoreBackend`、`createMemoryTreeStoreBackend`、`isMemoryDerivedIndexBackend`、`resolveAuthorityEnumeration`、`supportsMemoryBackendVerb`。
- `./files`：`createMemoryFilesBackend`、`createNodeMemoryFilesIo`、`createInMemoryMemoryFilesIo`(P)、`MemoryFilesIo`、`MemoryFilesScopeRoot`。
- `./vector`：`createMemoryVectorBackend`、`createFileVectorIndexStore`、`MemoryEmbedder`、`MemoryVectorBackendId`。
- `./knowledge`：`knowledgeTools`、`createKnowledgeRuntime`、类型 `KnowledgeRuntime`（P 另用值）、类型 `KnowledgeDomain`、类型 `KnowledgeVectors`（Desktop 只存不用）、`EmbeddingApi`（Desktop 的记忆向量嵌入器 `new EmbeddingApi(factory)`）、`EmbeddingRequestFactory`、`KnowledgeEmbeddingRuntime`、`KnowledgeLanceDbModule`、`KnowledgeEmbeddingProfileIsolationMigration`（Desktop 第 3 号存储迁移）、DTO 七个（`KnowledgeDiagnostics`、`KnowledgeReindexOptions/Result`、`KnowledgeWorkspaceSyncOptions/Result`、`KnowledgeSearchOptions/Result`）；P 的 17 个：`KnowledgeRuntimeProviders`、`VectorFailureMonitor(Options)`、`KnowledgeChunkBuilder`、`KnowledgeChunkRecord`、`KnowledgeEmbeddingProviderId`、`KnowledgeIndexStatuses`、`KnowledgeMutation`、`KnowledgeRecord`、`KnowledgeRepo`、`KnowledgeRows`、`KnowledgeVectorIndexRecord`、`KnowledgeVectorQuery`、`KnowledgeWorkspace`、`Embeddings`、`buildDocumentRevisionKey`、`buildEmbeddingProfileIdentity`（全在 `tests/memory/maintained/` 里直接测内部件）。
- `./contracts`、`./knowledge/contracts`：见上表，全是 DTO。

另外按路径钉住 dist 的：`tests/memory/maintained/packages/memory/{package-consumer,adapter-injection}.test.mjs`、`scripts/memory/checks/packageConsumerIndependence.test.mjs`（`dist/index.js`、`dist/knowledge/index.js`、`dist/adapter-kernel/index.js`）；`scripts/release/fixtures/host-contract-consumer/{consumer.ts,runtime.mjs}` 经包名用 `./files` 与 `./adapter-kernel`，还读 `adapter.storeDescriptor`、`adapter.isDefaultStore`。Desktop 的 `scripts/checks/kernelAssembly.mjs`、`scripts/checks/toolDescriptionBudget.mjs` 也经包名用上面的函数。

### 1.4 与别的包的耦合

| 依赖 | 用在哪 | 用了什么 | 说明 |
| --- | --- | --- | --- |
| `@velaros-ai/agent/tool-contract`（peer） | `Types.ts`、`index.ts`、`Memory.tool.ts`、`knowledge/Types.ts`、`knowledge/index.ts`、`Knowledge.tool.ts` | `defineToolRuntimeSpec`、`DefineToolRuntimeSpecInput`、`ToolContractRuntimeSpec`、`renderParameterDescription`、`structureToolDescriptionsForCategory` | 写工具的 SDK；agent 第 6 步要么变成 `agentToolContracts.*`，要么拆成 `@velaros-ai/tool-contract` |
| `@velaros-ai/agent/run-context`（peer） | `adapter-kernel/TurnRecallCoordinator.ts` | **值导入**类 `TurnContextSessionLedgers`，以及它 `peek` 的返回类型 | agent 第 6 步删这个入口（改成根入口的工厂）；而 Desktop 的 `memoryProductBoundary` 棘轮禁止记忆主干 import agent 根入口。建议改成宿主注入（第 3.2 节） |
| `@velaros-ai/kernel/contracts/abi` | `adapter-kernel/MemoryStoreCapability.ts` | `createCapabilityToken`、`defineKernelModule`、`KernelModuleApiVersion`、`CapabilityToken`、`KernelModuleDefinition` | 后端能力令牌族；与 system、project 同一种用法。测试另用 `@velaros-ai/kernel/runtime` 的 `KernelModuleHost` |
| `@velaros-ai/core` | 59 个文件 | 类型守卫、`truncate`、`clamp`、`Log`；`/error` 的 `AppError`（35 个文件）；`/logger` 的 `logRuntime`（9 个文件）；`/utils/TimerScope`（2 个） | `logRuntime.tag(…)` 不匹配门禁的日志例外（只认 `Log.tag(`），要换写法 |
| `better-sqlite3` | 8 个文件 | 连接类型；树 v2 的 legacy 读取与权威库直接 new 连接 | 宿主负责打开与关闭（树 v1、知识库）；v2 自己开库 |
| `@lancedb/lancedb`（可选 peer） | `knowledge/Types.ts`、`Vectors.ts` | 只有类型；`knowledge/Types.ts` 用了内联 `typeof import('@lancedb/lancedb')` | 门禁第 9 条禁内联 import 类型 |
| `zod` | 3 个工具相关文件 | 入参 schema | |
| Node 内置 | `node:crypto` 20 个、`node:fs` 11 个、`node:path` 12 个、`node:fs/promises` 1 个 | 哈希与 UUID、文件 IO、路径 | 只要 `./contracts` 的引用链不碰就行；现在 `./vector` 被渲染进程加载，碰巧没碰 |

反方向：kernel、agent 对 memory 零 import（Desktop 的 `memoryProductBoundary` 棘轮扫 dist 守着）。

### 1.5 写死了别的空间或宿主知识的地方

| 位置 | 写死了什么 | 处理 |
| --- | --- | --- |
| `adapter-kernel/EvidenceBridge.ts:47` | `WorkspaceToolObservationInput.categoryId: 'project-files' \| 'project-changes' \| 'project-execution' \| 'development-code'`（project 与 development 空间的工具类别 id） | 交给宿主：桥收中性的观察（阶段、目标、说明），见第 7 节第 7 项 |
| `EvidenceBridge.ts:306-326` | `computer:screenshot/screen_size/move/click/type/key` 六个 computer 工具名，以及各自的中文描述与参数字段（`x`、`y`、`button`、`text`、`keys`） | 同上：描述由宿主（或 computer 包）给 |
| `EvidenceBridge.ts:328-349` | 按类别拼「通过 X 完成了一次项目修改」，从 `path / filePath / rootPath / cwd` 四个参数名里找目标 | 同上 |
| `adapter-kernel/TurnRecallCoordinator.ts:289` | 注入条目的核对入口写死 `{ tool: 'memory:get' }` | 本包自己的工具，改引常量表 `MemoryToolNames.get` |
| `TurnRecallCoordinator.ts:209`、`:95` | 回合上下文源 id `'memory.recall'` 写两遍 | 进常量表 `MemoryTurnContextSourceId` |
| `tools/memory/Memory.tool.ts:77` | `inferWorkspaceRoot` 按 `project:` 前缀反解工作区根 | 本包自己的作用域格式，改用 `utils/scope.ts` 的单一解析 |
| `knowledge/Types.ts:260-270` | 知识工具上下文带 `hasProjectRoot()` 与 `project.getRootPath()` | 属于「当前工作区根」这一宿主读数，可保留；名字改成 `activeWorkspaceRoot()` 更中性（可选） |

作用域本身（`project:<root>`、`site:<origin>`、`system`、`global`）是本包拥有的格式，不算写死宿主知识；宿主把上下文映射到作用域（`MemoryHostScopeResolver`），这条接缝是对的。

### 1.6 模块级可变状态与「隐形类」

- 模块级 `let` 只在 12 个探针里（`assertionCount`）。
- 以闭包工厂或模块级对象字面量藏着状态、实为类的：`createLayeredMemoryStoreBackend`（闭包持 authority、derived、report，再按能力条件挂方法）、`createInMemoryMemoryFilesIo`（闭包 `Map`）、`nodeMemoryFilesIo`（模块级对象实例）、`createInMemoryVectorIndexStore`、`createFileVectorIndexStore`（闭包 `records`、`version`、`loaded`）。按标准都改成类加工厂。
- 有状态的类（状态在实例上，符合标准，只要补接口）：`MemoryTurnRecallCoordinator`（注入去重表、在途闩）、`MemoryEvidenceBridge`（串行队列）、`MemoryDreamScheduler`（计时租约）、`MemoryDream`（`running`）、`KnowledgeQuery`（访问节流表）、`KnowledgeIngestion`（同步态）、`KnowledgeVectors`（表缓存）、`Embeddings`（查询向量 LRU）。
- 模块级的只读名单与表（规则数据，搬到 utils 后合规）：`SecretPatterns`、`RecallPredicateByCategory`、`conceptTypeByCategory`、`FieldAliases`、`ReservedAttributeOrder`、`DEFAULT_HIDDEN_DIRECTORIES`、`CODE_EXTENSIONS`、v2 的若干 `Set`。
- impl 文件里的模块级常量（门禁「impl 的模块级只放日志和导出的实例」）：`whatif.mjs` 数出 44 个数字常量加 9 处 `?? 数字` / 参数缺省 / 名字像上限的属性写数字；模块级日志写成 `logRuntime.tag(...)` 的 9 个文件（树 v1 两个、知识库七个）也会被当成普通常量拦（门禁只认 `Log.tag(`）。

### 1.7 类与文件的形状

- 46 个类，`implements` 接口的只有 7 个（`DefaultMemoryRuntime`、`MemoryTreeStoreBackend`、`MemoryFilesBackend`、`MemoryVectorBackend`、`DefaultKnowledgeRuntime`、v2 的 `LegacyMemoryEvidenceSqliteReaderV2`、`MemoryTreeReplayResultValueV2`）；0 个错误类。
- 公开成员合计约 302 个（含 v2），都要进各自的类上方接口并写中文说明；43 个私有方法不用 `this`（知识库 33 个，其中 `KnowledgeWorkspace` 一个类 14 个），要进 utils。
- 一个文件两个类：`memory-tree/v2/EvidenceReplayMigration.ts`。类加一堆模块函数的「混合文件」19 个（v2 占 13 个，`files/Backend.ts` 9 个模块函数、`memory-tree/Dream.ts` 11 个）。
- 公开静态成员 5 个（v2 的 `open(...)` 工厂：`MemoryAuthorityDatabaseV2`、`LegacyMemoryEvidenceSqliteReaderV2`、`MemorySystemRuntimeV2`、`MemoryKeyringStoreV2`、`MemoryTreeStoreV2`）。
- 无状态类（只是函数的壳）：`KnowledgeRows`、`KnowledgeVectorQuery`、`KnowledgeChunks`（被当成构造参数注入，测试里 `new` 它们）、`KnowledgeQueryHelper`（已标 `@deprecated`，零引用）、`KnowledgeContext`（导出为 `KnowledgeContext` 与 `AgentKnowledgeHelper`，全仓与两个产品零引用，死代码）、`MemoryTreeRecall`（一个方法的薄壳）。
- 别名：`MemoryTreeDomain as MemoryDomain`、值别名 `MemoryRuntime = DefaultMemoryRuntime`、`KnowledgeRuntime = DefaultKnowledgeRuntime`、类型别名 `ToolContext`、`MemoryAdapterMount`，以及知识库 9 个类别名（`KnowledgeChunks`、`KnowledgeWorkspaceStore`、`KnowledgeRepository`、`KnowledgeRepositoryHelper`、`KnowledgeVectorHelper`、`KnowledgeVectorStore`、`EmbeddingApiHelper`、`EmbeddingService`、`AgentKnowledgeHelper`）。
- 死值：`KnowledgeContext`、`KnowledgeQueryHelper`、`isCodeFile`（`CodeHelper.ts`，只有声明）、`MemoryAuthorityEncryptedContentColumnsV2`（只有声明）。

### 1.8 模型和用户看得到的英文

| 位置 | 原文 | 谁看得到 |
| --- | --- | --- |
| `knowledge/tools/knowledge/IndexIssueSummary.ts:19-34` | 三条 `guidance`：`Embedding credentials are rejected by the provider issuer check; …`、`Embedding authentication failed; …`、`Knowledge index has stored errors for these documents; …` | 模型（`knowledge:search` 结果的 `indexIssues[].guidance`） |
| `adapter-kernel/mount.ts:109,114,120` | `Memory adapter requires one backend selection source.` / `Memory adapter has no authority backend.` / `Memory adapter requires a complete authority backend.` | 宿主装配失败时的报错 |
| `adapter-kernel/MemoryStoreCapability.ts:39` | `Memory store backend id must not be empty` | 宿主 |
| 三个后端的 `displayName` 与叠加后缀 | `Memory tree (SQLite Evidence/Dream authority)`、`Memory files (markdown authority)`、`Memory vector (semantic derived index)`、`… + N derived index` | 用户（Desktop 设置页「跑在哪个后端上」直接显示 descriptor） |
| 两份能力声明的 `reason` | `memory read`、`memory write`、`knowledge index read`、`knowledge index write` | 审批与审计面（取决于宿主怎么显示） |
| `Memory.tool.ts:213` | 缺省 `source: 'memory tool'` | 用户（文件档写进 frontmatter） |
| `EvidenceBridge.ts:318,322,352` | 中文句子里的 `left`、`unknown` | 模型（证据正文） |
| 工具说明里夹的英文词 | 「knowledge 索引」「profile 覆盖率」「短时 TTL」「active workspace root」 | 模型 |

报错与失败说明的其余部分（约 280 处 `AppError`）已经是中文。

### 1.9 包内重复（按标准收成单源）

- 同一个上限写两处：证据正文 24,000 / 标题 240（`Sanitizer.ts` 与 `memory:save` 的 schema）；召回缺省 10（`Layered.ts`、`vector/Backend.ts`、`files/Backend.ts` 的 `?? 10`）。
- 同一个函数写多份：`sha256`（Dream、TreeProjection、DiffChain）、`truncate`（Dream、SemanticExtraction、TurnRecall 私有方法、core 已有一份）、`readMetadataString`（Dream、files）、`normalizeIdentityText`（Dream 与 v2 的 `normalizeIdentityTextV2`）；v2 内部 `registerBlobV2` 4 份、`assertNonEmpty*/assertNonNegative*` 5 份以上、`isStrictRecordV2` 3 份、`compareCodeUnit` 2 份、`assertGenerationV2` 2 份。
- 同一个类型别名 `SQLiteDatabase = InstanceType<typeof BetterSqlite3>` 在 memory 的 7 个文件里各写一遍（knowledge 另有 1 个）。
- 两个原子写：`files/NodeIo.ts`（temp + rename，不 fsync）与 `v2/storage/AtomicFile.ts`（fsync 文件与目录、带崩溃注入钩子）；跨包的那份已经抽成 `@velaros-ai/text-files`（`b9c2746e`，异步），v2 的因为要崩溃注入钩子暂留。
- 跨包：知识库的 `PathPolicy.ts`（路径在不在根里）与 platform 刚加的 `isPathTextInside / relativePathTextInside` 重复；`DEFAULT_HIDDEN_DIRECTORIES` 与 system、project 的跳过目录名单是同类规则（ADR 0008 的 path-rules）。

### 1.10 测试怎么组织

| 层 | 在哪 | 规模 | 跑法 | 问题 |
| --- | --- | --- | --- | --- |
| 包内实现测试 | `test/`（adapter-kernel 2、backend 1、knowledge 2、scope 1、tools 2） | 8 个文件 58 例 | `bun test test`（`test` 脚本先 build） | 经相对路径深引 `src`；3 个知识库测试要随拆包走 |
| 探针 | `src/**/*-probe.ts` 12 个 | 约 510 条断言 | `probe:memory`（`check:gates` 链上）：files、vector、store-capability、storage-v2 用 `bun --conditions=source` 直跑源码；7 个 v2 探针经 `scripts/memory/checks/*Probe.mjs` 用 bun 打包后在 Electron 里跑；**`treediff-v2-probe.ts`（冻结规范的逐字节回归，46 条断言）没有任何脚本在跑**（D-19） | 放在 `src/` 里违反第 8 条；脚本按 `packages/memory/src/memory-tree/v2/...` 钉路径 |
| 仓库层 | `tests/memory/maintained/packages/memory/` 5 个文件 | 13 例 | `test:memory`（`test:suites`）；两个 `.mjs` 直接 import `packages/memory/dist/*` | 知识库的 3 个其实是内部件测试，按标准应回包内 |
| 消费方类型检查 | `tests/memory/consumer/package-api.ts` | 1 个文件 | `scripts/memory/checks/packageConsumerGate.mjs`（发版用） | 用类当值（`instanceof`、`new VectorFailureMonitor`） |
| 边界门 | `scripts/memory/checkProductBoundaries.mjs`（`check:memory-boundaries`） | 三切片方向规则 + 可移植契约规则 | `check:gates` | 按 `src/knowledge`、`src/adapter-kernel`、`src/contracts.ts`、`src/memory-tree/Types.ts` 钉路径 |
| 知识 profile 集成 | `scripts/memory/checks/knowledgeProfileIntegrationTest.mjs` | 3 例 | `check:memory-knowledge-profile`（Electron） | 钉 `tests/memory/maintained/.../KnowledgeVectorsProfileIntegration.test.ts` |

### 1.11 按路径钉住本包的地方（搬家时同提交改）

`package.json` 的 `probe:*`、`build`（`tsconfig.build.json` 排除 `src/**/*-probe.ts`）；根 `tsconfig.json` 的 5 条 `@velaros-ai/memory*` paths；`scripts/memory/checkProductBoundaries.mjs`；`scripts/memory/checks/*Probe.mjs`（7 个）、`knowledgeProfileIntegrationTest.mjs`、`packageConsumerGate.mjs`、`packageConsumerIndependence.test.mjs`；`tests/memory/maintained/*.mjs`；`scripts/release/fixtures/host-contract-consumer/*`；`scripts/release/check-host-contract-consumer.mjs` 的 `hostPackageDirectories`；根 `package.json` 的 `velaros.domainPackages.memory`；`docs/generated/package-catalog.json`；文档 `docs/memory/memory-backends.md`、`docs/memory/memory-tree-spec-freeze.md`（DiffChain 与探针路径）、`docs/mod-dev/capabilities.md`、`docs/mod-dev/conventions.md`。Desktop 仓：`packages/arch-guard-velaros/src/checks/architecture/memoryProductBoundary.ts`（扫 `node_modules/@velaros-ai/memory/dist` 并排除 `knowledge`、`adapter-kernel` 两个子树）、`rendererPortablePackageBoundary.ts`、`architecturePaths.mjs`、`scripts/checks/{kernelAssembly,toolDescriptionBudget}.mjs`。

## 2. 目标布局

### 2.1 总体：两个包

记忆与知识在代码上零共享（现在靠 `check:memory-boundaries` 的 `mustStayInSlice` 守着），README 自己写着「记忆与知识永不合并——域宪章级的判决」；两边的工具、宿主端口（`ctx.memory` / `ctx.knowledge`）、定义工具的函数、可移植数据、消费方（Desktop 的记忆 mod / 知识服务与 IPC）都是两套。门禁一个登记项只有一个 `toolsFile`、一个 `toolDefiner`、一个 `hostPort`、一个可移植文件，硬塞在一个包里要么改门禁、要么让知识库的一半不受检查。所以按「一包一义」拆：

```text
packages/memory/                 @velaros-ai/memory 0.5.0     长期记忆：后端契约与三个后端、叠加编排、作用域、4 个工具、宿主胶水；树 v2 在包内、不出包
  MODULE.md                      模块卡片（十节）
  README.md                      用户说明（改写：不再提 /knowledge；adapter-kernel 的说明并进卡片）
  spec/  invariants.md  acceptance.test.ts  support.ts
  test/                          现有 5 个记忆测试（相对路径随搬家改写）+ 修缺陷的新测试
  probes/                        12 个探针移出 src（tree-v2/ 下 9 个）；scripts/memory/checks/*Probe.mjs 与 package.json 的 probe:* 改指这里
  examples/                      改用工厂（不再 new 类）
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     memory.ts（可移植）  tool.ts  host.ts  files.ts  vector.ts  tree.ts  tree-v2/（9 个）
    impl/      MemoryTools.ts  MemoryToolOperations.ts  host/  backends/  files/  vector/  tree/  tree-v2/（含 storage/）
    utils/     tuning.ts  tool.ts  tools.ts  scope.ts  evidence.ts  backends.ts  capture.ts  recall.ts  text.ts  vector.ts  files/  tree/  tree-v2/（含 storage/）
    exports/   index.ts   contracts.ts
    velaros-globals.d.ts        （照 system 留在 src 根，门禁不数 .d.ts）

packages/knowledge/              @velaros-ai/knowledge 0.5.0  工作区知识库：摄入、分块、FTS + 向量混合检索、嵌入客户端、3 个工具
  MODULE.md  README.md（← packages/memory/docs/knowledge/README.md）
  spec/  test/（← memory 的 3 个知识测试 + tests/memory/maintained 下 3 个知识测试）
  src/
    contract/  provides.ts   requires.ts   constants.ts
    types/     knowledge.ts（可移植）  host.ts  code.ts  storage.ts  ingestion.ts  tool.ts
    impl/      KnowledgeTools.ts  KnowledgeToolOperations.ts  KnowledgeRuntime.ts  domain/  storage/
    utils/     tuning.ts  tool.ts  tools.ts  index-issues.ts  code.ts  chunks.ts  query.ts  indexing.ts  vector-stats.ts  paths.ts  workspace.ts  rows.ts  vector-query.ts  embedding.ts
    exports/   index.ts   contracts.ts
```

域名在 impl、utils、types 三处共用；每个子目录直接放的源文件都不少于 3 个（门禁要求）。下面先写 memory，2.7 节写 knowledge。

### 2.2 memory 的 impl/：每个子目录放哪些类

「←」右边是来源；★ 是新建的类（从闭包工厂、对象字面量、函数组或模块级实例改来）。接口一律写在类上方，公开的在 `provides.ts` 登记。

| 位置 | 类文件（文件名即类名）← 来源 | 接口 |
| --- | --- | --- |
| `impl/`（根） | `MemoryTools.ts` ← `tools/memory/Memory.tool.ts` 的 4 个定义 + `Capabilities.ts` 两份能力声明 + `index.ts` 里 `structureToolDescriptionsForCategory(...)` 的计算 + 工具类别定义（+ 第 7 节第 8 项拍板后的内置 mod 定义）；**不放类** | 没有类 |
| `impl/`（根） | `MemoryToolOperations.ts` ★ ← 4 个 execute 的函数体（save 11 条、search 9 条、get 5 条语句）；`memory:archive` 在这里补读门与如实回执 | `MemoryToolOperationsApi`（`save`、`search`、`get`、`archive`） |
| `host/` | `MemoryAdapterRuntime` ← `adapter-kernel/mount.ts`；`MemoryEvidenceBridge` ← `EvidenceBridge.ts`；`MemoryTurnRecallCoordinator` ← `TurnRecallCoordinator.ts`；`MemoryTreeService` ← `Service.ts` 的 `MemoryService`（改名：它只管树的治理）；`MemoryDreamScheduler` ← `DreamScheduler.ts`；`MemoryStoreCapabilities` ★ ← `MemoryStoreCapability.ts` 的 6 个函数 | `MemoryAdapterApi`、`MemoryEvidenceBridgeApi`、`MemoryTurnRecallCoordinatorApi`、`MemoryTreeServiceApi`、`MemoryDreamSchedulerApi`、`MemoryStoreCapabilitiesApi` |
| `backends/` | `LayeredMemoryStore` ★ ← `backend/Layered.ts` 的闭包对象；`MemoryTreeStoreBackend` ← `backend/TreeStoreBackend.ts`；`MemoryBackends` ★ ← `backend/Contract.ts` 与 `DerivedIndex.ts` 的 5 个判定函数（对外实例 `memoryBackends`）；`MemoryScopes` ★ ← `MemoryScope.ts` 的 5 个函数（对外实例 `memoryScopes`） | `LayeredMemoryStoreBackend`、`MemoryStoreBackend`（requires）、`MemoryBackendsApi`、`MemoryScopesApi` |
| `files/` | `MemoryFilesBackend` ← `files/Backend.ts`；`InMemoryMemoryFilesIo` ★ ← `files/Io.ts` 的闭包；`NodeMemoryFilesIo` ★ ← `files/NodeIo.ts` 的模块级对象（`@velaros-ai/text-files` 的 `textFileIo.writeText` 是异步的，而 `MemoryFilesIo` 端口与文件后端全是同步的；第一轮保留现写法、补上 fsync，端口异步化放第 9 步——它顺带解掉 D-10 的主线程阻塞，但 Desktop LanceDB 插件里两处同步读写要跟着改） | `MemoryFilesBackendApi`（= `MemoryStoreBackend & MemoryAuthorityEnumeration`）、`InMemoryMemoryFilesIoApi`、`MemoryFilesIo`（requires） |
| `vector/` | `MemoryVectorBackend` ← `vector/Backend.ts`；`InMemoryVectorIndexStore` ★、`FileVectorIndexStore` ★ ← `vector/Store.ts` 的两个闭包 | `MemoryDerivedIndexBackend`（requires）、`MemoryVectorIndexStore`（requires） |
| `tree/` | `MemoryTreeDomain` ← `memory-tree/Service.ts`（并入 `Recall.ts` 的一个方法，`MemoryTreeRecall` 删）；`MemoryTreeRepository` ← `Repository.ts`；`MemoryDream` ← `Dream.ts`；`MemoryTreeRuntime` ← `Runtime.ts` 的 `DefaultMemoryRuntime`（`schema/MemoryTreeSchema.ts` 的 SQL 进常量表 `MemoryTreeStorage.schemaSql`，`applyMemoryTreeSchema` 全仓零调用、删） | `MemoryTreeDomainApi`、`MemoryTreeRepositoryApi`、`MemoryDreamApi`、`MemoryRuntime` |
| `tree-v2/` | 按类一文件：`MemoryAuthorityDatabaseV2`、`MemoryDreamRunCoordinatorV2`、`MemoryErasureServiceV2`、`MemoryEvidenceIngestServiceV2`、`LegacyMemoryEvidenceSqliteReaderV2`、`MemoryEvidenceReplayMigrationV2`（← `EvidenceReplayMigration.ts` 拆两个）、`MemoryIdentityKeyServiceV2`、`MemoryMeaningCurationServiceV2`、`MemoryQueryFacadeV2`、`MemorySystemRuntimeV2`、`MemoryTreeProjectionIndexV2`、`MemoryTreeStoreV2`、`MemoryTreeReplayV2` ★（← `DiffChain.ts` 的正反向回放与「可持久化」品牌：原来靠值类 `MemoryTreeReplayResultValueV2` 的私有字段加 `instanceof`，改成本类 `private static readonly` 的 `WeakSet` 登记，结果本身变成纯数据）；5 个 `static open(...)` 改成构造器完成打开、`openReport` 读数放在接口上 | 每个类同名加 `Api`；都不登记进 provides（不出包） |
| `tree-v2/storage/` | `MemoryBlobStoreV2`、`ContentKeyServiceV2`、`MemoryKeyringStoreV2` | 同名加 `Api` |

合计 impl 38 个文件（工具文件 1、类 37），没有错误类（全包抛 `AppError`，外面按错误码判断）。类名只改三处：`MemoryService` → `MemoryTreeService`、`DefaultMemoryRuntime` → `MemoryTreeRuntime`、v2 的回放值类并进 `MemoryTreeReplayV2`；其余照旧，免得搬家和改名混在一起。

### 2.3 分层（从上到下；上层可以引下层与同层）

| 层 | 登记（`layers`） | 说明 |
| --- | --- | --- |
| 1 工具 | `MemoryTools.ts` | 4 个工具的定义、类别、（拍板后）内置 mod |
| 2 工具执行 | `MemoryToolOperations.ts` | execute 交给的类，只经 `ctx.memory` 调宿主 |
| 3 宿主胶水 | `host/` | 装配、采集桥、回合召回、树治理门面、空闲整理调度、后端令牌族 |
| 4 后端编排与规则 | `backends/` | 叠加体、树后端适配、动词与派生索引判定、作用域规则的对外实例 |
| 5 后端 | `files/`、`vector/`、`tree/` | 三个互不相引的后端实现 |
| 6 树 v2 | `tree-v2/`（含 `storage/`；门禁按前缀认层，storage 与上一级同层） | 独立子系统，除探针外没人引它 |

实测（`layers2.mjs`：用类型检查器把每个 import 的名字解析到声明文件，只数指向类、工厂、实例的值引用，类型声明本来就要搬进 types 与合同）：跨层的值引用只有 `host/` → `host/` 5 处、`host/` → `backends/` 2 处、`host/` → `tree/` 3 处、`backends/` → `tree/` 1 处、后端内部 9 处、树 v2 内部 128 处，方向都向下；`files/`、`vector/`、`tree/` 互不引用（`vector/Store.ts` 只引 `files/Io.ts` 的接口，搬家后接口进 `requires.ts`）；树 v2 只引 core 与 Node，唯一例外是 `evidence-replay-v2-probe.ts` 引了树 v1 的 schema（探针不在分层里）。**零处下层引上层。** utils 在所有层之下，只引 utils、types 与合同。

### 2.4 memory 的 utils/

| 文件 | 来源（纯函数、规则名单；类里不用 `this` 的私有方法也并进来） |
| --- | --- |
| `tuning.ts` ★ | 全包可调参数表 `MemoryTuning`，约 45 项，分 `tools`、`capture`、`recall`、`dream`、`files`、`layered`、`vector`、`tree`、`treeV2` 九组（第 3.3 节） |
| `tool.ts` | `defineMemoryTool`（← `Types.ts`；类别按工具名查表自动填，同 system 的 `defineSystemTool`） |
| `tools.ts` | `normalizeCategory`、`inferWorkspaceRoot`、`compactRecall`、缺省隐私级与 profile 类别名单（← `Memory.tool.ts`） |
| `scope.ts` | `scopeTypeForScopeId`、`buildProjectMemoryScope`、`buildSiteMemoryScope`、`resolveMemoryScopeSelector`、`isMemoryVisibleInScope`（← `MemoryScope.ts`；全仓唯一的可见性判据，文件、向量、叠加语义通道、工具读写门都经它） |
| `evidence.ts` | `sanitizeMemoryEvidenceInput`、`inferEvidenceScope`、`redactSecrets` 与 `SecretPatterns` 名单（← `memory-tree/Sanitizer.ts`；**文件后端也要经它**，第 5 节 D-2） |
| `backends.ts` | `supportsMemoryBackendVerb`、`listMissingAuthorityMemoryVerbs`、`formatMemoryDerivedIndexVersion`、`resolveAuthorityEnumeration`、`isMemoryDerivedIndexBackend`（← `backend/`）、`recallOptionsExcludeItem`（改成与词法通道同一套过滤）、`interleaveById`（← `Layered.ts`） |
| `capture.ts` | `titleFromContent`、描述文案的拼装（← `EvidenceBridge.ts` 的 3 个无 `this` 私有方法；第 7 节第 7 项拍板后 computer 与 project 的描述搬去宿主，这里只剩中性拼装）、环境块过滤 |
| `recall.ts` | `formatSummary`、`truncate`、候选过滤（← `TurnRecallCoordinator.ts`） |
| `text.ts` | 包内共用的 `sha256`、`truncateText`、`firstLine`、`readMetadataString`、`normalizeIdentityText`（← Dream、SemanticExtraction、TreeProjection、files 各一份，收成单源；能用 core 的就用 core） |
| `vector.ts` | `buildIndexText`、`stringifyValue`、`toPointerItem`、`normalizeVector`、`dot`、`toAsyncIterable`、`encodeVector`、`decodeVector`、`parsePersistedVectorIndex`（← `vector/Backend.ts`、`Store.ts`；`matchesScope` 改直接调 `scope.ts`） |
| `files/entries.ts` | `slugify`、`hash`、`tokenize`、`scoreIndexEntry`、`parseEntryId`（**加路径约束**：只认 `entries/<名>.md`）、`optionalTags`、`conceptTypeByCategory`（← `files/Backend.ts`） |
| `files/frontmatter.ts` | `parseMemoryFileDocument`、`serializeMemoryFileDocument` 与 5 个内部函数、别名表（← `Frontmatter.ts`；修单引号转义） |
| `files/index-file.ts` | `parseMemoryIndex`、`serializeMemoryIndex`、`upsertMemoryIndexEntry`、`removeMemoryIndexEntry`（← `IndexFile.ts`；名字里的 `]`、`\n` 要转义） |
| `tree/dream-rules.ts` | Dream.ts 的 11 个模块函数（概念描述、谓词、置信度、认识状态、显著度…） |
| `tree/repository-rows.ts` | 行映射 6 个函数、`readIdentitySupportingConceptIds`、`RecallPredicateByCategory` 名单（← `Repository.ts`） |
| `tree/semantic-extraction.ts` | ← `SemanticExtraction.ts` |
| `tree/tree-projection.ts` | ← `TreeProjection.ts` |
| `tree-v2/*.ts`（12 个） | `authority-schema.ts`（SQL 与三个 apply）、`authority-database.ts`、`diff-chain.ts`（28 个函数）、`tree-manifest.ts`、`identity-keys.ts`、`evidence-ingest.ts`、`evidence-replay.ts`、`erasure.ts`（24 个）、`meaning-curation.ts`、`query.ts`、`dream-runs.ts`、`tree-store.ts`；外加 `checks.ts` 收拢 v2 里重复的 `assert*`、`isStrictRecord`、`compareCodeUnit`、`registerBlob`（现各 2–5 份） |
| `tree-v2/storage/*.ts`（9 个） | `atomic-file.ts`、`blob-id.ts`、`content-key.ts`、`generation-pointer.ts`、`index-generation.ts`、`keyring.ts`、`physical-roots.ts`、`wrapping-root.ts`、`error-codes.ts`（`MemoryStorageErrorCodesV2` 表；v2 不出包，所以码表不进合同） |

### 2.5 memory 的 types/

| 文件 | 来源 |
| --- | --- |
| `memory.ts`（**可移植**，`./contracts` 入口；不 import，只许从常量表 import type，不带函数成员） | 树 v1 的 DTO 全部（← `memory-tree/Types.ts` 的 17 个接口、7 个类型）；后端数据（`MemoryBackendRole`、`MemoryBackendDescriptor`、`MemoryBackendStats`、`MemoryBackendCaptureBatchOptions`、`MemoryBackendAwaitable`、`MemoryDerivedIndexVersion`、`MemoryDerivedIndexRebuildResult`、`MemoryDerivedIndexFailure`）；作用域数据（`MemoryScopeId`、`MemoryScopeSelectorInput`、`MemoryScopeTarget`、`MemoryScopeVisibilityInput`）；宿主事件数据（`MemoryHostScopeInput`、`MemoryHostScope`、`MemoryHostUserMessage(Event)`、`MemoryHostTranscriptMessage`、`MemoryHostSessionSnapshot`、三个观察入参加 `Memory` 前缀改名）；`MemoryTurnRecallInput/Result`、`MemoryFilesScopeRoot`、`MemoryVectorIndexRecord`、`MemoryBackendCapabilities`、`MemorySessionLineageContext`；`MemoryBackendVerb` 改成由常量表 `typeof` 派生（见 3.3） |
| `tool.ts` | 4 个工具入参（`MemorySaveInput` 等，← `Memory.tool.ts`）、`DefineMemoryToolInput`（带回调，不可移植） |
| `host.ts` | 宿主胶水内部的选项形状（桥的开关、回合召回依赖、调度器选项、树服务选项，← 各类文件的非导出接口；都带回调，不出包） |
| `files.ts` | `MemoryFileDocument`、`MemoryIndexEntry`、`SerializeMemoryFileDocumentInput`、`ScoredCandidate` |
| `vector.ts` | `PersistedVectorIndex`、`PendingIndexEntry` |
| `tree.ts` | 树 v1 的行类型（10 个，← `Repository.ts`）、Dream 的 3 个内部类型、`MemorySemanticCandidate`、`MemoryTreeDiffOp/Node`、`SQLiteDatabase` 别名（6 个文件各一份收成一份） |
| `tree-v2/*.ts`（9 个） | `authority.ts`、`diff.ts`、`dream.ts`、`erasure.ts`、`evidence.ts`、`meaning.ts`、`query.ts`、`storage.ts`、`store.ts`：v2 的 133 个接口与类型（不出包，合同签名用不到） |

### 2.6 memory 的 exports/：两个入口

| 入口 | 文件 | 给谁 | 内容 |
| --- | --- | --- | --- |
| `.` | `exports/index.ts` | Node 宿主（Desktop 主进程、发版夹具） | provides 登记的接口与它们的实例、工厂；requires 的全部接口；公开签名用到的 types；`export * from './contracts.js'` |
| `./contracts` | `exports/contracts.ts` | 任何进程，含渲染进程与 `@velaros/ipc` | `export * from '../contract/constants.js'`、`export type * from '../types/memory.js'` |

为什么不留 `./backend`、`./files`、`./vector`、`./adapter-kernel`：它们的消费方全是 Desktop 主进程（与根入口同一个进程），唯一的渲染进程用法是 `MemoryVectorBackendId`，进常量表后从 `./contracts` 取；按「确有独立消费方的才多开」没有一个站得住。原来 `./vector`「不 import 就一行都不加载」的考虑，在 `sideEffects: false` 加 ESM 下由打包器的摇树保证，向量后端本身也没有原生依赖。`browserSafeEntries` 登记 `contracts.ts`。

### 2.7 knowledge 包

| 位置 | 内容 |
| --- | --- |
| `impl/`（根） | `KnowledgeTools.ts`（3 个工具 + 能力声明 + 类别；`knowledge:search` 的 execute 现在 14 条语句）、`KnowledgeToolOperations.ts` ★（search 的零命中自动补同步与回执拼装、sync 的根解析）、`KnowledgeRuntime.ts`（← `DefaultKnowledgeRuntime`，工厂 `createKnowledgeRuntime`） |
| `impl/domain/` | `KnowledgeDomain`（← `Service.ts`）、`KnowledgeQuery`、`KnowledgeMutation`、`KnowledgeMaintenance`、`KnowledgeIngestion`、`KnowledgeWorkspace`（← `WorkspaceStore.ts`，14 个无 `this` 私有方法进 `utils/workspace.ts`） |
| `impl/storage/` | `KnowledgeRepository`（← `KnowledgeRepo`）、`KnowledgeVectors`、`KnowledgeEmbeddings`（← `Embeddings`）、`KnowledgeEmbeddingClient`（← `EmbeddingApi`，对外工厂 `createKnowledgeEmbeddingClient`）、`VectorFailureMonitor`（← `VectorFailureLog.ts`） |
| 删除 | 无状态类改函数：`KnowledgeRows` → `utils/rows.ts`、`KnowledgeVectorQuery` → `utils/vector-query.ts`、`KnowledgeChunks` → `utils/chunks.ts`（构造参数里的注入随之去掉）；死代码 `KnowledgeContext`（`AgentKnowledgeHelper`）、`KnowledgeQueryHelper`、`isCodeFile`；9 个类别名 |
| 分层 | `KnowledgeTools.ts` → `KnowledgeToolOperations.ts` → `KnowledgeRuntime.ts` → `domain/` → `storage/` |
| utils | `tuning.ts`（← `KnowledgeIndexConfig` 的 28 个数值 + 散落的 `WORKSPACE_SYNC_TTL_MS`、`MAX_*`、`QueryEmbeddingCacheMaxEntries`、`KnowledgeAccessTouchThrottleMs` 等十来个）、`tool.ts`（`defineKnowledgeTool`）、`tools.ts`（`resolveWorkspaceRoot`）、`index-issues.ts`（← `IndexIssueSummary.ts`，guidance 改中文）、`code.ts`、`chunks.ts`、`query.ts`（← `QueryHelper.ts` + `shared/query/HybridQuery.ts`，BM25 列权重数组是规则数据留这里）、`indexing.ts`、`vector-stats.ts`、`paths.ts`（← `PathPolicy.ts`，改用 platform 的 `relativePathTextInside`）、`workspace.ts`、`rows.ts`、`vector-query.ts`、`embedding.ts` |
| types | `knowledge.ts`（可移植，← `knowledge/domain/Types.ts`，它现在只 import 常量表的类型，正合规）、`host.ts`（嵌入运行时、HTTP 请求、LanceDB 连接形状）、`code.ts`（代码智能 11 个数据类型）、`storage.ts`（行类型 7 个）、`ingestion.ts`、`tool.ts` |
| 入口 | `.`（Node 宿主）、`./contracts`（可移植数据，渲染进程与 IPC 契约用） |

### 2.8 备选：不拆包

如果拍板不拆，knowledge 进 memory 的 `impl/knowledge/`、`utils/knowledge/`、`types/knowledge.ts`，入口留 `.`、`./contracts`、`./knowledge`、`./knowledge-contracts`（门禁把入口名映射成 `exports/<名>.ts`，名字不能带 `/`，所以 `./knowledge/contracts` 必须改名）。代价：① 门禁要支持一个包两个工具文件、两个定义函数、两个宿主端口，否则知识库的工具不受检查；② 可移植文件只能一个，知识库的 DTO 要么和记忆的 DTO 混在 `types/memory.ts`（违背宪章），要么 `./knowledge-contracts` 逐个列名转发一个非可移植文件（门禁不查它不 import）；③ `check:memory-boundaries` 的切片规则要按新路径重写并长期保留；④ 知识库仍要跟着记忆一起升版。

## 3. 合同草案

原则同 ADR 0003/0007 与 system、project 的先例：宿主拿到的是整件能力；类实现的 API 写在类上方，`provides.ts` 用 `export type { … } from '../impl/<域>/<类>.js'` 登记；出包的值只能是常量表，或 impl 里标注成公开接口的实例与工厂；工具函数一律不出包，宿主要用的收成对外实例的方法（先例：`analyzeCommandExecution(x)` → `shellCommandPolicy.analyze(x)`）。**判定口径：有消费方的才进，成员按消费方收窄**；每一行写了证据。

### 3.1 memory 的 `contract/provides.ts`：产品面

| 公开接口 | 实现 | 出包的值 | 成员 | 谁在用 / 说明 |
| --- | --- | --- | --- | --- |
| `VelaTool<TInput>`、`MemoryToolCollection` | 没有类（工具文件） | `memoryTools` | 4 个工具 | Desktop 记忆 mod、描述预算检查 |
| `MemoryRuntime` | `tree/MemoryTreeRuntime` | 工厂 `createMemoryRuntime(providers)` | 1：`memoryDomainService`（删掉重复的 `domain`） | Desktop 1 处；类 `DefaultMemoryRuntime` 与值别名 `MemoryRuntime` 不再出包 |
| `MemoryTreeDomainApi`（← 类 `MemoryTreeDomain`，原来经别名 `MemoryDomain` 出包） | `tree/MemoryTreeDomain` | 经 `createMemoryRuntime` 取得 | 14：`captureEvidence`、`captureEvidenceBatch`、`runDream`、`recall`、`getClaim`、`getTreeState`、`getTreeStateAtVersion`、`verifyTreeIntegrity`、`getDiagnostics`、`forgetClaim`、`setEvidenceEligibility`、`setSessionEvidenceEligibility`、`warmup`、`recoverOrphanDreamRuns` | Desktop 4 个文件；树后端适配与树治理门面要其中 11 个；`getTreeState`、`getTreeStateAtVersion`、`verifyTreeIntegrity` 现在只经 Desktop 的工具端口转接在调（端口收窄后没人调），它们是树的版本回看与完整性校验、Memory 页要用，暂留 |
| `MemoryAdapterApi`（← 类 `MemoryAdapterRuntime` 与别名 `MemoryAdapterMount`） | `host/MemoryAdapterRuntime` | 工厂 `mountMemoryAdapter(input)` | 4：`service`、`evidenceBridge`、`turnRecall`、`store` | Desktop 装配 1 处、发版夹具；`storeDescriptor` → `store.descriptor`，`isDefaultStore` → `store.descriptor.id === MemoryBackendIds.tree`（只有夹具在读） |
| `MemoryTreeServiceApi`（← 类型 `MemoryService`） | `host/MemoryTreeService` | 经 `MemoryAdapterApi.service` | 4：`warmup`、`close`、`getDiagnostics`、`runDreamNow`（原来 11 个，其余 7 个转发全仓零调用，删） | Desktop IPC、组合根 |
| `MemoryEvidenceBridgeApi`（← 类型 `MemoryEvidenceBridge`） | `host/MemoryEvidenceBridge` | 经 `MemoryAdapterApi.evidenceBridge` | 7：五个 `capture*`、`markSessionSourceDeleted`、`flush` | Desktop 聊天服务与执行协调器，全用 |
| `MemoryTurnRecallCoordinatorApi` | `host/MemoryTurnRecallCoordinator` | 经 `MemoryAdapterApi.turnRecall` | 4：`notifyUserMessage`、`recallUserMessage`、`createTurnContextSource`、`clearSession` | Desktop 用前三个；**`clearSession` 宿主从来不调**（第 5 节 D-15），保留并让宿主接上 |
| `MemoryTurnContextDeltaSource` | 没有类 | 经 `createTurnContextSource()` | 4：`id`、`scopes`、`rendererVisible`、`peekCached` | 返回形状改由本包自持（不再借 agent 类的 `peek` 返回类型），见 3.2 的账本端口 |
| `LayeredMemoryStoreBackend` | `backends/LayeredMemoryStore` | 工厂 `createLayeredMemoryStoreBackend(options)` | 继承 `MemoryStoreBackend`，加 4：`derivedDescriptors`、`hasStaleDerivedIndex`、`rebuildDerivedIndexes`、`dropDerivedIndexes` | Desktop 装配与设置页；`dropDerivedIndexes` 是卸载路径，Desktop 还没接 |
| `MemoryBackendsApi` | `backends/MemoryBackends` | 实例 `memoryBackends` | 4：`supports(backend, verb)`、`missingAuthorityVerbs(backend)`、`isDerivedIndex(backend)`、`authorityEnumeration(backend)` | Desktop 用 `supports`、`isDerivedIndex`、`authorityEnumeration`；`missingAuthorityVerbs` 给宿主诊断面，可不开 |
| `MemoryStoreCapabilitiesApi` | `host/MemoryStoreCapabilities` | 实例 `memoryStoreCapabilities` | 6：`capabilityId(backendId)`、`token(backendId, version?)`、`createKernelModule(options)`、`resolveAuthority(input)`、`resolveDerivedIndexes(registry, ids, version?)`、`listRegistered(registry, ids, version?)` | Desktop 用 1、4、5、6；`token` 与 `createKernelModule` 只有测试在用，但它是「市场装的后端」注册进内核的唯一路径，保留 |
| `MemoryStoreCapabilityService` | 没有类 | — | 1：`backend` | Desktop 注册表 |
| `MemoryScopesApi` | `backends/MemoryScopes` | 实例 `memoryScopes` | 5：`projectScope(root)`、`siteScope(origin)`、`scopeTypeOf(scopeId)`、`selector(input)`、`isVisible(target, input)` | Desktop 用前三个；`isVisible` 是全仓唯一的可见性判据，宿主自己过滤召回结果时应当用它（Desktop 的聊天建议现在自己写了一份） |
| `MemoryFilesBackendApi`（= `MemoryStoreBackend & MemoryAuthorityEnumeration`） | `files/MemoryFilesBackend` | 工厂 `createMemoryFilesBackend(options)` | 继承 | Desktop、夹具 |
| `InMemoryMemoryFilesIoApi` | `files/InMemoryMemoryFilesIo` | 工厂 `createInMemoryMemoryFilesIo(seed?)` | 继承 `MemoryFilesIo`，加 `snapshot()` | 发版夹具与 headless 宿主 |
| — | `files/NodeMemoryFilesIo` | 工厂 `createNodeMemoryFilesIo(): MemoryFilesIo` | — | Desktop 2 处 |
| — | `vector/MemoryVectorBackend`、`vector/FileVectorIndexStore` | 工厂 `createMemoryVectorBackend(options): MemoryDerivedIndexBackend`、`createFileVectorIndexStore(options): MemoryVectorIndexStore` | — | Desktop LanceDB 插件；`createInMemoryVectorIndexStore` 只有探针在用，不出包 |
| — | `backends/MemoryTreeStoreBackend` | 工厂 `createMemoryTreeStoreBackend(domain: MemoryTreeDomainApi): MemoryStoreBackend` | — | Desktop 装配；参数从 `Pick<MemoryTreeDomain, …>` 别名 `MemoryTreeStoreDomain` 改收接口 |

树 v2 一个都不进产品面：`openMemorySystemRuntimeV2`、`MemoryQueryFacadeV2`、`evaluateMemoryAuthorityCutoverV2` 等 191 个名字全仓零消费方，接线时（README 写的「一致性报告 + 真机回执 + 用户签字」三者齐备之后）按宿主真要的面再开。

### 3.2 memory 的 `contract/requires.ts`：注入面

| 注入点 | 必须 | 成员 | 谁给、什么时候 |
| --- | --- | --- | --- |
| `MemoryToolContext` | 必须 | `abortSignal`、`sessionId`、`memoryScope?`、`sessionLineage?`、`memory` | 宿主每次调工具时给 |
| `MemoryToolApi`（宿主端口，← `MemoryApi`，登记为 `hostPort`，字段 `memory`） | 必须 | **6 个**：`describeBackend`、`captureEvidence`、`recall`、`getMemory`、`archiveMemory`、`getDiagnostics`（只在后端有整理管线时读 `treeVersion`） | 宿主实现（Desktop 的 `createSessionMemoryToolApi`）；删掉的 6 个（`getTreeState`、`getTreeStateAtVersion`、`verifyTreeIntegrity`、`runDream`、`setEvidenceEligibility`、`setSessionEvidenceEligibility`）没有一个工具在调，Desktop 那边跟着删（`satisfies` 会把多出来的键报成错误） |
| `MemoryDatabaseProvider`、`MemoryTreeRuntimeProviders` | 用树时必须 | `databaseProvider` | 宿主打开 SQLite 后给 |
| `MountMemoryAdapterInput` | 必须 | `backend`、`tree?`、`config`、`hostContext`、`turnContextLedgers`（新增） | 宿主组合根；**删 `store?`**：Desktop 自己解析后传 `backend`，`store` 只有 `mount.test.ts` 在用，两个互斥的口子只留一个（解析改由宿主调 `memoryStoreCapabilities.resolveAuthority`） |
| `MemoryAdapterConfigPort` | 必须 | 10 个开关读数（`isEnabled` … `isSessionRecallAllowed?`） | 宿主配置 |
| `MemoryAdapterHostContextPort` | 必须 | `resolveScope`、`turnContextScopes`、`environmentContextBlockOpenTag?` | 宿主 |
| `MemoryAdapterTreePort` | 可选 | `domain: MemoryTreeDomainApi`、`idleSignal` | 要树治理的宿主 |
| `MemoryHostIdleSignalPort`（← `HostIdleSignalPort`，加前缀） | 用树时必须 | `getIdleSeconds`、`isOnBatteryPower`、`isAppFocused` | Desktop 的 Electron 实现 |
| `MemoryHostScopeResolver` | 必须 | 函数类型 | 宿主 |
| `MemoryTurnContextLedgers`（新增） | 必须 | `append(sessionId, entry)`、`peek(sessionId, cursor)`、`clearSession(sessionId)` | 宿主传 agent 的回合上下文账本（agent 第 6 步后是根入口工厂 `createTurnContextSessionLedgers`）。这样本包对 agent 只剩写工具的 SDK 这一处依赖，Desktop 的 `memoryProductBoundary` 棘轮（记忆主干不许引 agent 根入口）也不用放宽；数据形状用 agent `./contracts` 的类型（只 import type） |
| `MemoryStoreBackend` | — | `descriptor`、`capture`、`captureBatch`、`recall`、`getItem`、`inspect`、`archive?`、`dream?`、`governSourceEligibility?`、`governEvidenceEligibility?` | 扩展点：市场装的后端实现它（同 project 把 `PatchStrategy` 放在注入面） |
| `MemoryDerivedIndexBackend`、`MemoryAuthorityEnumeration` | — | 派生索引的 6 个动词；`listAll()` | 扩展点 |
| `MemoryStoreCapabilityRegistry` | 用令牌解析时必须 | `getOptionalService(token)` | 宿主的服务表（Desktop 自己的注册表或内核 host） |
| `MemoryFilesIo` | 用文件后端时必须 | 6 个方法 | 宿主给 Node 实现或内存实现 |
| `MemoryFilesBackendOptions` | 用文件后端时必须 | `roots`（数组或函数）、`io?`、`indexFileName?`、`entriesDirectoryName?`、`now?` | 宿主；第 7 节第 6 项拍板后 `roots` 语义改为「按作用域给根」，找不到根就拒收 |
| `MemoryEmbedder`、`MemoryVectorIndexStore`、`MemoryVectorBackendOptions`、`FileVectorIndexStoreOptions` | 用向量层时必须 | — | LanceDB 插件 |
| `LayeredMemoryStoreBackendOptions` | 用叠加体时必须 | `authority`、`derived?`、`onDerivedFailure?`、`derivedCandidateFactor?`、`authoritySource?` | 宿主装配 |
| `CreateMemoryStoreKernelModuleOptions`、`ResolveMemoryStoreBackendInput` | — | — | 宿主 |

环境变量：本包一个都不读，不登记 `environmentTable`。

### 3.3 memory 的 `contract/constants.ts` 与 `utils/tuning.ts`

`contract/constants.ts`（随 `./contracts` 出包，渲染进程可用）：

| 表 | 内容 | 来源 |
| --- | --- | --- |
| `MemoryToolNames`、`MemoryToolCategoryId` | `save`/`search`/`get`/`archive` → `memory:*`；类别 `'memory'` | 工具文件、`TurnRecallCoordinator` 的 `inspect.tool`、UI 包的工具展示表（ui 不动，但以后可从这里取） |
| `MemoryBackendIds` | `tree`、`files`、`vector` | `MemoryTreeBackendId`、`MemoryFilesBackendId`、`MemoryVectorBackendId`（渲染进程 `useEmbeddingSettings.ts` 从这里取） |
| `MemoryBackendVerbs`、`RequiredAuthorityMemoryVerbs` | 6 个动词；权威层必备 4 个 | `backend/Contract.ts`；`MemoryBackendVerb` 类型改由 `typeof` 派生 |
| `MemoryScopeIds`、`MemoryScopePrefixes` | `global`、`system`；`project:`、`site:` | `GLOBAL_MEMORY_SCOPE`、`SYSTEM_MEMORY_SCOPE` 与散写的前缀 |
| `MemoryStoreCapabilityIdentity` | 命名空间 `velaros.memory.store`、缺省版本 `1.0.0` | `MemoryStoreCapability.ts` |
| `MemoryTurnContextSourceId` | `'memory.recall'` | 回合召回（写了两遍） |
| `MemoryFilesLayout` | `MEMORY.md`、`# Memory index`、`entries`、`vector-index.json` | `IndexFile.ts`、`Backend.ts`、`vector/Store.ts` |
| `MemoryEvidenceLimits` | 正文 24,000 字、标题 240 字（每个数字一句说明） | `Sanitizer.ts` 与 `memory:save` 的 schema 各写一份，收成一处 |
| `MemoryToolLimits` | 摘要 1,000、来源 240、标签 80 字 × 24 个、任务键 240、查询 500、召回条数上限 50、归档理由 500（拍板删 `reason` 后去掉） | `Memory.tool.ts` 的 schema，说明里的数字用模板字符串引它 |
| `MemoryEvidenceCategories`、`MemoryEvidenceCategoryAliases` | 11 个类别；旧别名 `session→conversation`、`user→preference`、`reference→artifact` | 工具 schema 与 `normalizeCategory` |
| `MemoryTreeStorage` | `schemaSql`（树 v1 的建表 SQL，约 320 行） | `MemoryTreeSchemaSql`（Desktop 第 1 号存储迁移拼它） |

错误码：本包只抛 core 的通用码（`VALIDATION`、`NOT_FOUND`、`UNAVAILABLE`、`INVARIANT`、`PERMISSION`），宿主也没有按码分支；第一轮不另立码表，卡片「失败语义」逐条写清哪个操作抛哪个码。v2 的 `MemoryStorageErrorCodesV2` 随 v2 留在包内。

`utils/tuning.ts` 的 `MemoryTuning`（包内可调，每项一句说明，门禁核对每项有人用）：

| 组 | 项（现值） | 现在散在哪 |
| --- | --- | --- |
| `tools` | `searchDefaultLimit` 10、`browseDefaultLimit` 20 | `Memory.tool.ts:298` |
| `capture` | `immediateDreamBatch` 25、`titleMaxChars` 72、`targetMaxChars` 240、`phaseMaxChars` 80、`keysMaxChars` 100 | `EvidenceBridge.ts` |
| `recall` | `minQueryChars` 4、`queryMaxChars` 600、`candidateLimit` 12、`maxInjectPerTurn` 3、`ledgerMaxEntries` 16、`injectedSessionsMax` 128、`awaitableTimeoutMs` 2,000、`inFlightWatchdogMs` 30,000、摘要截断 16 / 48 / 200 / 160 | `TurnRecallCoordinator.ts` |
| `dream` | `tickIntervalMs` 60,000、`idleThresholdSeconds` 300、`idleBatchSize` 400、`defaultBatchSize` 200 | `DreamScheduler.ts`、`Dream.ts` |
| `files` | `maxFullTextReadsPerRecall` 24、`defaultRecallLimit` 10、`maxRecallLimit` 100、`descriptionMaxChars` 400、`slugMaxChars` 60、`pathAllocationAttempts` 1,000、`firstLineMaxChars` 120 | `files/Backend.ts` |
| `layered` | `derivedCandidateFactor` 3、`maxDerivedCandidates` 200、`defaultRecallLimit` 10 | `Layered.ts` |
| `vector` | `embedBatchSize` 64、`defaultRecallLimit` 10、`maxRecallLimit` 200、`minimumSimilarity` 0.2、`maxEmbeddedTextChars` 4,000 | `vector/Backend.ts` |
| `tree` | `recallDefaultLimit` 12、`recallMaxLimit` 100、`likeTermsMax` 12、`topConcepts` 12、`semanticCandidates` 8、`semanticClauseChars` 420、元数据字符串 2,000 / 数组 100 / 深度 5 | `Repository.ts`、`SemanticExtraction.ts`、`Sanitizer.ts` |
| `treeV2` | `recallDefaultLimit` 3、`recallMaxLimit` 12、`maxPathNodes` 16、`checkpointInterval` 64 | `QueryFacade.ts`、`TreeProjectionIndex.ts` |

格式身份留在原处（「算法与格式里的数字就地写」）：`MemoryVectorIndexSchemaVersion`、v2 的 `MemoryAuthoritySchemaVersionV2`、`MemoryAuthorityApplicationIdV2`、`MemoryDreamPipelineVersionV2`，改成各自类的 `private static readonly` 或 utils 的规则常量。

### 3.4 knowledge 的合同（摘要）

- **provides**：`knowledgeTools`（`KnowledgeToolCollection`、`KnowledgeTool`）；`KnowledgeRuntime`（← 类 `DefaultKnowledgeRuntime` 与值别名，收到 1 个成员 `knowledgeDomainService`；原来的 `domain`、`vectorStore`、`knowledgeVectors` 删，Desktop 只存不用 `knowledgeVectors`）与工厂 `createKnowledgeRuntime`；`KnowledgeDomainApi`（← 类 `KnowledgeDomain`，6 个：`warmup`、`close`、`getDiagnostics`、`reindexKnowledge`、`ensureWorkspaceSynced`、`searchKnowledge`；第 7 个 `runStartupMaintenance` 全仓与产品零调用——注释说「启动时补建 pending/failed/outdated 索引」，实际从没人调，第 5 节 D-17，宿主接上就留、不接就删）；`KnowledgeEmbeddingClientApi`（← 类 `EmbeddingApi`，2 个：`buildEmbeddingRequest`、`parseEmbeddingResponse`）与工厂 `createKnowledgeEmbeddingClient(factory)`——Desktop 的记忆向量嵌入器要它。
- **requires**：`KnowledgeRuntimeProviders`、`KnowledgeEmbeddingConfigPort`、`KnowledgeHttpClient`、`KnowledgeDatabaseProvider`、`KnowledgeStoragePathProvider`、`KnowledgeLanceDbLoader/Module/Connection`（内联 `typeof import(...)` 改文件头 `import type`）、`KnowledgeEmbeddingRequestFactory`（← `EmbeddingRequestFactory`，加前缀）、`KnowledgeCodeIntelligenceApi`、`KnowledgeIndexingPolicy`、`KnowledgeToolContext`、宿主端口 `KnowledgeToolApi`（← `KnowledgeApi`，工具只调 `getDiagnostics`、`ensureWorkspaceSynced`、`searchKnowledge` 三个；`reindexKnowledge` 没有工具调，删）、`KnowledgeProjectApi`。
- **constants**：`KnowledgeToolNames`、`KnowledgeToolCategoryId`、`KnowledgeIndexStatuses`、`KnowledgeMatchTypes`、`KnowledgeSourceKinds`、`KnowledgeToolLimits`（来源类型 5、路径与符号提示各 20、文档 id 100、结果 20）、`KnowledgeStorageMigrations`（← `KnowledgeEmbeddingProfileIsolationMigration`，版本 3 的迁移 SQL）。注意「结果上限」现在两处不一致：工具钳到 20，领域钳到 `KnowledgeIndexConfig.MAX_SEARCH_LIMIT` 50；工具面的进常量表，领域的进 tuning 并写明两者关系。
- **tuning**：`KnowledgeTuning` ← `KnowledgeIndexConfig` 的 28 个数值（第 29 项 `TEXT_BM25_COLUMN_WEIGHTS` 是数组，属规则数据，留 `utils/query.ts`）加十来个散落的（同步 TTL 30 秒、文档 256 KB、代码文件 96 KB、扫描深度 6、代码扫描 800 个、代码候选 12、查询向量缓存 128、访问节流 60 秒、故障告警窗口 10 分钟、代码块 80 行 / 18 个符号、查询缺省 50）。

### 3.5 要删的现有导出与替代（逐符号迁移表）

memory：517 个导出名收到约 120 个（值 28 个：`memoryTools`、9 个工厂、3 个实例、15 张常量表；类型约 95 个：产品面 16、注入面 24、可移植数据约 52、常量派生的别名几个），其余约 400 个不再出包。**被用到的 95 个逐个的去向：**

| 原来（入口） | 以后（`@velaros-ai/memory` 或 `/contracts`） |
| --- | --- |
| `memoryTools`、`createMemoryRuntime`、`createMemoryFilesBackend`、`createNodeMemoryFilesIo`、`createInMemoryMemoryFilesIo`、`createMemoryVectorBackend`、`createFileVectorIndexStore`、`createLayeredMemoryStoreBackend`、`createMemoryTreeStoreBackend`、`mountMemoryAdapter` | 名字不变，从根入口取（后四个原来在 `./files`、`./vector`、`./backend`、`./adapter-kernel`） |
| `MemoryRecallItem`、`MemoryRecallOptions`、`MemoryScopeId`、`MemoryDreamRunResult`、`MemoryTreeDiagnostics`、`MemoryHostSessionSnapshot`、`MemoryHostUserMessageEvent`、`MemoryBackendDescriptor`、`MemoryBackendStats`、`MemoryFilesScopeRoot` | 名字不变，可移植数据，根入口与 `./contracts` 都有 |
| `MemoryStoreBackend`、`MemoryDerivedIndexBackend`、`LayeredMemoryStoreBackend`、`MemoryFilesIo`、`MemoryEmbedder`、`MemoryStoreCapabilityRegistry`、`MemoryStoreCapabilityService`、`MemoryTreeRuntimeProviders`、`MountMemoryAdapterInput`、`MemoryAdapterConfigPort`、`MemoryAdapterHostContextPort`、`MemoryAdapterTreePort` | 名字不变，根入口 |
| `MemoryBackendVerb` | 名字不变，改由常量表派生（`./contracts`） |
| `MemoryApi` | `MemoryToolApi`（6 个方法） |
| `MemoryDomain` | `MemoryTreeDomainApi` |
| `MemoryRuntime`（值，`instanceof`） | 只剩接口；判断实例改成判断形状 |
| `MemoryService`（类型） | `MemoryTreeServiceApi`（4 个方法） |
| `MemoryEvidenceBridge`、`MemoryTurnRecallCoordinator`（类型） | `MemoryEvidenceBridgeApi`、`MemoryTurnRecallCoordinatorApi` |
| `MemoryAdapterRuntime`（类型与类） | `MemoryAdapterApi`；`new MemoryAdapterRuntime(input)` → `mountMemoryAdapter(input)` |
| `HostIdleSignalPort` | `MemoryHostIdleSignalPort` |
| `MemoryTreeSchemaSql` | `MemoryTreeStorage.schemaSql` |
| `SYSTEM_MEMORY_SCOPE` | `MemoryScopeIds.system` |
| `buildProjectMemoryScope(root)`、`buildSiteMemoryScope(origin)`、`scopeTypeForScopeId(id)` | `memoryScopes.projectScope(root)`、`.siteScope(origin)`、`.scopeTypeOf(id)` |
| `supportsMemoryBackendVerb(b, v)`、`isMemoryDerivedIndexBackend(b)`、`resolveAuthorityEnumeration(b)` | `memoryBackends.supports(b, v)`、`.isDerivedIndex(b)`、`.authorityEnumeration(b)` |
| `memoryStoreCapabilityId(id)`、`resolveMemoryStoreBackend(input)`、`resolveMemoryDerivedIndexBackends(r, ids, v)`、`listRegisteredMemoryStoreBackends(r, ids, v)` | `memoryStoreCapabilities.capabilityId(id)`、`.resolveAuthority(input)`、`.resolveDerivedIndexes(r, ids, v)`、`.listRegistered(r, ids, v)` |
| `MemoryVectorBackendId`（`./vector`，渲染进程在用） | `MemoryBackendIds.vector`（`./contracts`） |
| `adapter.storeDescriptor`、`adapter.isDefaultStore` | `adapter.store.descriptor`、`adapter.store.descriptor.id === MemoryBackendIds.tree` |

knowledge（`@velaros-ai/memory/knowledge` → `@velaros-ai/knowledge`，`/knowledge/contracts` → `@velaros-ai/knowledge/contracts`）：`knowledgeTools`、`createKnowledgeRuntime`、`KnowledgeRuntimeProviders`、`KnowledgeEmbeddingRuntime`、`KnowledgeLanceDbModule` 与 7 个 DTO 名字不变；`KnowledgeDomain` → `KnowledgeDomainApi`；`KnowledgeVectors`（类型，Desktop 只存不用）→ 删字段；`EmbeddingRequestFactory` → `KnowledgeEmbeddingRequestFactory`；`new EmbeddingApi(factory)` → `createKnowledgeEmbeddingClient(factory)`；`KnowledgeEmbeddingProfileIsolationMigration` → `KnowledgeStorageMigrations.embeddingProfileIsolation`；`KnowledgeRuntime`（值）→ 只剩接口。仓库层测试直接用的 17 个内部件（`KnowledgeMutation`、`KnowledgeRepo`、`KnowledgeRows`、`buildDocumentRevisionKey` 等）不出包，那 3 个测试挪进 `packages/knowledge/test/` 按相对路径引。

Desktop 的连带改动（升级时一次做）：上表的 import；`SessionMemoryTools.ts` 删 6 个多余方法（顺带补 D-14 的写门）；`memoryProductBoundary.ts` 的扫描口径从「dist 子树 knowledge / adapter-kernel」改成按包（memory 允许 `@velaros-ai/kernel/contracts/abi`，与 system、project 同例；knowledge 另扫）；`rendererPortablePackageBoundary.ts` 与 `architecturePaths.mjs` 加 `@velaros-ai/knowledge`；`kernelAssembly.mjs`、`toolDescriptionBudget.mjs` 改 import；`useEmbeddingSettings.ts` 改从 `./contracts` 取常量；组合根把 agent 的回合上下文账本工厂传给 `mountMemoryAdapter`。

## 4. 工具面

本包定义 7 个模型面工具（memory 4 个、knowledge 3 个），定义都在本包；**分组、技能提示词、只读标记、可用空间、内置 mod 在 Desktop 的 `src/mods/memory/manifest.ts`**。说明长度是 `structureToolDescriptionsForCategory` 渲染后模型实际看到的字符数（`exp/dump-tools.ts` 实测）；execute 列按门禁口径数语句（含嵌套，上限 4）。

### 4.1 全部工具

| 工具 | 做什么 | schema 字段 | 说明 | execute | 挂载 | 问题 |
| --- | --- | --- | ---: | --- | --- | --- |
| `memory:save` | 写一条带来源的长期记忆（信任级封顶 `agent_derived`） | `kind`（14 值枚举，含 3 个旧别名）、`title`≤240、`content`≤24,000、`summary`≤1,000、`source`≤240、`tags`≤24×80、`workspaceRoot`、`taskKey`≤240、`privacyClass`（3 值） | 599 | **11 条** | 类别 memory、非只读、system/project/browser 三个空间、技能 `memory-continuity` | schema 裸数字 6 个；`workspaceRoot` 改不了落点；「同一来源」一句失实 |
| `memory:search` | 按当前空间召回，投影成紧凑条目 | `query`≤500、`mode`（search/browse/profile）、`limit` 1–50、`workspaceRoot`、`deep`、`categories` | 396 | **9 条** | 只读 | **6 个字段都没有说明**；`mode` 三个值没解释；缺省条数 10/20 写在 execute 里；「外加全局记忆」失实 |
| `memory:get` | 按 id 读全文与来源，过可见性读门 | `id` | 214 | **5 条** | 只读 | 文件后端的 id 可越界读（D-1） |
| `memory:archive` | 归档（退出普通召回，内容不删） | `id`、`reason`≤500 | 291 | 3 条 | 非只读 | **没有读门**、对不存在的 id 也回 `archived: true`（D-3）；`reason` 只回显；三句话讲同一件事 |
| `knowledge:diagnostics` | 看知识索引的健康读数 | 无 | 138 | 3 条 | 只读、技能 `knowledge-retrieval` | 术语（「profile 覆盖率」「保留向量状态」） |
| `knowledge:sync` | 增量同步一个工作区的文档、配置、代码知识 | `workspaceRoot`、`force` | 268 | 4 条 | 非只读 | 协议「先同步再搜」与 search 的零命中自动同步冲突；模型给什么根就扫什么根（第 7 节第 11 项） |
| `knowledge:search` | 混合检索，零命中且没建过索引时自动补同步再搜 | `query`、`workspaceRoot`、`sourceKinds`≤5、`pathHints`≤20、`symbolHints`≤20、`documentIds`≤100、`limit`（钳到 20） | 329 | **14 条** | 只读 | 裸数字 5 个、说明里写「上限 20」；结果里的 `indexIssues[].guidance` 是英文 |

### 4.2 定义放在哪、差什么

- 工具定义函数 `defineMemoryTool` 在类型文件 `Types.ts` 里（类型文件不许有值），`memoryTools` 在入口 `index.ts` 里算（入口不许有声明）；搬到 `utils/tool.ts` 与 `impl/MemoryTools.ts`。登记 `toolDefiner: 'defineMemoryTool'`、`toolsFile: 'src/impl/MemoryTools.ts'`、`hostPort: 'MemoryToolApi'`、`hostPortField: 'memory'`。knowledge 同理（`defineKnowledgeTool`、`KnowledgeToolApi`、字段 `knowledge`）。
- 4 个 execute 超门禁（save 11、search 9、get 5，knowledge:search 14）：函数体下沉到 `MemoryToolOperations` / `KnowledgeToolOperations`，execute 一行交给它。
- schema 与说明里的数字：memory 11 处、knowledge 6 处，改引 `MemoryToolLimits` / `KnowledgeToolLimits`；**做到模型看到的字节不变**，真改文案另起提交（同 system、project 的做法）。
- 能力声明 `MemoryReadCapability`、`MemoryWriteCapability`（`reason` 是英文）并进工具文件的模块级。
- 分组与挂载：system、project 都是「工具文件末尾是分组、内置 mod、内核挂载」；memory 现在一半在 Desktop（类别的 label 是英文 `Memory`、`Knowledge`，两个类别都挂在 `toolOs.domain: 'memory'` 下）。建议把类别定义与内置 mod 定义搬进各自的工具文件（空间由宿主注入，本包不认空间名），技能提示词跟着工具说明走，免得两处漂移（第 7 节第 8 项）。

### 4.3 简化候选（判据：别的工具替代得了、只剩仪式感才删；没人用过但有独特能力的不删）

7 个工具一个都不删：记忆的写、召回、按 id 读、归档各有独特能力；knowledge 的诊断给的覆盖率与向量状态别处拿不到，同步的 `force` 也是独有的。要删改的是参数：

| 工具 | 删改 | 理由 |
| --- | --- | --- |
| `memory:save`、`memory:search` | 删 `workspaceRoot` | Desktop 的工具上下文恒给 `memoryScope`（`ToolContext.ts:758` 的 getter），作用域两轴「在场即权威」，模型传什么根都改变不了写到哪、能看到什么；它只会写进证据的 `workspaceRoot`，树后端拿它给「项目」概念起名，模型传错就长出一个错的项目节点。宿主从作用域反解的根已经够用 |
| `memory:search` | 删 `mode` | browse = 不传 query，profile = `categories: ["preference","feedback","interest"]`，两个都是别的参数表达得了的仪式；删掉后 `superRefine` 也去掉。UI 包按 `args.mode` 选标题，缺席时回落「记忆召回」，不用改 UI |
| `memory:archive` | 删 `reason` | 说明自己写着「reason 只写入本次工具结果，不另建秘密日志」——只回显，纯仪式 |
| `memory:save` | `kind` 的旧别名 `session`、`user`、`reference` 不再出现在 schema（入参照收，进内核前归一） | 模型现在看到 14 个值、没有一个有说明，`user` 与 `preference`、`session` 与 `conversation` 让它二选一；宽容运动的做法是收旧值、不宣传旧值 |
| `memory:save` | `privacyClass` 待定 | 现在只落库、没有任何行为读它（树 v1 不按它过滤，文件档只写进 frontmatter）；树 v2 的披露闸门会用。倾向先从模型面拿掉（缺省按 kind 推），接线披露闸门时再开（第 7 节第 5 项） |
| `memory:save` | `tags`、`source` 保留、改说明 | 只写进记忆文件给人看，不影响召回；保留是为了人读 `.velaros/memory` 时有线索，说明写清楚这一点 |

### 4.4 提示词：冗余、冲突、失实、歧义（原文 → 改后）

1. **失实**，`memory:save` 注意：「同一来源重复提交按来源幂等，不会写出两条。」——工具从不传 `sourceId`：树后端每次都新增一条 Evidence（去重索引只管 `source_id != ''`，靠后面的 claim 稳定键合并），文件后端按「来源类型 + 标题 + 正文」哈希去重，归档后再写就出第二条（D-4）；模型还会把参数 `source`（「可选来源说明」）当成这里的「来源」。改：工具按「作用域 + 类别 + 标题 + 正文」算一个稳定 `sourceId`，两个后端都据此去重，说明改成「同一空间里标题和正文都相同的内容再写一次，不会多出一条；措辞变了就是新的一条。」
2. **失实**，`memory:search` 强制流程：「召回按当前空间作用域收敛，外加全局记忆；不跨项目/跨站点翻找。」与 `memory:get` 注意「只能读当前空间可见的记忆（本空间 + 全局）」——Desktop 从不写 `global` 作用域（共享池标的是 `system`，`FilesScopeRoots.ts` 特意不标 global），所以「外加全局记忆」在产品里从不成立，模型会以为在系统空间记下的偏好项目里也看得到。改：「只召回当前空间（当前项目、当前站点或系统空间）的记忆，别的空间的看不到。」「只能读当前空间的记忆；别的空间的 id 一律当作不存在。」要不要让偏好跨空间共享是产品问题（第 7 节第 10 项）。
3. **歧义**，`memory:search` 用法：「search 模式传 query；browse/profile 可以省略 query。」——没说 browse、profile 是什么。删 `mode` 之后改：「有明确话题就传 query；想看最近记了什么就不传 query；只看用户画像就传 categories: ["preference","feedback","interest"]。」
4. **缺说明**，`memory:search` 6 个字段一个 `describe` 都没有（同包的 save 每个都有）。补：query「要找的话题，用用户原话或关键词」、limit「默认 ${MemoryTuning.tools.searchDefaultLimit}，最多 ${MemoryToolLimits.searchResults}」、deep「为真时连已归档的一起找」、categories「只看这些类别」。
5. **冗余**，`memory:archive` 三句讲同一件事：禁止「不要把归档描述成删除——内容一个字节都还在。」注意「归档不是删除：内容仍在，deep=true 的深层召回仍能翻到。」「用户要求「彻底删掉」时如实说明当前只能归档，别承诺物理删除。」合成一句放禁止：「不要说成删除：归档后内容还在，deep=true 仍能找到；用户要彻底删除时如实说明现在只能归档。」注意改成回执说明：「回执的 archived 为 false 表示这个 id 不存在或不在当前空间，要如实告诉用户没有归档成。」
6. **误导**，`memory:save` 的 `workspaceRoot` 说明「可选工作区根；默认从当前项目空间派生。」加上示例 `{"kind":"task",…,"workspaceRoot":"/workspace/VelarOS"}`，等于教模型传一个不起作用的参数。随参数删掉；示例换成不带它的。
7. **缺值说明**，`memory:save` 的 `kind` 只有「记忆类别。」。照 `knowledge:search` 的 `sourceKinds` 写 `values`：fact 稳定事实、preference 偏好、feedback 对协作方式的反馈、procedure 做法、project 项目、task 任务、goal 目标、interest 兴趣、entity 人与事物、artifact 产出物、conversation 对话要点。
8. **冲突**，`knowledge:sync` 强制流程：「先确认 workspaceRoot；同步完成后再 knowledge:search 检索。」与 `knowledge:search` 强制流程「零命中且该工作区还没建过索引时会自动补一次增量同步再重搜……autoSync 存在而 count 仍为 0 …不要再调 knowledge:sync 重试。」前者让模型每次先同步。改 sync：「一般不用先同步：knowledge:search 零命中时会自己补一次。文件刚改过、要跳过短时缓存时再调它，并传 force=true。」
9. **冲突（在 Desktop）**，技能 `knowledge-retrieval`：「检索为空且结果提示索引尚未建立时，确认工作区根后调用一次 `knowledge:sync`，再检索一次。」同样与 search 的零命中自动同步冲突。改：「检索为空时看结果里的 autoSync：有它说明刚补过索引、确实没有匹配；没有它才考虑 knowledge:sync。」
10. **术语与中英混排**：`knowledge:diagnostics` 适合「需要确认文档总量、内容策略过期、当前 profile 覆盖率或保留向量状态。」→「要确认索引了多少文档、有没有过期或失败的、当前向量模型覆盖了多少时用。」；`knowledge:search` 摘要「搜索工作区 knowledge。」→「搜索当前工作区的文档与代码知识。」；用法「宿主未提供 active workspace root 时必须显式传 workspaceRoot。」→「没有打开的工作区时必须传 workspaceRoot。」；`limit` 说明「上限 20，超出自动钳制。」→ 模板串 `上限 ${KnowledgeToolLimits.results}，超出按上限算。`（门禁也要求说明里不写两位以上的裸数字）。
11. **误导（回合召回注入文字）**：语义派生层的命中一律标 `retrievalReason: 'deep'`，回合召回于是给每条向量命中都加一句「这是一次模糊的深层回忆；若用于回答，必须向用户说明它可能已经过时。」——新写的记忆也会被这样打上「可能过时」。改：语义命中用单独的理由（`'semantic'`，`MemoryRecallItem.retrievalReason` 联合类型加一个值），这句只给真正的深层（含归档）召回。

### 4.5 模型看得到的英文

`knowledge:search` 结果里 `indexIssues[].guidance` 的三句英文（原文见 1.8，改后如下）；采集桥写进证据正文的 `left`、`unknown`；工具说明夹的「knowledge」「profile」「TTL」「active workspace root」（见 4.4 第 10 条）。改后原文：

- `embedding-auth-invalid-issuer`：「向量服务拒绝了当前的嵌入凭据（issuer 校验没过）；请用户检查嵌入服务商与凭据后重新同步。文本检索照常可用。」
- `embedding-auth`：「嵌入鉴权失败；请用户修正嵌入服务商的凭据后重新同步。文本检索照常可用。」
- `index-error`：「这些文档的索引记着错误；结果像是过期了，就先看 knowledge:diagnostics 或重新同步这个工作区。」
- 采集桥：`left` → 「左键」、`unknown` → 「未知」（按键名这类原样保留的除外）。

## 5. 实现层缺陷

读代码时发现、并尽量复现过的缺陷。「复现」列的脚本在草稿区 `plan-memory/exp/`，只 import 源码，用内存 IO 或草稿区里自建的目录，不碰仓库。P0 = 安全或数据错误，改造前先修；P1 = 行为错误；P2 = 边界、性能与 Desktop 侧。

| # | 级 | 位置 | 现象 | 复现 | 修法 |
| --- | --- | --- | --- | --- | --- |
| D-1 | **P0** | `files/Backend.ts` 的 `parseEntryId`（:641）、`getItem`（:338）、`archive`（:394）、`loadDocument`（:543）；`IndexFile.ts` 的解析（:29-52）接受任意路径 | 条目 id 形如 `<scopeId>::<相对路径>`，相对路径直接 `io.join(根目录, …)`，不约束。**`memory:get` 传 `system::../../<任意路径>` 就能读记忆目录外的任意文件**（私钥、云凭证），经可见性读门照样放行（条目的作用域就是那个根的）；`memory:archive` 传同样的 id 会**改写任意已存在的文件**（在前面插一段 frontmatter，`.zshrc`、`settings.json` 这类直接坏掉）；**一个仓库自带 `.velaros/memory/MEMORY.md`、索引行链接到 `../../../.aws/credentials`，打开仓库聊到相关话题时回合自动召回就把凭据的第一段注进模型上下文**（项目记忆目录按设计跟着 git 走） | `exp/traversal.ts`（读到假私钥、settings.json 被改写）、`exp/traversal-index.ts`（召回摘要里出现假 AWS 密钥） | 条目路径只认 `entries/<名>.md`（不许 `..`、绝对路径、反斜杠、子目录），`parseEntryId`、索引解析、目录扫描三处用同一个判定，越界的 id 当作不存在、越界的索引行跳过并记诊断；`NodeMemoryFilesIo` 再加一道：真实路径（core 的 `resolveRealPath`）必须在根里（platform 的 `isPathTextInside`）。INV-1 |
| D-2 | **P0** | `files/Backend.ts:198` `capture` | 只有树 v1 的 `MemoryTreeDomain` 调 `sanitizeMemoryEvidenceInput`；**文件后端（出厂默认权威层）不打码、不截断、不拒空**，frontmatter 里的摘要、来源、标签也不清洗。用户在聊天里贴的 `sk-…`、`Bearer …`、私钥块原样写进 `<仓库>/.velaros/memory/entries/*.md`，Desktop 注释写明这个目录「跟着 git 走是特性，因此不补 .gitignore」 | `exp/files-bugs.ts` 第 5 段（`hasRawKey: true`） | 清洗前移：所有后端落盘前经同一道 `utils/evidence.ts`（叠加体入口或各后端 capture 入口）；INV-2 |
| D-3 | **P0** | `Memory.tool.ts:359` `memory:archive`；`files/Backend.ts:394` | 归档**不过可见性读门**（`memory:get` 有），项目会话里能归档系统池的记忆（系统根总在根列表里）；文件后端对不存在或解析不了的 id 回 `affectedEvidenceIds: [id]` 或 `[]`，工具不看，一律回 `archived: true` 和「已归档」，模型拿错 id 也告诉用户归档成了（树后端对未知 id 抛 `NOT_FOUND`，两个后端还不一致） | `exp/files-bugs.ts` 第 6 段；读门缺失看代码即可 | 工具先 `getMemory` 再过 `isVisible`，看不见与不存在一律 `NOT_FOUND`（同 `memory:get`）；文件后端对不存在的条目同样抛 `NOT_FOUND`；`affectedEvidenceIds` 为空时回执 `archived: false`。INV-4 |
| D-4 | P1 | `files/Backend.ts:515` `findPathByStableKey`、`:526` `allocatePath` | 稳定键只在索引里找，而归档已经把索引行撤了，于是**同一来源再采集会新建 `-2` 文件、以在用状态复活**。Desktop 每次保存会话状态都重放整段对话，用户归档的会话条目下一次保存就回来了 | `exp/files-bugs.ts` 第 1 段（普通召回返回 `回复风格-2.md`） | 稳定键查找覆盖条目目录（含归档）；命中归档条目时只更新内容、保持归档（归档是用户的决定，再采集不解除——第 7 节第 6 项）；INV-5 |
| D-5 | P1 | `IndexFile.ts:29` `LinkedLine`、`:55` `serializeMemoryIndex` | 名字不转义：**标题含 `]`（如「[重要] 回复风格」）或换行的条目写进索引后解析不回来**，普通召回找不到，每次再写都新建一个文件，下次重写索引时那一行被丢掉 | `exp/files-bugs.ts` 第 2 段 | 序列化时转义 `[`、`]`，换行折成空格；解析认转义 |
| D-6 | P1 | `files/Backend.ts:428` `resolveWriteRoot` | 证据的作用域找不到对应根时不拒收：`workspace` 型取「任意一个项目根」，否则回落 global 或第一个根。**`project:/other` 的证据写进当前项目 `/repo` 的目录**（跨项目污染，而且会被 `/repo` 的会话召回），`site:` 的写进系统池（此后在系统空间可见）。Desktop 在一次运行之外求根时只剩系统根（`FilesScopeRoots.ts` 注释自己承认「少给一条根不会报错，只会让那个空间的记忆静默流进别的池子」），而会话快照的保存就发生在运行之外 | `exp/files-bugs.ts` 第 8 段 | 找不到对应根就拒收（`inserted: false` 加诊断，桥记日志），不改写作用域；宿主改成按作用域给根。INV-9 |
| D-7 | P1 | `backend/Layered.ts:127` `recallSemantic`、`:275` `recallOptionsExcludeItem` | 语义通道回权威层取全文后只看 `excludeConversationObservations`（按树的谓词）与 `excludeSourceTypes`，**不看 `includeDormant`、`categories`、`excludeSessionId`、`excludeAgentConversationEchoes`**，文件档的会话条目（谓词是 `memory`）也挡不住；`rebuild` 按设计把归档条目收进索引。结果：重建派生索引后**归档的记忆回到普通召回**，回合自动召回会把会话条目、归档条目注进模型上下文；语义命中还一律标 `deep`，引出 4.4 第 11 条的误导文字 | `exp/layered-bugs.ts`（重建后普通召回出现 activation 0 的「旧偏好」；按 `categories: ['preference']` 召回仍返回会话条目） | 语义命中过与词法通道完全相同的过滤（一个函数，文件、树两个后端的词法召回也用它）；语义命中换成自己的理由；INV-7 |
| D-8 | P1 | `files/Backend.ts:284` `recall` | 候选按分排序后只读前 24 份全文，**类别过滤在读到的文档上做**。聊天采集开着时每条用户消息都是一个条目，最近 24 条全是会话，`memory:search` 的 profile 召回（或任何带 `categories` 的召回）就返回 0 条 | `exp/files-bugs.ts` 第 3 段（30 条会话之后 profile 召回 0 条） | 索引行带类别，或先按类别筛再截断；读取上限按筛过的算 |
| D-9 | P2 | `Frontmatter.ts:180` `encodeValue`、`:66` `unquote` | 按 YAML 把单引号写成 `''`，读回时不还原：标题 `#tag it's` 读回来就是 `#tag it''s`，每重写一次（归档、再采集）撇号再翻一倍；首尾是双引号的值读回来丢引号 | `exp/files-bugs.ts` 第 4 段 | `unquote` 还原 `''`；双引号值同样对称处理 |
| D-10 | P2 | `files/Backend.ts:515`；`vector/Store.ts:135` | 性能：每次写入把索引里的每一条都读一遍文件，全是同步 fs、跑在 Electron 主进程。**400 条时写 1 条读 403 个文件，重放 50 条已存在的消息读 1,375 个文件**，而 Desktop 每次保存会话状态都整段重放。`FileVectorIndexStore.upsert` 每次都把整份索引 JSON（每条向量 base64）重写一遍 | `exp/files-bugs.ts` 第 7 段 | 进程内维护「稳定键 → 路径」映射，按索引文本变化失效；向量索引写入攒批、延迟落盘 |
| D-11 | P2 | `EvidenceBridge.ts:89` 与 `:240` `toEvidence` | 环境块过滤只在 `captureUserMessage`，`captureSessionSnapshot` 不滤；文件档里同一条消息（同一个 sourceId）后到的快照会覆盖先到的过滤版。现在 Desktop 的快照取展示用的 text 块、碰巧不含冻结块，换宿主或改快照来源，R-041 的注入防线就在快照路径失守 | 看代码 | `toEvidence` 同样过滤；INV-10 |
| D-12 | P2 | `MemoryScope.ts:13` `scopeTypeForScopeId` | 除 `project:`、`site:`、`system` 外一律判 `global`，而 `global` 在可见性判据里处处可见；类型里有 `session`、`execution` 两种作用域，函数从不返回它们。宿主一旦传 `session:<id>`，这条记忆就全局可见（隔离判据失败开放） | 看代码 | 未知前缀按独立作用域（精确相等才可见），`global` 只认字面 `global` |
| D-13 | P2 | `memory-tree/Repository.ts:1236` | 树后端的召回 SQL 自己写了一份作用域条件，选定作用域是 `global` 时只返回 global 条目；单一判据对 `global` 是「全部可见」（文件、向量两档照后者）。「全仓唯一实现」在 SQL 里断了 | 看代码 | 选定 `global` 时不加作用域条件；加一条跨后端一致性测试（INV-6） |
| D-14 | P2 | Desktop `SessionMemoryTools.ts:71` | `archiveMemory` 不过 `assertAccess('write')`，会话设置「暂停保存记忆」挡不住归档 | 看代码 | 随 Desktop 升级一并改 |
| D-15 | P2 | Desktop 组合根 | `turnRecall.clearSession` 从来不调，每个会话的增量账本与注入去重表留到进程结束（去重表有 128 个会话上限，账本没有） | grep | 删会话时调它 |
| D-16 | P2 | `DreamScheduler.ts:62` `stop` | `stop()` 调 `TimerScope.dispose()`，之后 `start()` 里的 `every()` 抛 `INVARIANT`（「已释放」）；`MemoryService.warmup()` 在 `finally` 里调 `start()`，关掉后再 warmup 就是一次未处理的拒绝 | 读 core 的 `TimerScope.assertActive` | `stop` 只取消租约，释放留给真正的销毁；INV-16 |
| D-17 | P2 | knowledge `KnowledgeDomain.runStartupMaintenance` | 「启动时补建 pending / failed / outdated 文档索引」全仓与两个产品零调用，Desktop 的注释以为有；嵌入鉴权失败过的文档只能等手动重建或文件变动 | grep | 宿主在 warmup 后接上，或删掉这条路径 |
| D-18 | P2 | knowledge 工具 | 模型看得到的三句英文 guidance；结果上限工具 20、领域 50 两处出处；`knowledge:sync` 接受模型给的任意目录作根（第 7 节第 11 项） | 看代码 | 见 4.4、4.5、3.4 |
| D-19 | P2 | `memory-tree/v2/treediff-v2-probe.ts`；`docs/memory/memory-tree-spec-freeze.md:5,433` | 冻结规范写着这枚探针「由 `bun run check` 链的 `check:memory-anchors`（`scripts/checks/memoryTreeDiffProbe.mjs`）机械复跑——代码 = 规范 = 探针」，但 Platform 与 Desktop 都没有这个脚本和门（大概在拆仓时丢了）；`probe:memory` 也不跑它。TreeDiff 的排序与 canonical 化悄悄漂移，没有门拦。现在手动跑是 46/46 通过 | grep 全仓；`exp/treediff.ts` 手动跑 | 第 4 步把它挪进 `probes/tree-v2/` 时补一条 `probe:treediff-v2`（纯 TS、不要 Electron）编进 `probe:memory`，并改冻结规范里的门名 |

另记两条不算缺陷、但改造时要知道的：`files/NodeIo.ts` 的原子写只做 temp + rename、不 fsync（权威层数据），text-files 落地后改用它；树 v2 直接读 `process.platform`（ADR 0005 要求平台判断经 `@velaros-ai/platform`）。

## 6. 步骤与风险

### 6.1 总体策略

- **先修再搬，先内后外**：P0、P1 在现布局上修（改动小、好审、P0 能单独发 0.4.7）；第 2、4、5、6 步只动包内，**所有入口、导出名、模型看到的字节不变**；第 3 步只把知识库的两个入口换成新包 `@velaros-ai/knowledge`（导出名一个不变）；第 7 步一次性收口（0.5.0），第 8 步登记治理。和 project、agent 走的顺序一致。Desktop 只走发版，中间的提交不会到它手里。
- **能看进度**：第 0 步就把 memory 以 `status: 'migrating'` 登记（门禁已支持，照查照报、不计入失败），每步跑 `bun scripts/ownership/check-module-ownership.mjs --only memory` 报一次条数做燃尽；knowledge 在第 3 步建包时同样登记。现在按目标路径登记只能数出 62 条（大多是「目录不存在」这类结构问题），第 4 步搬家后数字才有意义（估算见 6.3 规模列）。
- **每一步的「全绿」口径**：
  1. `cd packages/memory && bun test test`（现 58 例；拆包后按包分开跑，两包合计只许增加）；
  2. `bun run typecheck`（全仓）与两个包各自的 `typecheck`；
  3. `bun run probe:memory`（12 个探针；树 v2 的 7 个与知识 profile 集成测试要 Electron 原生 SQLite，bun 单测跑不了树 v1/v2 的 SQLite，树相关的改动只能靠探针守）；
  4. `bun run check:memory-boundaries`（第 3 步起按新路径改写，第 8 步收成只查宿主依赖）、`bun run check:memory-knowledge-profile`、`bun run test:memory`、`bun run --cwd packages/memory test`（先 build 再跑 dist 测试）；
  5. `bun run check:module-ownership`（别的包必须一直绿）与 `--only memory` 燃尽数；
  6. `bun run check:code-style`、`bun run check:public-readiness`（测试里的假路径用 example 用户）；动了 package.json 或新包时加 `check:package-catalog`、`check:lockfile-consistency`、`check:host-contract-consumer`（打 tarball 装进隔离目录，第 3、7 步必跑）；
  7. 模型面：用 `exp/dump-tools.ts` 这样的渲染脚本把 7 个工具的说明与 JSON schema 存快照，第 2–6 步每步比对**逐字节不变**；真改文案的提交单独做、在差量报告里点名；
  8. 第 7、8 步在隔离 worktree 里跑完整 `bun run check:gates`（并行实例会把工作区弄红，照「临时索引 + 暂存集硬闸，禁 stash」的做法提交）。

### 6.2 步骤

| 步 | 做什么 | 怎样保持全绿 | 规模 |
| --- | --- | --- | --- |
| **0 准备**（不动 memory 代码） | 登记表加 memory（`status: 'migrating'`，字段按第 8 步的目标写）；agent 第 2 步已提交（`540de0e6`），本包引的 `@velaros-ai/agent/tool-contract`、`/run-context` 两个入口名字照旧，重跑一次基线（58 例）确认；给 `move-files.mjs` 加跨包搬（或第 3 步用 `git mv` 加 `debarrel.mjs imports` 修路径）；存 7 个工具的说明与 schema 快照 | 只动登记表与脚本；`check:module-ownership` 因「迁移中」不红 | 1 个共享文件、1 个脚本 |
| **1 修 P0**（入口不变，可单独发 0.4.7） | D-1 条目路径白名单 + Node IO 的根内约束；D-2 文件后端落盘前清洗；D-3 `memory:archive` 读门与如实回执（工具说明不动，差量报告点名行为变化） | 每条缺陷先写失败的测试（照 `exp/` 的复现），修完转绿；`probe:files`、`probe:vector`、`probe:store-capability`；发版夹具 `runtime.mjs` 的归档断言照旧成立 | 约 6 个源文件、8 个新用例 |
| **1b 修 P1** | D-4 归档不复活、D-5 索引转义、D-6 找不到根就拒收、D-7 语义通道同一过滤（含语义命中改理由）、D-8 先筛再截断、D-9 引号对称；每条一个提交 | 同上；D-6、D-7 改变召回与落点，差量报告点名；D-7 动了 `MemoryRecallItem.retrievalReason` 的联合类型（加一个值），是只增的契约变化 | 约 6 个源文件、12 个新用例 |
| **2 去自引用、去 barrel**（行为不变） | `bun scripts/ownership/debarrel.mjs packages/memory all`：包内经 `../index`、`./memory-tree`、`../../memory-tree` 等 barrel 的 import 改指声明文件；8 个入口改成逐个名字的显式转发；删 19 个 barrel 里不是入口的 13 个（memory 的 `memory-tree/index.ts`、`v2/index.ts`、`v2/storage/index.ts`、`tools/memory/index.ts`，知识库的 9 个） | 入口导出面逐名不变（脚本自带核对）；全绿口径 1–5 | 约 45 条 import、13 个 barrel |
| **3 拆出 knowledge 包** | 新建 `packages/knowledge`（package.json、tsconfig、README ← `docs/knowledge/README.md`、LICENSE/NOTICE），`src/knowledge/**` 42 个文件整目录搬过去（内部相对路径不变）；memory 的 3 个知识测试与 `tests/memory/maintained` 下 3 个知识测试挪进 `packages/knowledge/test/`；memory 删 `./knowledge`、`./knowledge/contracts` 两个入口，package.json 去掉 LanceDB 可选 peer 与 apache-arrow；同提交改：根 `tsconfig.json` paths、根 `package.json`（依赖、`domainPackages.memory` 加 knowledge、`test:memory`、`check:memory-knowledge-profile` 的路径）、`bun.lock`、`scripts/memory/checkProductBoundaries.mjs`（删切片规则，knowledge 与 memory 各查宿主依赖）、`knowledgeProfileIntegrationTest.mjs`、`check-host-contract-consumer.mjs` 的 `hostPackageDirectories` 加 knowledge（打包闭包按依赖自动补齐，但拆包后 knowledge 不再是 memory 的依赖，要显式列）、`package-catalog.json`、`docs/mod-dev/*` | 全绿口径 1–6；`check:host-contract-consumer` 打两个 tarball；knowledge 以「迁移中」登记 | 48 个文件搬家、约 15 处路径钉子 |
| **4 整文件搬家**（只搬不改） | `move-files.mjs` 按附录 A/B「去处」的第一项：含类的文件整个进 `impl/<域>/`，纯函数进 `utils/…`，纯类型进 `types/…`，工具文件先整个进 `impl/`，入口进 `src/exports/`（`./backend`、`./files`、`./vector`、`./adapter-kernel` 暂时平铺成 `exports/backend.ts` 等，名字一个不变），12 个探针进 `probes/`，并给没人跑的 `treediff` 探针补一条 `probe:treediff-v2` 编进 `probe:memory`（D-19）；package.json 的 exports 改指 `dist/exports/*`、`probe:*` 改指 `probes/`，`tsconfig.build.json` 去掉探针排除；同提交改 7 个 `*Probe.mjs`、`packageConsumerGate.mjs`、`packageConsumerIndependence.test.mjs`、`tests/memory/maintained/*.mjs` 的 dist 路径、根 `tsconfig.json` paths、`docs/memory/*` 与 `docs/mod-dev/*` 里的源码路径 | 全绿口径 1–6；`--only memory` 此后开始数真实条目 | memory 79 个文件、约 200 条相对 import（脚本改） |
| **5 拆混合文件、常量归位** | `move-declarations.mjs`：约 230 个类型声明进 `types/…`（v2 的 133 个进 `types/tree-v2/`）；混合文件里的模块函数进 utils（memory 约 180 个、v2 占多数）；5 个闭包工厂与模块级实例改类（`LayeredMemoryStore`、`InMemoryMemoryFilesIo`、`NodeMemoryFilesIo`、`InMemoryVectorIndexStore`、`FileVectorIndexStore`）；5 个 `static open` 改构造器；`EvidenceReplayMigration.ts` 拆两个类；无状态类改函数（`MemoryTreeRecall`、知识库 3 个）；删死代码与别名；`logRuntime.tag` → `Log.tag`；包内重复收成单源（1.9 节）；写 `contract/` 三个文件与 `utils/tuning.ts`（memory 约 45 项、knowledge 约 40 项） | 入口从新位置转发、导出名不变；数字改引常量与 tuning 后工具快照逐字节不变；全绿口径 1–5 | 两包合计约 350 个声明、350 个函数（每个补一句中文说明）、约 85 个数字 |
| **6 接口与工具文件** | 每个类 `implements` 类上方的接口（两包约 50 个接口、约 300 个成员逐个中文说明）；43 个不用 `this` 的私有方法进 utils；`impl/MemoryTools.ts` 与 `impl/MemoryToolOperations.ts`、`KnowledgeTools.ts` 与 `KnowledgeToolOperations.ts`，execute 一行交给执行类；`defineMemoryTool`、`defineKnowledgeTool` 进 `utils/tool.ts`；英文改中文（1.8 节）；**工具面删改与提示词修正各一个提交，拍板后做**（第 7 节第 4 项） | 工具快照：定义搬家的提交字节不变；删改的提交按预期变化并更新 Desktop 描述预算的基线；`memoryToolContract.test.ts`、`knowledgeSearchFailOpen.test.ts` 守行为 | 两个工具文件约 500 + 300 行 |
| **7 入口收口（0.5.0，破坏性）** | 两包都只剩 `.` 与 `./contracts`；provides 登记、实例与工厂标注公开接口；`MemoryToolApi` 12→6、`MemoryTreeServiceApi` 11→4、删 `mount` 的 `store` 口子、回合账本改注入（第 3.2 节）；树 v2 不再出包；同提交改仓内消费方：`tests/memory/consumer/package-api.ts`、两个 dist 测试、发版夹具 `consumer.ts`/`runtime.mjs`、`examples/*.ts`（改工厂）、README；把 3.5 节迁移表写进流水账「需要你看的」 | 全绿口径 1–8；`check:host-contract-consumer` 验两个包的严格 NodeNext 声明 | 入口 4 个文件重写、约 25 个仓内消费方文件 |
| **8 登记治理** | 登记表两项去掉 `migrating`：memory 填 `toolsFile: 'src/impl/MemoryTools.ts'`、`toolDefiner: 'defineMemoryTool'`、`hostPort: 'MemoryToolApi'`、`hostPortField: 'memory'`、`portable: 'memory.ts'`、`tuning: 'tuning.ts'`、`browserSafeEntries: ['contracts.ts']`、`layers`（2.3 节 6 层）；knowledge 同理；写两张 `MODULE.md`（十节；「骨干链路」逐个工具写链路，采集、召回、装配三条宿主链路照 1.2 节）、`spec/invariants.md`（memory 约 17 条、knowledge 约 8 条，见 6.4）、`spec/acceptance.test.ts`（只经根入口）；两包 `test` 脚本跑验收；`check:memory-boundaries` 收成只查宿主依赖（或并进 `check:capabilities-arch`） | `check:module-ownership` 两包零条 | 两张卡片、约 25 条不变量 |
| **9 后续**（与标准正交） | 采集桥里的空间知识交给宿主（第 7 节第 7 项）；`MemoryFilesIo` 端口异步化并改用 `@velaros-ai/text-files`（连带 D-10 性能）；D-11–D-18（D-19 在第 4 步随探针搬家补上）；Desktop 侧 D-14、D-15；树 v2 的接线与切换（另起方案） | 各自一轮、各自差量报告 | — |

### 6.3 会碰到的共享文件

`scripts/ownership/governed-modules.mjs`（第 0、3、8 步）、根 `package.json`（依赖、`velaros.domainPackages`、`test:memory`、`probe:memory`、`check:memory-*`）、根 `tsconfig.json`（paths）、`bun.lock`（新包）、`docs/generated/package-catalog.json`、`scripts/release/check-host-contract-consumer.mjs`（`hostPackageDirectories`）与 `fixtures/host-contract-consumer/*`、`docs/engineering/foundation-refactor-log.md`、`scripts/memory/**`、`tests/memory/**`、`docs/memory/*`、`docs/mod-dev/*`。memory 没有公开 API 基线（不像 agent 有 `baselines/agent/public-api.json`），版本号按约定走。Desktop 仓在升级 Platform 时改：3.5 节所列 import、`SessionMemoryTools.ts`、`arch-guard-velaros` 的三个检查、两个检查脚本、组合根。

### 6.4 不变量草案（第 8 步写进 `spec/invariants.md`）

memory：
INV-1 文件后端的条目只能是本作用域根下 `entries/` 里的 `.md`，id 与索引行越界一律当不存在（测试）；
INV-2 任何后端落盘前经同一道清洗：秘密打码、正文与标题截断、空内容拒收（测试）；
INV-3 `memory:save` 写入的证据信任级封顶 `agent_derived`，不接受模型自报的用户确认（测试）；
INV-4 `memory:get` 与 `memory:archive` 用同一条可见性判据，当前空间看不见的 id 一律 `NOT_FOUND`，不读不改（测试）；
INV-5 归档不是删除：普通召回看不到、deep 召回找得到，同一来源再采集不会让它复活（测试）；
INV-6 作用域可见性只有一个判据：文件档、树档、向量档、叠加语义通道与工具读门给出同样的裁决（测试，跨后端表驱动）；
INV-7 派生索引只存指针与向量，语义命中回权威层取全文并过与词法通道相同的过滤（测试）；
INV-8 解析权威层时跳过派生索引与缺必备动词的后端，装配时只收一个后端来源（测试）；
INV-9 写入的作用域根必须与证据的作用域一致，找不到根就拒收（测试）；
INV-10 宿主给的环境块不会以 `user_stated` 身份被采集，消息与快照两条路一致（测试）；
INV-11 回合召回不阻塞发送：可等待入口在硬预算内返回，失败、超时、并发都回空；同一记忆每会话只注入一次、每轮有上限（测试）；
INV-12 在途闩有看门狗，一次永不返回的召回不会让该会话的自动召回永久失效（测试）；
INV-13 叠加体的可选动词挂载与权威层的声明一致，缺席就不挂（测试）；
INV-14 派生索引的角色在类型上钉死为 `derived-index`（类型）；
INV-15 `./contracts` 的整条引用链不碰 Node 内置模块（门禁 `check:module-ownership`）；
INV-16 空闲整理调度器停了还能再起（测试）；
INV-17 记忆包不 import 知识包、宿主包与 Electron（门禁 `check:memory-boundaries` 收窄后）。
knowledge：搜索是只读路径、只有工具层零命中时补一次同步；绑定工作区不跨根兜底；换嵌入模型不复用旧向量（profile 隔离）；工作区条目路径都在根内；删除文档连带删向量行；嵌入配置每次向宿主要；诊断只读；guidance 为中文——约 8 条。

### 6.5 风险

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 并行实例 | agent 第 2 步正在搬 `packages/agent`；agent 第 6 步要删 `./run-context`、可能把工具契约拆成 `@velaros-ai/tool-contract`；另一个实例在抽 text-files、path-rules | memory 第 7 步排在 agent 第 6 步之后或同车；回合账本改注入后，本包对 agent 只剩工具契约一处，拆不拆包只影响 import 路径；共享文件串行改，临时索引加暂存集硬闸，禁 stash |
| 数据兼容 | D-1、D-4、D-5、D-6 的修复改变文件后端对已有数据的读法：越界索引行被跳过；带 `]` 的旧索引行可能早已在某次重写时丢了（修复只能防以后，已丢的靠目录扫描找回，可以加一次「按目录补全索引」的维护）；D-2 打码后稳定键若按清洗后的正文算，没有 sourceId 的旧条目会多出一条 | 稳定键按清洗后的正文算（聊天采集都有 sourceId，不受影响），差量报告说明；文件后端加一次性索引补全；树 v1 的数据不受影响 |
| 模型面字节漂移 | 第 5、6 步动说明、schema | 工具快照逐字节比对；真改的单独提交；Desktop 描述预算检查同步更新 |
| Desktop 边界棘轮 | `memoryProductBoundary` 按 dist 子树（`knowledge`、`adapter-kernel`）扫，第 4 步起 dist 布局变了；kernel ABI 的 import 会出现在记忆主干 | Desktop 升级时同一个提交改检查：按包扫，memory 允许 `@velaros-ai/kernel/contracts/abi`（system、project 同例），knowledge 单独一组规则 |
| 探针依赖 Electron | 树 v2 的 7 个探针与知识 profile 集成测试只能在 electron-rebuild 过的环境跑 | 动 `tree-v2/` 与 knowledge 存储的每一步都跑 `probe:memory` 与 `check:memory-knowledge-profile`；搬家步骤先 `--dry-run` |
| 发布门禁 | `packageConsumerGate.mjs` 钉 `dist/index.js`、`examples/minimal.ts`；`examples/` 用 `new` 类 | 第 4 步改 dist 路径，第 7 步改示例为工厂 |
| 工作量 | 约 130 次搬家、350 个声明、350 个函数说明、约 300 个接口成员说明、约 85 个数字 | 机械部分全走脚本（debarrel、move-files、move-declarations）；树 v2 占一半，按 `tree-v2/` 单独一批 |

## 7. 需要你拍板的项

只列产品层与设计相关的（对外契约、工具面、提示词、行为变化）；实现细节按方案自行推进。每条写了建议。

1. **知识库拆成独立包 `@velaros-ai/knowledge`**（2.1、2.8 节）。建议拆：宪章本来就说记忆与知识永不合并，两边零共享代码，门禁一个登记项装不下两套工具与端口。影响：Desktop 13 个文件的 import 从 `@velaros-ai/memory/knowledge` 改成 `@velaros-ai/knowledge`；多一个发布单元（归 `memory` 域）。
2. **入口收口与版本号**（2.6、3.5 节）。memory 8 个入口收成 `.` 与 `./contracts`，knowledge 两个；导出名从 517 个收到约 120 个，按 3.5 节迁移表逐符号替换。建议两包都发 **0.5.0**（0.x 次版本即破坏；memory 没有 API 基线门，不需要像 agent 那样上 1.0.0），knowledge 从 0.5.0 起接着 memory 的版本线。
3. **树 v2 不出包**（3.1 节）。191 个名字全仓零消费方，接线（「一致性报告 + 真机回执 + 用户签字」齐备）时按宿主真要的面再开；代码、探针、冻结规范都留着。备选：以后单独成 `@velaros-ai/memory-tree`（它与树 v1、文件、向量零耦合）。
4. **工具面删改**（4.3、4.4 节，第 6 步单独提交）：
   - a. `memory:archive` 加可见性读门、对不存在或不可见的 id 回 `NOT_FOUND`、后端没归档成时回 `archived: false`（第 1 步已按缺陷修，这里是说明文字跟上）；
   - b. 删 `memory:archive` 的 `reason`；
   - c. 删 `memory:save`、`memory:search` 的 `workspaceRoot`；
   - d. 删 `memory:search` 的 `mode`（query 可省、画像用 `categories`）；
   - e. `kind` 的三个旧别名不再出现在 schema（入参照收）；
   - f. `memory:save` 用「作用域 + 类别 + 标题 + 正文」算稳定 `sourceId`，两个后端同样去重，说明改成 4.4 第 1 条；
   - g. 改写 4.4 的 11 条提示词（含两条失实：「同一来源幂等」「外加全局记忆」）与知识库三句英文 guidance；Desktop 技能 `knowledge-retrieval` 那句同步改。
5. **`memory:save` 的 `privacyClass` 去留**（4.3 节）。现在只落库、没有行为读它。建议先从模型面拿掉（缺省按类别推），披露闸门接线时再开；保留也可以，那就在说明里写清「目前只作标记」。
6. **文件后端行为对齐**（D-2、D-4、D-6）：落盘前打码与截断（落盘内容会变）；证据的作用域找不到对应根时拒收而不是写进别的池子（宿主要按作用域给根，Desktop 在运行之外采集的项目证据以后会被拒收、而不是落进系统池——需要 Desktop 给出按会话求根的办法）；同一来源再采集不解除归档。建议三条都做。
7. **采集桥里的空间知识交给宿主**（1.5 节）：`captureComputerUseObservation`、`captureWorkspaceToolObservation` 两个入口合成一个中性的 `captureObservation({ sessionId, sourceId, kind, title, description, metadata })`，computer 工具名、project 类别 id、参数名与描述文案搬到 Desktop 的执行协调器（或各自空间包）。改宿主契约，建议放第 9 步，不和标准化混在一起。
8. **记忆 mod 定义搬进包**（4.2 节）：类别定义（label 改中文）、内置 mod 定义、两份技能提示词进各自的工具文件，可用空间由宿主注入（`createMemoryBundledModDefinition({ spaces })`）。建议做：技能文字和工具说明放一起才不会再冲突（4.4 第 9 条就是例子）。
9. **宿主端口收窄与回合账本改注入**（3.2 节）：`MemoryApi` → `MemoryToolApi` 从 12 个方法收到 6 个（Desktop 删 6 个实现）；`MemoryService` → `MemoryTreeServiceApi` 从 11 个收到 4 个；删 `mountMemoryAdapter` 的 `store` 口子；回合上下文账本由宿主注入，本包不再值导入 agent 的 `./run-context`。建议全做。
10. **产品：用户偏好要不要跨空间共享**（4.4 第 2 条）。现在偏好、反馈按空间隔离：在系统空间记下的「回复要简洁」到项目空间里召回不到，而工具说明一直写着「外加全局记忆」。两个选择：偏好与反馈类写进一个处处可见的共享池（真正的 `global`），或者维持隔离、只改说明。方案先按「只改说明」写，等你定。
11. **产品：知识库能不能索引任意目录**（D-18）。`knowledge:sync`、`knowledge:search` 收模型给的任意 `workspaceRoot`，会扫描并返回那个目录下 md/txt/json/配置/代码文件的片段，不过 system:read 那样的敏感路径审批。建议限制在宿主登记过的工作区根里（不在的报 `PERMISSION`），或者至少对非当前工作区的根走一次确认。

---

## 附录 A：memory 的 79 个源文件逐个去处

路径相对 `packages/memory/src/`；「去处」的第一项是第 4 步整文件搬家的落点，其余是第 5–7 步拆出去的部分；★ 为新建类。行数、分类来自 `census.mjs`。


#### 根与工具（8 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `Capabilities.ts` | 17 | 常量；类 —；接口 0 类型 0 函数 0 | impl/MemoryTools.ts 模块级 | 工具能力声明属于工具定义；`reason` 改中文 |
| `MemoryScope.ts` | 103 | 函数+类型；类 —；接口 3 类型 1 函数 5 | utils/scope.ts（5 函数）；types/memory.ts（`MemoryScopeId` 与三个输入形状）；contract/constants.ts（`MemoryScopeIds`、`MemoryScopePrefixes`）；impl/backends/MemoryScopes.ts ★（实例 `memoryScopes`） | 函数不出包，宿主要用的收成对外实例；修 D-12 |
| `Runtime.ts` | 43 | 单类；类 DefaultMemoryRuntime；接口 1 类型 0 函数 1 | impl/tree/MemoryTreeRuntime.ts（类 + 工厂 `createMemoryRuntime`，接口 `MemoryRuntime` 在类上方） | 值别名 `MemoryRuntime` 与重复成员 `domain` 删 |
| `Types.ts` | 133 | 函数+类型；类 —；接口 5 类型 5 函数 1 | contract/requires.ts（`MemoryToolContext`、`MemoryToolApi` ← `MemoryApi`、`MemoryDatabaseProvider`、`MemoryTreeRuntimeProviders`）；contract/provides.ts（`VelaTool`）；types/memory.ts（`MemoryBackendCapabilities`、`MemorySessionLineageContext`）；types/tool.ts（`DefineMemoryToolInput`）；utils/tool.ts（`defineMemoryTool`） | 类型文件里不许有函数；端口收窄到 6 个方法；`ToolContext` 别名删 |
| `contracts.ts` | 7 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/contracts.ts | `./contracts` = 常量表 + `types/memory.ts` |
| `index.ts` | 25 | 入口（含一个计算出的值）；类 —；接口 0 类型 0 函数 0 | exports/index.ts（重写：只转发）；`memoryTools` 的计算 → impl/MemoryTools.ts | 入口不许有声明 |
| `tools/memory/Memory.tool.ts` | 380 | 函数+类型；类 —；接口 4 类型 1 函数 4 | impl/MemoryTools.ts（4 个定义）；impl/MemoryToolOperations.ts ★（execute 函数体）；utils/tools.ts（`normalizeCategory`、`inferWorkspaceRoot`、`compactRecall`）；types/tool.ts（4 个入参）；contract/constants.ts（`MemoryToolNames`、`MemoryToolLimits`、`MemoryEvidenceCategories`） | execute 11/9/5 条超门禁；schema 裸数字 11 处；修 D-3 |
| `tools/memory/index.ts` | 2 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |

#### backend/（5 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `backend/Contract.ts` | 204 | 函数+类型；类 —；接口 4 类型 3 函数 2 | contract/requires.ts（`MemoryStoreBackend`）；types/memory.ts（descriptor、stats、role、capture 选项、`MemoryBackendAwaitable`）；contract/constants.ts（`MemoryBackendVerbs`、`RequiredAuthorityMemoryVerbs`）；utils/backends.ts（2 函数） | 后端端口是扩展点（市场后端实现它），放注入面 |
| `backend/DerivedIndex.ts` | 130 | 函数+类型；类 —；接口 4 类型 0 函数 3 | contract/requires.ts（`MemoryDerivedIndexBackend`、`MemoryAuthorityEnumeration`）；types/memory.ts（版本、重建结果）；utils/backends.ts（3 函数，`memoryBackends` 转调） | 同上 |
| `backend/Layered.ts` | 315 | 函数+类型；类 —；接口 3 类型 0 函数 3 | impl/backends/LayeredMemoryStore.ts ★（闭包对象改类，接口 `LayeredMemoryStoreBackend` 在类上方）；utils/backends.ts（`recallOptionsExcludeItem`、`interleaveById`）；types/memory.ts（`MemoryDerivedIndexFailure`）；contract/requires.ts（选项）；tuning（3 个数） | 隐形类；修 D-7 |
| `backend/TreeStoreBackend.ts` | 133 | 单类；类 MemoryTreeStoreBackend；接口 0 类型 1 函数 1 | impl/backends/MemoryTreeStoreBackend.ts；`MemoryTreeBackendId` → `MemoryBackendIds.tree`；`MemoryTreeStoreDomain`（Pick 别名）删，参数收 `MemoryTreeDomainApi` | 实现文件不许声明别的类型；模块级 descriptor 改类的 static |
| `backend/index.ts` | 37 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/backend.ts（第 4 步暂存）→ 第 7 步并进根入口 | 入口收口 |

#### files/（7 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `files/Backend.ts` | 682 | 混合；类 MemoryFilesBackend；接口 3 类型 0 函数 9 | impl/files/MemoryFilesBackend.ts（接口 `MemoryFilesBackendApi`）；utils/files/entries.ts（8 个模块函数 + `conceptTypeByCategory`）；types/files.ts（`ScoredCandidate`）；types/memory.ts（`MemoryFilesScopeRoot`）；contract/requires.ts（`MemoryFilesBackendOptions`）；constants（`MemoryBackendIds.files`、`MemoryFilesLayout`）；tuning（6 个数） | 混合文件；修 D-1、D-2、D-3、D-4、D-6、D-8、D-10 |
| `files/Frontmatter.ts` | 218 | 函数+类型；类 —；接口 2 类型 0 函数 8 | utils/files/frontmatter.ts；types/files.ts（2 个接口） | 纯函数；修 D-9 |
| `files/IndexFile.ts` | 94 | 函数+类型；类 —；接口 1 类型 0 函数 4 | utils/files/index-file.ts；types/files.ts（`MemoryIndexEntry`）；constants（`MemoryFilesLayout`） | 纯函数；修 D-5 |
| `files/Io.ts` | 78 | 函数+类型；类 —；接口 2 类型 0 函数 1 | contract/requires.ts（`MemoryFilesIo`）；impl/files/InMemoryMemoryFilesIo.ts ★（接口 `InMemoryMemoryFilesIoApi`） | 闭包改类 |
| `files/NodeIo.ts` | 54 | 纯函数；类 —；接口 0 类型 0 函数 1 | impl/files/NodeMemoryFilesIo.ts ★ | 模块级对象实例改类；写入改用 text-files；根内约束（D-1） |
| `files/index.ts` | 28 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/files.ts（第 4 步暂存）→ 第 7 步并进根入口 | 入口收口 |
| `files/memory-files-probe.ts` | 341 | 探针；类 —；接口 0 类型 0 函数 9 | probes/memory-files.probe.ts | `src` 下只放五个目录 |

#### vector/（5 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `vector/Backend.ts` | 363 | 混合；类 MemoryVectorBackend；接口 2 类型 0 函数 8 | impl/vector/MemoryVectorBackend.ts；utils/vector.ts（7 个模块函数，`matchesScope` 改直接调 utils/scope.ts）；types/vector.ts（`PendingIndexEntry`）；contract/requires.ts（选项）；tuning（5 个数）；`MemoryVectorIndexSchemaVersion` → 类的 `private static readonly` | 混合文件；格式版本就地写 |
| `vector/Contract.ts` | 62 | 函数+类型；类 —；接口 3 类型 0 函数 0 | contract/requires.ts（`MemoryEmbedder`、`MemoryVectorIndexStore`）；types/memory.ts（`MemoryVectorIndexRecord`）；constants（`MemoryBackendIds.vector`） | 端口进注入面；id 进常量表（渲染进程要用） |
| `vector/Store.ts` | 183 | 函数+类型；类 —；接口 3 类型 0 函数 5 | impl/vector/InMemoryVectorIndexStore.ts ★、impl/vector/FileVectorIndexStore.ts ★；utils/vector.ts（编解码、解析）；types/vector.ts（落盘形状）；contract/requires.ts（`FileVectorIndexStoreOptions`）；constants（`MemoryFilesLayout.vectorIndexFileName`） | 两个闭包改类；D-10 攒批 |
| `vector/index.ts` | 26 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/vector.ts（第 4 步暂存）→ 第 7 步并进根入口 | 入口收口 |
| `vector/memory-vector-probe.ts` | 383 | 探针；类 —；接口 0 类型 0 函数 16 | probes/memory-vector.probe.ts | 同上 |

#### memory-tree/（v1）（10 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `memory-tree/Dream.ts` | 971 | 混合；类 MemoryDream；接口 3 类型 0 函数 11 | impl/tree/MemoryDream.ts；utils/tree/dream-rules.ts（11 个模块函数，`sha256`、`truncate`、`readMetadataString`、`normalizeIdentityText` 并进 utils/text.ts）；types/tree.ts（3 个内部类型）；tuning（批量 200）；日志改 `Log.tag` | 混合文件；包内重复收单源 |
| `memory-tree/Recall.ts` | 22 | 单类；类 MemoryTreeRecall；接口 0 类型 0 函数 0 | 并进 impl/tree/MemoryTreeDomain.ts（`recall` 方法） | 一个方法的薄壳 |
| `memory-tree/Repository.ts` | 1829 | 混合；类 MemoryTreeRepository；接口 10 类型 1 函数 7 | impl/tree/MemoryTreeRepository.ts；utils/tree/repository-rows.ts（6 个映射函数、`readIdentitySupportingConceptIds`、谓词名单）；types/tree.ts（10 个行类型）；tuning（12、100、12）；修 D-13 | 混合文件 |
| `memory-tree/Sanitizer.ts` | 103 | 纯函数；类 —；接口 0 类型 0 函数 5 | utils/evidence.ts（文件后端也经它，D-2）；constants（`MemoryEvidenceLimits`）；tuning（元数据 2000/100/5） | 纯函数；上限与工具 schema 收单源 |
| `memory-tree/SemanticExtraction.ts` | 185 | 函数+类型；类 —；接口 2 类型 1 函数 9 | utils/tree/semantic-extraction.ts；types/tree.ts；tuning（8、420） | 纯函数 |
| `memory-tree/Service.ts` | 148 | 单类；类 MemoryTreeDomain；接口 0 类型 0 函数 0 | impl/tree/MemoryTreeDomain.ts（接口 `MemoryTreeDomainApi`，provides 登记） | 单类 |
| `memory-tree/TreeProjection.ts` | 159 | 函数+类型；类 —；接口 0 类型 2 函数 8 | utils/tree/tree-projection.ts；types/tree.ts（`MemoryTreeDiffOp`、`MemoryTreeDiffNode`） | 纯函数 |
| `memory-tree/Types.ts` | 246 | 纯类型；类 —；接口 17 类型 7 函数 0 | types/memory.ts（可移植文件的主体） | 已经不 import、不带函数，正合规 |
| `memory-tree/index.ts` | 8 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel（把树 v2 整个挂上根入口的就是它） |
| `memory-tree/schema/MemoryTreeSchema.ts` | 330 | 函数+类型；类 —；接口 0 类型 1 函数 1 | contract/constants.ts（`MemoryTreeStorage.schemaSql`）；`applyMemoryTreeSchema` 删（零调用） | 宿主迁移拼这段 SQL，是对外约定 |

#### memory-tree/v2/（34 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `memory-tree/v2/AuthorityDatabase.ts` | 326 | 混合；类 MemoryAuthorityDatabaseV2；接口 4 类型 1 函数 8 | impl/tree-v2/MemoryAuthorityDatabaseV2.ts（`static open` 改构造器）；utils/tree-v2/authority-database.ts（7 函数）；types/tree-v2/authority.ts | 混合文件；公开静态 |
| `memory-tree/v2/AuthoritySchema.ts` | 701 | 函数+类型；类 —；接口 0 类型 1 函数 12 | utils/tree-v2/authority-schema.ts（SQL 与三个 apply 函数、列名单）；版本号、应用 id 进类或规则常量 | 规则数据留 utils；v2 不出包，不进合同 |
| `memory-tree/v2/DiffChain.ts` | 663 | 混合；类 MemoryTreeReplayResultValueV2；接口 5 类型 2 函数 28 | utils/tree-v2/diff-chain.ts（28 函数）；impl/tree-v2/MemoryTreeReplayV2.ts ★（正反向回放与可持久化品牌，`WeakSet` 取代值类的 `instanceof`）；types/tree-v2/diff.ts | 混合文件；值类改纯数据 |
| `memory-tree/v2/DreamRuns.ts` | 494 | 混合；类 MemoryDreamRunCoordinatorV2；接口 9 类型 1 函数 6 | impl/tree-v2/MemoryDreamRunCoordinatorV2.ts；utils/tree-v2/dream-runs.ts；types/tree-v2/dream.ts；`registerBlobV2`、`assert*` 并进 utils/tree-v2/checks.ts | 混合文件；包内重复 |
| `memory-tree/v2/ErasureSaga.ts` | 1121 | 混合；类 MemoryErasureServiceV2；接口 8 类型 1 函数 24 | impl/tree-v2/MemoryErasureServiceV2.ts；utils/tree-v2/erasure.ts（24 函数）；types/tree-v2/erasure.ts | 混合文件 |
| `memory-tree/v2/EvidenceIngest.ts` | 442 | 混合；类 MemoryEvidenceIngestServiceV2；接口 4 类型 4 函数 5 | impl/tree-v2/MemoryEvidenceIngestServiceV2.ts；utils/tree-v2/evidence-ingest.ts；types/tree-v2/evidence.ts | 混合文件 |
| `memory-tree/v2/EvidenceReplayMigration.ts` | 1122 | 多类；类 LegacyMemoryEvidenceSqliteReaderV2, MemoryEvidenceReplayMigrationV2；接口 11 类型 1 函数 17 | impl/tree-v2/LegacyMemoryEvidenceSqliteReaderV2.ts、impl/tree-v2/MemoryEvidenceReplayMigrationV2.ts；utils/tree-v2/evidence-replay.ts（17 函数）；types/tree-v2/evidence.ts | 一个文件两个类；公开静态 |
| `memory-tree/v2/IdentityKeys.ts` | 308 | 混合；类 MemoryIdentityKeyServiceV2；接口 5 类型 1 函数 10 | impl/tree-v2/MemoryIdentityKeyServiceV2.ts；utils/tree-v2/identity-keys.ts；types/tree-v2/evidence.ts | 混合文件；`normalizeIdentityTextV2` 与 v1 那份并一 |
| `memory-tree/v2/MeaningCuration.ts` | 1377 | 混合；类 MemoryMeaningCurationServiceV2；接口 19 类型 3 函数 13 | impl/tree-v2/MemoryMeaningCurationServiceV2.ts；utils/tree-v2/meaning-curation.ts；types/tree-v2/meaning.ts | 混合文件（1,377 行，最大） |
| `memory-tree/v2/QueryFacade.ts` | 621 | 混合；类 MemoryQueryFacadeV2；接口 11 类型 2 函数 10 | impl/tree-v2/MemoryQueryFacadeV2.ts；utils/tree-v2/query.ts；types/tree-v2/query.ts；tuning（3、12、16） | 混合文件 |
| `memory-tree/v2/SystemRuntime.ts` | 133 | 单类；类 MemorySystemRuntimeV2；接口 2 类型 0 函数 1 | impl/tree-v2/MemorySystemRuntimeV2.ts（`static open` 与 `openMemorySystemRuntimeV2` 合成构造器）；types/tree-v2/store.ts | 公开静态 |
| `memory-tree/v2/TreeManifest.ts` | 203 | 函数+类型；类 —；接口 3 类型 0 函数 11 | utils/tree-v2/tree-manifest.ts；types/tree-v2/store.ts | 纯函数 |
| `memory-tree/v2/TreeProjectionIndex.ts` | 197 | 混合；类 MemoryTreeProjectionIndexV2；接口 4 类型 0 函数 3 | impl/tree-v2/MemoryTreeProjectionIndexV2.ts；utils/tree-v2/tree-store.ts；types/tree-v2/store.ts；tuning（检查点间隔 64） | 混合文件 |
| `memory-tree/v2/TreeStore.ts` | 1011 | 混合；类 MemoryTreeStoreV2；接口 13 类型 1 函数 14 | impl/tree-v2/MemoryTreeStoreV2.ts（`static open` 改构造器）；utils/tree-v2/tree-store.ts（14 函数）；types/tree-v2/store.ts | 混合文件；公开静态 |
| `memory-tree/v2/authority-v2-probe.ts` | 526 | 探针；类 —；接口 0 类型 0 函数 16 | probes/tree-v2/authority.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/erasure-saga-v2-probe.ts` | 347 | 探针；类 —；接口 0 类型 0 函数 8 | probes/tree-v2/erasure-saga.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/evidence-replay-v2-probe.ts` | 575 | 探针；类 —；接口 0 类型 0 函数 10 | probes/tree-v2/evidence-replay.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/index.ts` | 16 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `memory-tree/v2/ingest-dream-v2-probe.ts` | 444 | 探针；类 —；接口 0 类型 0 函数 9 | probes/tree-v2/ingest-dream.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/meaning-curation-v2-probe.ts` | 520 | 探针；类 —；接口 0 类型 0 函数 7 | probes/tree-v2/meaning-curation.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/query-runtime-v2-probe.ts` | 280 | 探针；类 —；接口 0 类型 0 函数 4 | probes/tree-v2/query-runtime.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/storage/AtomicFile.ts` | 101 | 函数+类型；类 —；接口 1 类型 0 函数 4 | utils/tree-v2/storage/atomic-file.ts；types/tree-v2/storage.ts（钩子）；`process.platform` 改经 platform | 纯函数；与 text-files 的原子写并存（v2 要崩溃注入钩子） |
| `memory-tree/v2/storage/BlobStore.ts` | 130 | 混合；类 MemoryBlobStoreV2；接口 0 类型 0 函数 2 | impl/tree-v2/storage/MemoryBlobStoreV2.ts；utils/tree-v2/storage/blob-id.ts | 混合文件 |
| `memory-tree/v2/storage/ContentKeyService.ts` | 290 | 混合；类 ContentKeyServiceV2；接口 4 类型 0 函数 7 | impl/tree-v2/storage/ContentKeyServiceV2.ts；utils/tree-v2/storage/content-key.ts；types/tree-v2/storage.ts | 混合文件 |
| `memory-tree/v2/storage/ErrorCodes.ts` | 30 | 函数+类型；类 —；接口 0 类型 1 函数 0 | utils/tree-v2/storage/error-codes.ts（码表）；types/tree-v2/storage.ts（派生类型） | v2 不出包，码表不进合同 |
| `memory-tree/v2/storage/GenerationPointer.ts` | 93 | 函数+类型；类 —；接口 1 类型 0 函数 3 | utils/tree-v2/storage/generation-pointer.ts；types/tree-v2/storage.ts | 纯函数 |
| `memory-tree/v2/storage/IndexGenerationStore.ts` | 256 | 函数+类型；类 —；接口 2 类型 0 函数 6 | utils/tree-v2/storage/index-generation.ts；types/tree-v2/storage.ts | 纯函数 |
| `memory-tree/v2/storage/Keyring.ts` | 543 | 混合；类 MemoryKeyringStoreV2；接口 5 类型 0 函数 10 | impl/tree-v2/storage/MemoryKeyringStoreV2.ts（`static open` 改构造器）；utils/tree-v2/storage/keyring.ts；types/tree-v2/storage.ts | 混合文件；公开静态 |
| `memory-tree/v2/storage/PhysicalRoots.ts` | 157 | 函数+类型；类 —；接口 2 类型 0 函数 5 | utils/tree-v2/storage/physical-roots.ts；types/tree-v2/storage.ts | 纯函数 |
| `memory-tree/v2/storage/WrappingRoot.ts` | 69 | 函数+类型；类 —；接口 1 类型 0 函数 5 | utils/tree-v2/storage/wrapping-root.ts；types/tree-v2/storage.ts | 纯函数 |
| `memory-tree/v2/storage/index.ts` | 10 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `memory-tree/v2/storage/storage-v2-probe.ts` | 312 | 探针；类 —；接口 0 类型 0 函数 11 | probes/tree-v2/storage.probe.ts | 同上 |
| `memory-tree/v2/tree-store-v2-probe.ts` | 528 | 探针；类 —；接口 0 类型 0 函数 13 | probes/tree-v2/tree-store.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |
| `memory-tree/v2/treediff-v2-probe.ts` | 314 | 探针；类 —；接口 2 类型 0 函数 2 | probes/tree-v2/treediff.probe.ts | 探针移出 src；`scripts/memory/checks/*Probe.mjs` 改路径 |

#### adapter-kernel/（10 个文件）

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `adapter-kernel/DreamScheduler.ts` | 110 | 单类；类 MemoryDreamScheduler；接口 1 类型 0 函数 0 | impl/host/MemoryDreamScheduler.ts；types/host.ts（选项）；tuning（3 个数） | 单类；修 D-16 |
| `adapter-kernel/EvidenceBridge.ts` | 370 | 单类；类 MemoryEvidenceBridge；接口 4 类型 0 函数 0 | impl/host/MemoryEvidenceBridge.ts；utils/capture.ts（3 个无 this 私有方法与描述拼装）；types/memory.ts（三个观察入参加 Memory 前缀）；types/host.ts（选项）；tuning（25、72、240、80、100） | 单类；空间知识见 1.5；修 D-11 |
| `adapter-kernel/HostContracts.ts` | 47 | 纯类型；类 —；接口 5 类型 2 函数 0 | types/memory.ts（宿主事件数据）；contract/requires.ts（`MemoryHostScopeResolver`） | 纯类型；函数类型不可移植 |
| `adapter-kernel/HostSignals.ts` | 16 | 纯类型；类 —；接口 1 类型 0 函数 0 | contract/requires.ts（`MemoryHostIdleSignalPort`） | 注入端口 |
| `adapter-kernel/MemoryStoreCapability.ts` | 180 | 函数+类型；类 —；接口 4 类型 0 函数 6 | impl/host/MemoryStoreCapabilities.ts ★（6 个函数收成类，实例 `memoryStoreCapabilities`）；constants（`MemoryStoreCapabilityIdentity`）；contract/requires.ts（注册表、两个选项）；contract/provides.ts（`MemoryStoreCapabilityService`） | 函数不出包；英文报错改中文 |
| `adapter-kernel/Service.ts` | 116 | 单类；类 MemoryService；接口 1 类型 0 函数 0 | impl/host/MemoryTreeService.ts（改名；接口 `MemoryTreeServiceApi` 收到 4 个方法）；types/host.ts（选项） | 7 个转发零调用 |
| `adapter-kernel/TurnRecallCoordinator.ts` | 331 | 单类；类 MemoryTurnRecallCoordinator；接口 4 类型 0 函数 0 | impl/host/MemoryTurnRecallCoordinator.ts；utils/recall.ts（`formatSummary`、`truncate`、候选过滤）；types/memory.ts（输入、结果）；contract/provides.ts（`MemoryTurnContextDeltaSource`）；contract/requires.ts（`MemoryTurnContextLedgers`，宿主注入账本）；tuning（8 个数 + 4 个截断长度）；constants（`MemoryTurnContextSourceId`、`MemoryToolNames.get`） | 去掉对 agent `./run-context` 的值依赖 |
| `adapter-kernel/index.ts` | 57 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/adapter-kernel.ts（第 4 步暂存）→ 第 7 步并进根入口 | 入口收口 |
| `adapter-kernel/memory-store-capability-probe.ts` | 343 | 探针；类 —；接口 1 类型 0 函数 10 | probes/memory-store-capability.probe.ts | 探针移出 src |
| `adapter-kernel/mount.ts` | 182 | 单类；类 MemoryAdapterRuntime；接口 5 类型 1 函数 1 | impl/host/MemoryAdapterRuntime.ts（类 + 工厂 `mountMemoryAdapter`，接口 `MemoryAdapterApi`）；contract/requires.ts（配置、宿主上下文、树三个端口与 `MountMemoryAdapterInput`；`MemoryAdapterStorePort` 删） | 端口进注入面；3 条英文报错改中文；`MemoryAdapterMount` 别名删 |

## 附录 B：knowledge 的 42 个源文件逐个去处

路径相对 `packages/memory/src/`，去处相对新包 `packages/knowledge/src/`。第 3 步整目录搬（`src/knowledge/x` → `packages/knowledge/src/x`），第 4 步起按下表。

| 文件 | 行 | 现状 | 去处 | 理由 |
| --- | ---: | --- | --- | --- |
| `knowledge/Capabilities.ts` | 17 | 常量；类 —；接口 0 类型 0 函数 0 | impl/KnowledgeTools.ts 模块级 | 工具能力声明 |
| `knowledge/Constants.ts` | 52 | 常量；类 —；接口 0 类型 0 函数 0 | contract/constants.ts（`KnowledgeIndexStatuses`、`KnowledgeMatchTypes`）；utils/tuning.ts（`KnowledgeIndexConfig` 的 28 个数）；utils/query.ts（BM25 列权重数组） | 常量分四处 |
| `knowledge/KnowledgeContext.ts` | 44 | 单类；类 KnowledgeContext；接口 0 类型 0 函数 0 | 删 | 死代码：全仓与两个产品零引用 |
| `knowledge/Runtime.ts` | 110 | 单类；类 DefaultKnowledgeRuntime；接口 1 类型 0 函数 1 | impl/KnowledgeRuntime.ts（类 + 工厂；接口 `KnowledgeRuntime` 收到 1 个成员） | 值别名与重复成员删 |
| `knowledge/Types.ts` | 299 | 函数+类型；类 —；接口 25 类型 8 函数 1 | contract/requires.ts（运行时 providers、嵌入配置、HTTP、LanceDB、代码智能、索引策略、工具上下文与端口 `KnowledgeToolApi`）；types/host.ts、types/code.ts（数据）；types/tool.ts；utils/tool.ts（`defineKnowledgeTool`） | 类型文件里不许有函数；内联 import 类型改文件头 |
| `knowledge/VectorFailureLog.ts` | 85 | 混合；类 VectorFailureMonitor；接口 3 类型 0 函数 2 | impl/storage/VectorFailureMonitor.ts；utils/embedding.ts（2 函数）；tuning（窗口） | 混合文件 |
| `knowledge/contracts.ts` | 7 | 入口/转发；类 —；接口 0 类型 0 函数 0 | exports/contracts.ts |  |
| `knowledge/embedding/EmbeddingApi.ts` | 115 | 单类；类 EmbeddingApi；接口 2 类型 0 函数 0 | impl/storage/KnowledgeEmbeddingClient.ts（对外工厂 `createKnowledgeEmbeddingClient`） | Desktop 记忆向量嵌入器要它 |
| `knowledge/embedding/Embeddings.ts` | 161 | 单类；类 Embeddings；接口 2 类型 0 函数 0 | impl/storage/KnowledgeEmbeddings.ts；tuning（128） | 单类 |
| `knowledge/embedding/index.ts` | 4 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/index.ts` | 54 | 入口（含一个计算出的值）；类 —；接口 0 类型 0 函数 0 | exports/index.ts（重写）；`knowledgeTools` 的计算 → impl/KnowledgeTools.ts；9 个别名删 | 入口不许有声明 |
| `knowledge/knowledge/domain/Chunks.ts` | 329 | 单类；类 KnowledgeChunks；接口 2 类型 0 函数 0 | utils/chunks.ts（无状态类改函数）；tuning（80、18） | 无状态类 |
| `knowledge/knowledge/domain/CodeHelper.ts` | 334 | 函数+类型；类 —；接口 1 类型 0 函数 14 | utils/code.ts；`isCodeFile` 删 | 纯函数；死函数 |
| `knowledge/knowledge/domain/Maintenance.ts` | 141 | 单类；类 KnowledgeMaintenance；接口 1 类型 0 函数 0 | impl/domain/KnowledgeMaintenance.ts | 单类；D-17 |
| `knowledge/knowledge/domain/Mutation.ts` | 303 | 单类；类 KnowledgeMutation；接口 0 类型 0 函数 0 | impl/domain/KnowledgeMutation.ts；2 个无 this 私有方法 → utils | 单类 |
| `knowledge/knowledge/domain/Query.ts` | 356 | 单类；类 KnowledgeQuery；接口 0 类型 0 函数 0 | impl/domain/KnowledgeQuery.ts；4 个无 this 私有方法 → utils/query.ts；tuning（节流 60 秒） | 单类 |
| `knowledge/knowledge/domain/QueryHelper.ts` | 244 | 混合；类 KnowledgeQueryHelper；接口 2 类型 0 函数 11 | utils/query.ts；`KnowledgeQueryHelper`（@deprecated 壳）删 | 纯函数；死代码 |
| `knowledge/knowledge/domain/Service.ts` | 83 | 单类；类 KnowledgeDomain；接口 0 类型 0 函数 0 | impl/domain/KnowledgeDomain.ts（接口 `KnowledgeDomainApi`，provides 登记） | 单类 |
| `knowledge/knowledge/domain/Types.ts` | 147 | 纯类型；类 —；接口 15 类型 5 函数 0 | types/knowledge.ts（可移植） | 只从常量表 import type，正合规 |
| `knowledge/knowledge/domain/index.ts` | 42 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/knowledge/ingestion/Ingestion.ts` | 500 | 单类；类 KnowledgeIngestion；接口 1 类型 1 函数 0 | impl/domain/KnowledgeIngestion.ts；3 个无 this 私有方法 → utils；tuning（TTL） | 单类 |
| `knowledge/knowledge/ingestion/PathPolicy.ts` | 54 | 函数+类型；类 —；接口 1 类型 0 函数 4 | utils/paths.ts（改用 platform 的 `relativePathTextInside`） | 跨包重复 |
| `knowledge/knowledge/ingestion/WorkspaceStore.ts` | 925 | 单类；类 KnowledgeWorkspace；接口 8 类型 0 函数 0 | impl/domain/KnowledgeWorkspace.ts；14 个无 this 私有方法与名单 → utils/workspace.ts；types/ingestion.ts；tuning（5 个数） | 单类，最多无 this 私有方法 |
| `knowledge/knowledge/ingestion/index.ts` | 12 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/knowledge/storage/EmbeddingProfileIsolationMigration.ts` | 73 | 常量；类 —；接口 0 类型 0 函数 0 | contract/constants.ts（`KnowledgeStorageMigrations.embeddingProfileIsolation`） | Desktop 迁移拼它，是对外约定 |
| `knowledge/knowledge/storage/Repository.ts` | 743 | 单类；类 KnowledgeRepo；接口 1 类型 0 函数 0 | impl/storage/KnowledgeRepository.ts（← `KnowledgeRepo`）；tuning（50） | 单类 |
| `knowledge/knowledge/storage/RepositoryRows.ts` | 221 | 单类；类 KnowledgeRows；接口 7 类型 0 函数 0 | utils/rows.ts（无状态类改函数）；types/storage.ts（7 个行类型） | 无状态类 |
| `knowledge/knowledge/storage/VectorQuery.ts` | 111 | 单类；类 KnowledgeVectorQuery；接口 2 类型 0 函数 0 | utils/vector-query.ts（无状态类改函数）；types/storage.ts | 无状态类 |
| `knowledge/knowledge/storage/Vectors.ts` | 374 | 单类；类 KnowledgeVectors；接口 1 类型 0 函数 0 | impl/storage/KnowledgeVectors.ts；2 个无 this 私有方法 → utils | 单类 |
| `knowledge/knowledge/storage/index.ts` | 22 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/shared/index.ts` | 4 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/shared/indexing/Indexing.ts` | 76 | 函数+类型；类 —；接口 3 类型 0 函数 4 | utils/indexing.ts；types/storage.ts | 纯函数 |
| `knowledge/shared/indexing/index.ts` | 2 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/shared/query/HybridQuery.ts` | 38 | 函数+类型；类 —；接口 1 类型 0 函数 1 | utils/query.ts | 纯函数 |
| `knowledge/shared/query/index.ts` | 2 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/shared/vector/VectorStats.ts` | 43 | 函数+类型；类 —；接口 3 类型 0 函数 1 | utils/vector-stats.ts；types/storage.ts | 纯函数 |
| `knowledge/shared/vector/index.ts` | 2 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/tools/knowledge/IndexIssueSummary.ts` | 69 | 函数+类型；类 —；接口 1 类型 0 函数 2 | utils/index-issues.ts；types/tool.ts | guidance 改中文 |
| `knowledge/tools/knowledge/Knowledge.tool.ts` | 262 | 常量；类 —；接口 0 类型 0 函数 0 | impl/KnowledgeTools.ts；impl/KnowledgeToolOperations.ts ★（search 的 14 条语句） | execute 超门禁；裸数字 6 处 |
| `knowledge/tools/knowledge/index.ts` | 2 | 入口/转发；类 —；接口 0 类型 0 函数 0 | 删 | 中间 barrel |
| `knowledge/tools/knowledge/schema.ts` | 6 | 常量；类 —；接口 0 类型 0 函数 0 | impl/KnowledgeTools.ts 模块级（`knowledgeSourceKindSchema`，值来自常量表 `KnowledgeSourceKinds`） | 一行 schema |
| `knowledge/tools/knowledge/workspace.ts` | 20 | 纯函数；类 —；接口 0 类型 0 函数 1 | utils/tools.ts | 纯函数 |

## 附录 C：数字从哪来

草稿区 `plan-memory/` 下，全部只读（只 import 源码或读文件；实验目录建在草稿区里）：

| 脚本 | 做什么 | 产物 |
| --- | --- | --- |
| `census.mjs` | 逐文件数顶层声明（类、是否 implements、公开静态、不用 this 的私有方法、接口、类型、函数、常量、模块级 let、Node import），给出分类 | `census.json` |
| `inventory.mjs` | 用类型检查器列 8 个入口导出的每个名字、解析到的声明文件与值/类型 | `exports.json` |
| `consumers.mjs` | 扫 Platform（`packages/*` 除本包、`tests/`、`scripts/`、`products/`）与 Desktop、Workbench、Termel、Extension、Cloud 对 `@velaros-ai/memory*` 的 import，逐名记消费文件 | `consumers.json`、`consumers.txt` |
| `whatif.mjs` | 按门禁判据（数字缺省值、英文文字、类的公开成员与无 this 私有方法）估算搬家后的问题量 | `whatif-english.txt`、`whatif-numbers.txt` |
| `layers2.mjs` | 按 2.3 节的层给现有文件定层，用类型检查器解析每个 import 的名字，数跨层的值引用 | 控制台输出（零处上行） |
| `deadcode.mjs` | 找导出了、但全仓与产品零引用的名字 | 控制台输出 |
| `gate/check.mjs` | 门禁副本（只改仓库根路径与登记表），把 memory 以「迁移中」登记后 `--only memory`；另一份 `check-k.mjs` 把知识库工具文件当工具文件登记 | `gate/baseline.txt` |
| `exp/dump-tools.ts` | 从 HEAD 的源码（`git archive` 到草稿区）渲染 7 个工具的说明与 JSON schema | `tools-dump.json` |
| `exp/files-bugs.ts` | 文件后端 8 段复现（D-2、D-3、D-4、D-5、D-6、D-8、D-9、D-10），内存 IO | 控制台输出 |
| `exp/layered-bugs.ts` | 文件权威层 + 向量派生层（假嵌入）复现 D-7 | 控制台输出 |
| `exp/traversal.ts`、`exp/traversal-index.ts` | 在草稿区自建的目录里复现 D-1（越界读、越界改写、恶意索引行被自动召回） | 控制台输出 |
| `appendix.py` | 按手写去处表生成附录 A、B，并核对 121 个源文件每个都有去处 | `appendix.md` |
