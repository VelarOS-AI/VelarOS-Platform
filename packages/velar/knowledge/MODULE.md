# @velaros-ai/velar/knowledge 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/knowledge.d.ts`（由 `@AgentView` 从 `KnowledgeOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/KnowledgeOperations.ts` 类上方的接口，再看 `contract/` 的三个文件；知识库本身从 `impl/KnowledgeRuntime.ts` 与 `impl/domain/KnowledgeDomain.ts` 读起。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`、`bun run check:memory-boundaries`。

## 这是什么

**工作区资料与代码的知识库**，连同它对模型的那一面。模型面是代码面 `velar:knowledge` 的三个操作——`search`（全文加语义的混合检索）、
`sync`（把工作区增量同步进索引）、`diagnostics`（看索引健康）；底下是知识库本身：把一个工作区里的文件增量摄取、分块，
建 SQLite 全文索引与 LanceDB 向量索引，提供混合检索、索引诊断与显式重建。原来的 `@velaros-ai/knowledge` 整包并进了这里。

**零命中替模型补一次同步。**「这个工作区里真没有」和「索引压根没建过」交回来都是零条，模型分不出来。所以零命中时补一次增量同步，
补进了内容就重搜一次，结果里的 `autoSync` 如实说明；它出现而 `count` 仍为 0，就是真没有。有命中时检索是纯读的，不写任何东西。

**嵌入 profile 隔离是知识库最重要的设计。** profile 身份恒为 `provider + model + dimensions`，查询还额外绑定当前内容 revision：
换模型只是切换活动 profile，不删除、不改写、不自动重建历史向量；只有显式重建才为当前 profile 写新索引，旧的保留但不可见。

它**不拥有跨会话长期记忆，也不拥有 MemoryDream**——那些是 `velar:memory` 的事。「记忆与知识永不合并」是域宪章级的判决：
两边的生命周期、权威源、隐私含义都不一样，两个单元代码上零共享、互不 import。

`workspaceRoot` 在这里只是调用方给的**隔离键 + 文件根**，不代表本单元依赖任何 Workspace 实现；模型面那边由空间决定落在哪个根。

## 提供什么

两个入口，对应包清单 `exports` 里的 `./knowledge` 与 `./knowledge/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./knowledge` | Node 宿主（Desktop 主进程） | 三个操作、运行时与嵌入客户端两个工厂、常量表、产品面与注入面的全部接口 |
| `./knowledge/contracts` | 任何进程，含浏览器、渲染进程与 IPC 契约 | 常量表、**浏览器安全的纯类型** Knowledge 数据（含模型面的入参与回执）、`VelarKnowledgeModule` |

`./knowledge/contracts` 不加载 SQLite、LanceDB、Apache Arrow、嵌入请求或索引实现。**不要深层导入 `dist/**`，只走这两个入口。**

### 导出的值

| 分组 | 名字 |
| --- | --- |
| 模型面 | `knowledgeOperations`（代码面 `knowledge` 命名空间的三个操作）、`VelarKnowledgeModule`（生成的合同 `contract/surface.ts`：模块名、放出去的方法、完整声明——与 `baselines/code-surface/knowledge.d.ts` 同一份——与代码模版；空间挂这件能力时交给代码面的门） |
| 工厂 | `createKnowledgeRuntime`、`createKnowledgeEmbeddingClient` |
| 常量表 | `KnowledgeSourceKinds`、`KnowledgeSearchLimits`（写进声明给模型看的上限）、`KnowledgeIndexStatuses`、`KnowledgeMatchTypes`、`KnowledgeIndexConfig`、`KnowledgeEmbeddingProfileIsolationMigration` |

类一个都不出单元：领域门面、分块、行映射、召回拼装、向量查询、嵌入服务与向量告警都是运行时自己装好的零件，
装配者不需要认识它们；工具函数（索引哈希、代码扫描、混合排序、向量统计）同理。

### 产品面接口（`contract/provides.ts` 登记，定义在各自的类上方）

`KnowledgeOperationsApi`、`KnowledgeRuntimeApi`、`KnowledgeDomainApi`、`KnowledgeVectorsApi`、`KnowledgeEmbeddingClientApi`。

### 注入面接口（`contract/requires.ts`）

- **调用上下文** `KnowledgeOperationContext`：空间每次分发 `knowledge` 命名空间的调用时装好——取消信号与空间端口 `KnowledgeSpacePort`。
  端口的三个知识方法（`getDiagnostics`、`ensureWorkspaceSynced`、`searchKnowledge`）就是领域门面 `KnowledgeDomainApi` 的那三个，
  宿主把 `createKnowledgeRuntime(...).knowledgeDomainService` 直接转过去；`resolveWorkspace` 是空间自己的决定
  （项目空间给项目根；没有默认工作区的空间在没给时抛 `VALIDATION`）。
