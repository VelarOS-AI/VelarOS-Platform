# @velaros-ai/knowledge 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 门禁：`bun run check:module-ownership`。
>
> **本模块正在按仓库标准改造中**（登记表里 `status: 'migrating'`）：源码目录还是从 `@velaros-ai/memory/knowledge`
> 整体搬过来的原样，五个目录（`contract/ types/ impl/ utils/ exports/`）、类上方接口、可调参数表与工具执行类
> 在收口那一轮落地（方案 `docs/engineering/refactor-plans/memory.md` §2.7、附录 B）。
> 这一版卡片如实写现在的形状，不写还没做到的。

## 这是什么

**工作区资料与代码的知识库**：把一个工作区里的文件增量摄取、分块，建 SQLite 全文索引与 LanceDB 向量索引，
提供混合检索、索引诊断与显式重建，外加三个模型面工具 `knowledge:diagnostics / sync / search`。

它**不拥有跨会话长期记忆，也不拥有 MemoryDream**——那些是 `@velaros-ai/memory` 的事。
「记忆与知识永不合并」是域宪章级的判决：两边的生命周期、权威源、隐私含义都不一样，
现在连包也是两个，代码上零共享、互不 import。

`workspaceRoot` 在这里只是调用方给的**隔离键 + 文件根**，不代表本包依赖任何 Workspace 实现。

## 提供什么

两个入口，对应 `package.json` 的 `exports`：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主（Desktop 主进程） | 运行时、领域门面、嵌入客户端、存储、三个工具与全部注入端口 |
| `./contracts` | 任何进程，含渲染进程与 IPC 契约 | **浏览器安全的纯类型** Knowledge DTO（运行时 JavaScript 为空） |

主要对外的值：`knowledgeTools`（三个工具）、`createKnowledgeRuntime` 与 `KnowledgeRuntime`、
`KnowledgeDomain`（同步 / 搜索 / 诊断 / 重建的门面）、`EmbeddingApi` 与 `Embeddings`、
`KnowledgeVectors`、`VectorFailureMonitor`、`KnowledgeEmbeddingProfileIsolationMigration`（宿主存储迁移拼它）。

注入端口：`KnowledgeRuntimeProviders` 把下面这些合成一份——
`KnowledgeDatabaseProvider`（关系库连接）、`KnowledgeStoragePathProvider`（向量库路径）、
`KnowledgeEmbeddingConfigPort`（**已经解析好**的 provider / model / profile）、
`EmbeddingRequestFactory` 与 `KnowledgeHttpClient`（嵌入协议与网络）、
可选的 `KnowledgeCodeIntelligenceApi`（代码智能）与 `KnowledgeIndexingPolicy`（可见性策略）。
工具经上下文里的 `ctx.knowledge`（`KnowledgeApi`）调宿主。

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| `knowledge:sync` | 解析工作区根（入参或宿主当前激活的）→ `ctx.knowledge.ensureWorkspaceSynced(root, { force })` → 摄入层列根内文件 → 按内容哈希判断能不能复用已有索引 → 变了的重新分块、嵌入、写关系行与向量行 → 清理已删除或不可见的旧记录 |
| `knowledge:search` | 解析工作区根 → `searchKnowledge(query, options)`：全文候选与向量候选并行，再按混合评分融合 → **零命中**时补一次 `ensureWorkspaceSynced` 再重搜一次，回执里写明同步跑过 → 把索引问题汇总成 `indexIssues` |
| `knowledge:diagnostics` | `ctx.knowledge.getDiagnostics()` 原样透传：文档总量、内容策略过期、当前 profile 覆盖率、保留向量状态；只读 |
| 显式重建 | `reindexKnowledge(options)` 只为**当前** profile 写新索引；旧 profile 与旧 revision 的数据保留但不可见，失败逐项报在 `KnowledgeReindexResult.failures` 里 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、`logRuntime`）；`@velaros-ai/agent/tool-contract` 是 peer，只用来写工具。
- `better-sqlite3`（**连接由宿主打开与关闭**，本包只用类型与已给的连接）、`zod`（工具入参 schema）。
- `@lancedb/lancedb` 是**可选 peer**：装了才有向量通道，只用它的类型。
- Node 内置：`node:crypto`、`node:fs`、`node:fs/promises`、`node:path`。`./contracts` 的整条引用链不碰它们。
- 不读环境变量，不去发现 Desktop / Workbench / Workspace，不 import `@velaros-ai/memory`（门禁 `check:memory-boundaries` 守着）。

