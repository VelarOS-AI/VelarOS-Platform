# @velaros-ai/knowledge 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 门禁：`bun run check:module-ownership`（本模块零条）。
>
> 0.6.0 是一次**破坏性**发布：类与工具函数不再出包，对外只剩两个工厂、常量表与接口；
> 逐符号去向见 `docs/engineering/refactor-plans/knowledge-migration.md`。之后三个工具挪进 velar，成了代码面的 `velar:knowledge`。

## 这是什么

**工作区资料与代码的知识库**：把一个工作区里的文件增量摄取、分块，建 SQLite 全文索引与 LanceDB 向量索引，
提供混合检索、索引诊断与显式重建。

它不是工具：模型面是 `@velaros-ai/velar/knowledge` 的 `velar:knowledge`（search、sync、diagnostics），
宿主拿本包的领域门面实现那边的空间端口。

它**不拥有跨会话长期记忆，也不拥有 MemoryDream**——那些是 `@velaros-ai/memory` 的事。
「记忆与知识永不合并」是域宪章级的判决：两边的生命周期、权威源、隐私含义都不一样，
现在连包也是两个，代码上零共享、互不 import。

`workspaceRoot` 在这里只是调用方给的**隔离键 + 文件根**，不代表本包依赖任何 Workspace 实现。

## 提供什么

两个入口，对应 `package.json` 的 `exports`：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主（Desktop 主进程） | 运行时与嵌入客户端两个工厂、常量表、产品面与注入面的全部接口 |
| `./contracts` | 任何进程，含渲染进程与 IPC 契约 | **浏览器安全的纯类型** Knowledge DTO（运行时 JavaScript 为空） |

### 导出的值

| 分组 | 名字 |
| --- | --- |
| 工厂 | `createKnowledgeRuntime`、`createKnowledgeEmbeddingClient` |
| 常量表 | `KnowledgeSourceKinds`、`KnowledgeIndexStatuses`、`KnowledgeMatchTypes`、`KnowledgeIndexConfig`、`KnowledgeEmbeddingProfileIsolationMigration` |

类一个都不出包：领域门面、分块、行映射、召回拼装、向量查询、嵌入服务与向量告警都是运行时自己装好的零件，
装配者不需要认识它们；工具函数（索引哈希、代码扫描、混合排序、向量统计）同理。

### 产品面接口（`contract/provides.ts` 登记，定义在各自的类上方）

`KnowledgeRuntimeApi`、`KnowledgeDomainApi`、`KnowledgeVectorsApi`、`KnowledgeEmbeddingClientApi`。

### 注入面接口（`contract/requires.ts`）

`KnowledgeRuntimeProviders` 把下面这些合成一份——
`KnowledgeDatabaseProvider`（关系库连接）、`KnowledgeStoragePathProvider`（向量库路径）、
`KnowledgeEmbeddingConfigPort`（**已经解析好**的 provider / model / profile）、
`KnowledgeEmbeddingRequestFactory` 与 `KnowledgeHttpClient`（嵌入协议与网络）、
可选的 `KnowledgeLanceDbLoader`（连带 `KnowledgeLanceDbModule`、`KnowledgeLanceDbConnection`）、
`KnowledgeCodeIntelligenceApi`（代码智能）与 `KnowledgeIndexingPolicy`（可见性策略）。

`velar:knowledge` 的空间端口上三个知识方法（`getDiagnostics`、`ensureWorkspaceSynced`、`searchKnowledge`）就是 `KnowledgeDomainApi`
的这三个，宿主把 `knowledgeDomainService` 直接转过去；两边形状由 `tests/capabilities/knowledge-port-conformance.test.ts` 核对。

## 骨干链路

领域门面 `KnowledgeDomainApi` 是入口；工作区根由调用方给定（模型面那边由空间决定），本包只把它当隔离键与文件根。

| 动作 | 链路 |
| --- | --- |
| 同步 | `ensureWorkspaceSynced(root, { force })` → 短时 TTL 内且没 force 就交回一份空变更结果 → 摄入层列根内文件 → 按内容哈希判断能不能复用已有索引 → 变了的重新分块、嵌入、写关系行与向量行 → 清理已删除或不可见的旧记录 |
| 检索 | `searchKnowledge(query, options)`：纯读路径，不同步、不重建——全文候选与向量候选并行，再按混合评分与新鲜度融合；零命中时补同步是模型面那一层的事 |
| 诊断 | `getDiagnostics()`：文档总量、各索引状态、内容策略过期、当前 profile 覆盖率、保留向量状态、各工作区最近同步时刻；只读 |
| 显式重建 | `KnowledgeDomain.reindexKnowledge(options)` 只为**当前** profile 写新索引；旧 profile 与旧 revision 的数据保留但不可见，失败逐项报在 `KnowledgeReindexResult.failures` 里 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、`Log`）。
- `better-sqlite3`（**连接由宿主打开与关闭**，本包只用类型与已给的连接）。
- `@lancedb/lancedb` 是**可选 peer**：装了才有向量通道，只用它的类型。
- Node 内置：`node:crypto`、`node:fs/promises`、`node:path`。`./contracts` 的整条引用链不碰它们。
- 不读环境变量，不去发现 Desktop / Workbench / Workspace，不 import `@velaros-ai/memory`（门禁 `check:memory-boundaries` 守着）。