- **运行时的端口** `KnowledgeRuntimeProviders` 把这些合成一份：`KnowledgeDatabaseProvider`（关系库连接）、`KnowledgeStoragePathProvider`（向量库路径）、
  `KnowledgeEmbeddingConfigPort`（**已经解析好**的 provider / model / profile）、`KnowledgeEmbeddingRequestFactory` 与 `KnowledgeHttpClient`（嵌入协议与网络）、
  可选的 `KnowledgeLanceDbLoader`（向量插件）、`KnowledgeCodeIntelligenceApi`（代码智能）与 `KnowledgeIndexingPolicy`（可见性策略）。
- **向量插件的端口**是本单元自己的形状，只写真用到的操作，LanceDB 模块结构上满足它们：`KnowledgeLanceDbModule`（连库与三种索引构造器）、
  `KnowledgeLanceDbConnection`、`KnowledgeLanceDbTable`、`KnowledgeLanceDbMergeInsert`、`KnowledgeLanceDbVectorQuery`、`KnowledgeLanceDbSchema`、
  `KnowledgeLanceDbIndexOptions`。声明里不引插件的类型：它是可选 peer，没装插件的宿主照样能严格编译本单元。

**宿主怎么挂**：`createKnowledgeRuntime(providers)` 造一份知识库并 `warmup()`；空间的端口转给它的 `knowledgeDomainService`，
三个操作挂到 `knowledgeOperations` 上，门那边交 `VelarKnowledgeModule`。空间端口怎么接看 `spec/support.ts`；运行时怎么装看发版夹具
`scripts/release/fixtures/host-contract-consumer/`（按发布的包严格编译并实跑）。

## 骨干链路

模型面的每个操作顺序都固定：先查取消、再核对入参、再定工作区、最后做事——入参错了一步都不做。三个操作都在 `KnowledgeOperations.ts`。

| 操作或动作 | 链路 |
| --- | --- |
| `search` | 查取消 → `searchInput`：query 非空（去掉首尾空白）、来源类型只认常量表、提示与文档 id 不超上限、limit 缺省 8、最多 50 → `ctx.knowledge.resolveWorkspace` → `searchKnowledge` → 零命中时 `ensureWorkspaceSynced` 补一次（失败只是没有 autoSync），补进了内容才重搜一次 → `projectHit` 投影每条命中（`utils/mapper.ts`）→ `summarizeIndexIssues` 把命中里的索引错误按原因归类 |
| `sync` | 查取消 → `syncInput`：核对工作区与 force → `resolveWorkspace` → `ensureWorkspaceSynced(root, { force })` → 交回同步的计数 |
| `diagnostics` | 查取消 → `getDiagnostics` → `projectHealth`：计数原样，文件索引、向量库、嵌入运行时各取模型用得上的那一项 |
| 同步（领域） | `ensureWorkspaceSynced(root, { force })` → 短时 TTL 内且没 force 就交回一份空变更结果 → 摄入层列根内文件 → 按内容哈希判断能不能复用已有索引 → 变了的重新分块、嵌入、写关系行与向量行 → 清理已删除或不可见的旧记录 |
| 检索（领域） | `searchKnowledge(query, options)`：纯读路径，不同步、不重建——全文候选与向量候选并行，再按混合评分与新鲜度融合 |
| 诊断（领域） | `getDiagnostics()`：文档总量、各索引状态、内容策略过期、当前 profile 覆盖率、保留向量状态、各工作区最近同步时刻；只读 |
| 显式重建 | `KnowledgeDomain.reindexKnowledge(options)` 只为**当前** profile 写新索引；旧 profile 与旧 revision 的数据保留但不可见，失败逐项报在 `KnowledgeReindexResult.failures` 里。这是设置页的入口，不在模型面上 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`isEmpty`、`AppError`、`Log`）。只在验收里用 `@velaros-ai/code-surface`：跑端到端的程序、给代码模版做类型检查。
- `better-sqlite3`（**连接由宿主打开与关闭**，本单元只用类型与已给的连接）。
- `@lancedb/lancedb` 是**可选 peer**：装了才有向量通道，只用它的类型。
- Node 内置：`node:crypto`、`node:fs/promises`、`node:path`。`./knowledge/contracts` 的整条引用链不碰它们。
- 不读环境变量，不去发现 Desktop / Workbench / Workspace，不 import `velar:memory` 那个单元（门禁 `check:memory-boundaries` 守着）。

## 状态归谁

- 一个数据目录或租户一个 `KnowledgeRuntime`，状态全在实例上：`KnowledgeIngestion` 记同步态与短时 TTL、`KnowledgeQuery` 记访问节流表、
  `KnowledgeVectors` 记表缓存、`KnowledgeEmbeddings` 记查询向量的 LRU、`VectorFailureMonitor` 记故障抑制窗口（**不同实例之间不共享**）。