## 状态归谁

一个数据目录或租户一个 `KnowledgeRuntime`，状态全在实例上：
`KnowledgeIngestion` 记同步态与短时 TTL、`KnowledgeQuery` 记访问节流表、`KnowledgeVectors` 记表缓存、
`Embeddings` 记查询向量的 LRU、`VectorFailureMonitor` 记故障抑制窗口（**不同实例之间不共享**）。
没有模块级可变状态。索引本身住在宿主给的 SQLite 与 LanceDB 目录里。

## 生命周期

启动 `warmup()`，退出 `close()`。数据库连接由宿主开、由宿主关，本包不创建隐藏的全局锁；
同一份文档的并发写入应由宿主按 `workspaceRoot + path` 串行化，**搜索可以并发**。

## 失败语义

- 入参非法、未配置嵌入、找不到文档、存储出错一律抛 `@velaros-ai/core/error` 的 `AppError`，**按 `code` 分支，不要拿中文 message 判断**。
- 向量通道出问题时在可安全降级的前提下写诊断并回落到全文检索，而不是让整个查询不可用。
- `knowledge:search` 的自动同步失败不改写搜索的成败——搜索本身已经成功了。
- 显式重建的失败逐项报告，不整批回滚。

## 不变量

共 7 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 6 条、文字 1 条。未验证 1 条（INV-5 要 SQLite 与 LanceDB 的原生依赖，收口那一轮补）。

## 非目标

- 不做长期记忆：证据、Dream、记忆树、召回注入都在 `@velaros-ai/memory`。
- 不挑嵌入模型、不读模型环境变量、不管凭据：宿主解析好了再经端口注入。
- 不拥有数据库连接与向量库目录：打开、事务调度、关闭都归宿主。
- 不认识「聊天会话」「项目空间」：工作区根是调用方给的隔离键。
- 不做权限与审批：路径能不能碰、要不要问用户是各空间自己的事。

## 结构

```text
src/
  index.ts            根入口（逐名转发 + 算出 knowledgeTools）
  contracts.ts        可移植数据入口（只 export type）
  Types.ts            注入端口、工具上下文与 defineKnowledgeTool
  Constants.ts        索引状态、命中类型与索引参数表
  Capabilities.ts     两份工具能力声明
  Runtime.ts          DefaultKnowledgeRuntime 与工厂
  VectorFailureLog.ts 向量故障抑制器
  embedding/          嵌入请求客户端（EmbeddingApi）与嵌入服务（Embeddings）
  knowledge/domain/   领域门面、查询、写入、维护、分块、代码智能、DTO
  knowledge/ingestion/摄入、路径策略、工作区扫描
  knowledge/storage/  关系仓、行映射、向量表与向量查询、profile 隔离迁移
  shared/             索引复用判定、混合评分、向量统计
  tools/knowledge/    三个工具的定义与执行、索引问题汇总
spec/                 不变量登记与验收测试
test/                 实现细节测试与发布入口消费测试
examples/minimal.ts   随包发布，发布门禁用 NodeNext 编译
```

**改造欠账**（收口那一轮做，见方案附录 B）：五个目录与分层登记、每个类的上方接口、
`utils/tuning.ts` 收拢约 40 个数字、无状态类改函数（`KnowledgeRows`、`KnowledgeVectorQuery`、`KnowledgeChunks`）、
删死代码（`KnowledgeContext`、`KnowledgeQueryHelper`、`isCodeFile`）与 9 个类别名、
`knowledge:search` 三句英文 `guidance` 改中文、`knowledge:sync` 的任意 `workspaceRoot` 是否限制在宿主登记过的根里。