## 状态归谁

一个数据目录或租户一个 `KnowledgeRuntime`，状态全在实例上：
`KnowledgeIngestion` 记同步态与短时 TTL、`KnowledgeQuery` 记访问节流表、`KnowledgeVectors` 记表缓存、
`KnowledgeEmbeddings` 记查询向量的 LRU、`VectorFailureMonitor` 记故障抑制窗口（**不同实例之间不共享**）。
没有模块级可变状态。索引本身住在宿主给的 SQLite 与 LanceDB 目录里。

## 生命周期

启动 `warmup()`，退出 `close()`。数据库连接由宿主开、由宿主关，本包不创建隐藏的全局锁；
同一份文档的并发写入应由宿主按 `workspaceRoot + path` 串行化，**搜索可以并发**。

## 失败语义

- 入参非法、未配置嵌入、找不到文档、存储出错一律抛 `@velaros-ai/core/error` 的 `AppError`，**按 `code` 分支，不要拿中文 message 判断**。
- 向量通道出问题时在可安全降级的前提下写诊断并回落到全文检索，而不是让整个查询不可用。
- 显式重建的失败逐项报告，不整批回滚。

## 不变量

共 4 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排；INV-1、INV-2、INV-7 是工具那一层的承诺，
随工具搬到 `velar:knowledge`（那边的 INV-1 到 INV-3）。
按检验方式：测试 3 条、文字 1 条。未验证 1 条（INV-5 要 SQLite 与 LanceDB 的原生依赖，收口那一轮补）。

## 非目标

- 不是工具：模型面在 `velar:knowledge`，入参核对、零命中补同步、结果投影都在那边。
- 不做长期记忆：证据、Dream、记忆树、召回注入都在 `@velaros-ai/memory`。
- 不挑嵌入模型、不读模型环境变量、不管凭据：宿主解析好了再经端口注入。
- 不拥有数据库连接与向量库目录：打开、事务调度、关闭都归宿主。
- 不认识「聊天会话」「项目空间」：工作区根是调用方给的隔离键。
- 不做权限与审批：路径能不能碰、要不要问用户是各空间自己的事。

## 结构

```text
src/
  contract/      对外合同三件套
    provides.ts    产品面：登记四个类上方接口（运行时、领域门面、向量表、嵌入客户端）
    requires.ts    注入面：11 个宿主端口
    constants.ts   约定的常量表：来源类型、索引状态、命中类型、索引参数、存储迁移
  types/         只放类型，按域分文件
    knowledge.ts   可移植数据（随 ./contracts 出包）
    host.ts        嵌入运行时、嵌入请求、日志口
    code.ts        代码智能的节点、边、子图与请求
    storage.ts     SQLite 行、向量行、profile 身份、检索候选
    ingestion.ts   工作区文件快照、候选、路径平台与目录读取口
  impl/          实现：一个类一个文件，文件名即类名
    KnowledgeRuntime.ts         对象图与工厂 createKnowledgeRuntime
    domain/                     门面、查询、写入、维护、摄入、工作区、分块、召回拼装、评分门面
    storage/                    关系仓、行映射、向量表、向量查询、嵌入服务、嵌入客户端、故障抑制器
  utils/         纯工具函数，按类别分文件
    tuning.ts      可调参数表 KnowledgeTuning
    code.ts chunks.ts query.ts indexing.ts vector-stats.ts paths.ts workspace.ts rows.ts vector-query.ts embedding.ts
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
    index.ts       根入口（`.`）
    contracts.ts   可移植数据入口（`./contracts`）
  velaros-globals.d.ts
spec/                 不变量登记与验收测试
test/                 实现细节测试与发布入口消费测试
examples/minimal.ts   随包发布，发布门禁用 NodeNext 编译
```

**分层**（登记在 `scripts/ownership/governed-modules.mjs`，上层可以引下层与同层，下层不许引上层）：
`KnowledgeRuntime.ts` → `domain/` → `storage/`；utils 在所有层下面。