- 没有模块级可变状态。索引本身住在宿主给的 SQLite 与 LanceDB 目录里。
- 三个操作无状态：每次调用核对、交给端口、投影，不留任何东西。

## 生命周期

启动 `warmup()`，退出 `close()`。数据库连接由宿主开、由宿主关，本单元不创建隐藏的全局锁；
同一份文档的并发写入应由宿主按 `workspaceRoot + path` 串行化，**搜索可以并发**。三个操作没有需要释放的东西。

## 失败语义

- 模型面的入参不合法（query 空、来源类型不认、条数超上限、limit 不是 1 到上限的整数、workspaceRoot 不是非空文字、force 不是布尔）：`VALIDATION`，端口一次都不调。
- 空间没有默认工作区、调用又没给 workspaceRoot：端口的 `resolveWorkspace` 抛 `VALIDATION`，message 说要给 workspaceRoot。
- 零命中时补的那次同步失败：不改写检索的成败，检索照常交回，只是没有 `autoSync`。
- 命中里记着的索引错误不是失败：按原因归类进 `indexIssues`，`actionable` 的（嵌入凭据坏了这类）附上该让用户做什么。
- 知识库的失败（入参非法、未配置嵌入、找不到文档、存储出错）一律抛 `@velaros-ai/core/error` 的 `AppError`，**按 `code` 分支，不要拿中文 message 判断**；
  代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。
- 向量通道出问题时在可安全降级的前提下写诊断并回落到全文检索，而不是让整个查询不可用。
- 显式重建的失败逐项报告，不整批回滚。

## 不变量

共 13 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排：INV-1 到 INV-7 是知识库与检索语义，INV-8 起是模型面。
按检验方式：测试 11 条、门禁 1 条、文字 1 条。未验证 1 条（INV-5 要 SQLite 与 LanceDB 的原生依赖，收口那一轮补）。

## 非目标

- 不做长期记忆：证据、Dream、记忆树、召回注入都在 `velar:memory`。
- 不挑嵌入模型、不读模型环境变量、不管凭据：宿主解析好了再经端口注入。
- 不拥有数据库连接与向量库目录：打开、事务调度、关闭都归宿主。
- 不认识「聊天会话」「项目空间」：工作区根是调用方给的隔离键。
- 不设确认闸（ADR 0009）：同步只改知识库自己的索引，不碰用户的文件。
- 不在模型面上暴露重建：显式重建是设置页的入口，模型要的「刚改过、马上搜到」由 `sync({ force: true })` 覆盖。
- 不读文件、不找代码符号：知道路径就读文件，符号与引用用代码能力，这里找的是「不知道在哪」的知识。

## 结构

```text
knowledge/
  contract/      对外合同三件套：provides.ts 登记五个类上方接口；requires.ts 是调用上下文、空间端口与运行时的端口；
                 constants.ts 是来源类型、检索上限、索引状态、命中类型、索引参数、存储迁移；surface.ts 是生成的模型面
  types/         只放类型，按域分文件：knowledge.ts 可移植（含模型面的入参与回执），host.ts 嵌入运行时与请求，code.ts 代码智能，
                 storage.ts SQLite 行、向量行与 profile 身份，ingestion.ts 工作区快照与候选，search.ts 入参核对与索引问题归类的中间形状
  impl/          实现：一个类一个文件，文件名即类名
    KnowledgeOperations.ts    velar:knowledge 的三个操作
    KnowledgeRuntime.ts       对象图与工厂 createKnowledgeRuntime
    domain/                   门面、查询、写入、维护、摄入、工作区、分块、召回拼装、评分门面
    storage/                  关系仓、行映射、向量表、向量查询、嵌入服务、嵌入客户端、故障抑制器
  utils/         纯工具函数，按类别分文件：input.ts（入参核对）、mapper.ts（投影成模型面的形状）、index-issues.ts（索引问题归类）、
                 tuning.ts（可调参数表 KnowledgeTuning），以及 code、chunks、query、indexing、vector-stats、paths、workspace、rows、vector-query、embedding
  index.ts       `./knowledge` 入口，只转发
  contracts.ts   `./knowledge/contracts` 入口，只转发
  template.js    代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/          不变量登记、验收测试、共用的假知识库与模型程序跑法
  test/          实现细节测试（操作、摄入、嵌入 profile、代码提取、注入边界、单独加载、构建产物消费）与代码模版逐个函数跑通；
                 probes/ 是要 Electron 原生 SQLite 与真 LanceDB 的向量 profile 集成测试（`bun run check:memory-knowledge-profile`）
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`KnowledgeOperations.ts` → `KnowledgeRuntime.ts` → `domain/` → `storage/`；utils 在所有层下面。操作只经端口碰知识库，不 import 运行时。
