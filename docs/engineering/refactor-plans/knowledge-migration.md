# `@velaros-ai/knowledge` 0.5.0 → 0.6.0 迁移表

这是一次**破坏性**发布：入口数量不变（`.` 与 `./contracts` 本来就是收口后的形状），但根入口
**85 个导出名下线、7 个名字是新的**。类一个都不出包，工具函数一个都不出包。

- 判断口径：消费点 = 直接 `import … from '@velaros-ai/knowledge*'`（Desktop 现在写的还是旧路径
  `@velaros-ai/memory/knowledge`，拆包时就该改，见 `foundation-pending-decisions.md` 的 X3）的源文件数；
  注释与文档不计。
- 仓内消费点**本轮已全部改完**（三个包内测试与发版夹具 `tests/memory/consumer/package-api.ts`）。
- 产品仓的调用点**本轮不改**，只列进第 4 节。Workbench、Termel、Extension 零引用。

改造方案见 `memory.md`（§2.7 knowledge 包、§3.4 合同摘要、§3.5 迁移表）；仓库标准见
`docs/architecture/module-ownership.md`。

---

## 1. 入口前后对照

| 入口 | 变化 | 内容 |
| --- | --- | --- |
| `.` | 保留，面收窄 | 工具集合、两个工厂、8 张常量表、产品面 4 个接口、注入面 14 个接口，以及它们签名里用到的数据 |
| `./contracts` | 保留，少一个名字 | `types/knowledge.ts` 的可移植数据；`KnowledgeUpsertInput` 挪进 `types/ingestion.ts`（见 §3.4） |

对外的值从 30 个收到 **11 个**：

| 分组 | 值 |
| --- | --- |
| 工具集合 | `knowledgeTools` |
| 工厂 | `createKnowledgeRuntime`、`createKnowledgeEmbeddingClient` |
| 常量表 | `KnowledgeToolNames`、`KnowledgeToolCategoryId`、`KnowledgeToolLimits`、`KnowledgeSourceKinds`、`KnowledgeIndexStatuses`、`KnowledgeMatchTypes`、`KnowledgeIndexConfig`、`KnowledgeEmbeddingProfileIsolationMigration` |

`browserSafeEntries` 仍是 `contracts.ts`：它只有类型，编译产物里没有一行运行时 JavaScript。

---

## 2. 新增的名字（7）

| 新名 | 它顶替了谁 |
| --- | --- |
| `createKnowledgeEmbeddingClient(requestFactory)` | `new EmbeddingApi(requestFactory)`（类不出包） |
| `KnowledgeEmbeddingRequestFactory` | `EmbeddingRequestFactory`（注入面的名字统一带包前缀） |
| `KnowledgeToolNames`、`KnowledgeToolName`、`KnowledgeToolCategoryId`、`KnowledgeToolLimits`、`KnowledgeSourceKinds` | 原先没出包的常量表：工具身份、类别、上限与来源类型闭集，宿主拼 mod 清单时不必再抄字符串 |

---

## 3. 有替代的旧名（10）

### 3.1 类 → 工厂与接口

| 旧名 | 新名 / 去向 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- |
| `new DefaultKnowledgeRuntime(providers)` / `new KnowledgeRuntime(providers)` | `createKnowledgeRuntime(providers)`（本来就有）；类型位用 `KnowledgeRuntimeApi` | 2（已改完） | Desktop 1（`src/main/knowledge/Runtime.ts` 已经在用工厂，只有类型位要改） |
| `KnowledgeRuntime`（类型位） | `KnowledgeRuntimeApi` | 1（已改完） | Desktop 1 |
| `KnowledgeDomain`（类型位） | `KnowledgeDomainApi` | 0 | Desktop 3（`RuntimeTypes.ts`、`agent/context/ToolContext.ts`、`knowledge/Service.ts`） |
| `KnowledgeVectors`（类型位） | `KnowledgeVectorsApi` | 0 | Desktop 1（`RuntimeTypes.ts`，只存不用） |
| `new EmbeddingApi(factory)` | `createKnowledgeEmbeddingClient(factory)`；类型位用 `KnowledgeEmbeddingClientApi` | 2（已改完） | Desktop 1（`src/plugins/lancedb/main/MemoryVectorBackend.ts`） |

### 3.2 注入面改名与别名清理

| 旧名 | 新名 / 去向 | Platform 仓消费点 | 产品仓消费点 |
| --- | --- | --- | --- |
| `EmbeddingRequestFactory` | `KnowledgeEmbeddingRequestFactory` | 0 | Desktop 1（`src/main/knowledge/Runtime.ts`） |
| `KnowledgeApi` | `KnowledgeToolApi`（两者本来就是同一个形状的别名） | 0 | 0 |

### 3.3 运行时门面上的两个短名别名

| 旧成员 | 新写法 | 说明 |
| --- | --- | --- |
| `runtime.domain` | `runtime.knowledgeDomainService` | 同一个对象两个名字；Desktop 用的已经是长名 |
| `runtime.vectorStore` | `runtime.knowledgeVectors` | 同上 |

### 3.4 从 `./contracts` 挪走的一个数据类型

| 旧名（入口） | 去向 |
| --- | --- |
| `KnowledgeUpsertInput`（`./contracts` 与 `.`） | 只在包内的摄入与写入链路上流动，从来不经宿主端口出去；挪进 `types/ingestion.ts`，不再出包 |

---

## 4. 已删、没有替代的名字（75）

这些名字在 0.6.0 里不再出包。要它们的能力走 `createKnowledgeRuntime` 交出来的门面。

### 4.1 类与它们的 Api 接口（26 + 13）

类：`KnowledgeChunkBuilder`（别名 `KnowledgeChunks`）、`KnowledgeContext`（别名 `AgentKnowledgeHelper`）、
`KnowledgeIngestion`、`KnowledgeMaintenance`、`KnowledgeMutation`、`KnowledgeQuery`、`KnowledgeQueryHelper`、
`KnowledgeWorkspace`（别名 `KnowledgeWorkspaceStore`）、`KnowledgeRepository`（别名 `KnowledgeRepo`）、
`KnowledgeRows`（别名 `KnowledgeRepositoryHelper`）、`KnowledgeVectorQuery`（别名 `KnowledgeVectorHelper`）、
`KnowledgeVectors`（值，别名 `KnowledgeVectorStore`）、`KnowledgeEmbeddings`（别名 `Embeddings`、`EmbeddingService`）、
`KnowledgeEmbeddingClient`（别名 `EmbeddingApi`、`EmbeddingApiHelper`）、`VectorFailureMonitor`、
`KnowledgeDomain`（值）、`KnowledgeRuntime`（值，别名 `DefaultKnowledgeRuntime`），以及常量 `VectorFailureLogWindowMs`。

Api 接口：`KnowledgeChunkBuilderApi`、`KnowledgeContextApi`、`KnowledgeEmbeddingsApi`、`KnowledgeIngestionApi`、
`KnowledgeMaintenanceApi`、`KnowledgeMutationApi`、`KnowledgeQueryApi`、`KnowledgeQueryHelperApi`、
`KnowledgeRepositoryApi`、`KnowledgeRowsApi`、`KnowledgeVectorQueryApi`、`VectorFailureMonitorApi`、
`VectorFailureMonitorOptions`。

它们都是 `createKnowledgeRuntime` 在内部装好的零件，装配者不需要认识。仍然出包的三个接口是
`KnowledgeRuntimeApi`、`KnowledgeDomainApi`、`KnowledgeVectorsApi`——因为 `KnowledgeRuntimeApi` 的两个字段就是后两个。

### 4.2 工具函数（13）

代码扫描：`extractImports`、`extractSymbols`、`createImportTargetCandidates`、`getCodeExtensions`、
`isCodeFile`、`isLikelyTextFile`、`scorePathMatch`。
索引身份：`buildIndexTextHash`、`buildDocumentRevisionKey`、`buildEmbeddingProfileIdentity`、
`canReuseReadyContentIndex`。
召回与统计：`mergeHybridCandidates`、`buildVectorStoreStats`。

仓库标准的原话：utils 的函数不出包。

### 4.3 没有公开签名用得到的数据类型（23）

`EmbeddingProfileIdentity`、`EmbeddingRuntimeSelection`、`HybridCandidate`、`IndexedRecordIdentity`、
`KnowledgeChunk`、`KnowledgeCodeCandidateInput`、`KnowledgeCodeSymbol`、`KnowledgeCodeSymbolKind`、
`KnowledgeCodeSyncResult`、`KnowledgeDocumentRow`、`KnowledgeFileIndexRecord`、`KnowledgeFileIndexRow`、
`KnowledgeIndexedFileInspection`、`KnowledgeRelationalDiagnostics`、`KnowledgeTextSearchRow`、
`KnowledgeVectorIndexRecord`、`KnowledgeVectorRow`、`KnowledgeVectorSearchPartition`、`LanceIndexDescriptor`、
`RankedKnowledgeCandidate`、`TextSnippetSource`、`VectorStoreStatsInput`、`VectorStoreStatsOutput`、
`VectorFailureLogger`。

---

## 5. 产品仓要改的调用点

### 5.1 VelarOS-Desktop（13 个文件）

Desktop 现在写的还是拆包前的路径 `@velaros-ai/memory/knowledge`（那个子路径在 memory 拆包时就没了），
所以这 13 个文件本来就要改一次；下表把「换包名」与「换名字」一并列出。

| 文件 | 现在从哪取什么 | 改成 |
| --- | --- | --- |
| `src/mods/memory/manifest.ts` | `knowledgeTools` | 包名换 `@velaros-ai/knowledge`，名字不变 |
| `src/main/knowledge/Runtime.ts` | `createKnowledgeRuntime`、`EmbeddingRequestFactory`、`KnowledgeEmbeddingRuntime`、`KnowledgeRuntime`（类型位） | 换包名；`EmbeddingRequestFactory` → `KnowledgeEmbeddingRequestFactory`，`KnowledgeRuntime` → `KnowledgeRuntimeApi` |
| `src/main/knowledge/Service.ts` | `KnowledgeDomain` 与 5 个 DTO | 换包名；`KnowledgeDomain` → `KnowledgeDomainApi` |
| `src/main/knowledge/Ipc.ts` | 5 个 DTO | 换包名（`@velaros-ai/knowledge/contracts` 更合适） |
| `src/main/knowledge/LanceDbPlatformAdapter.ts` | `KnowledgeLanceDbModule` | 换包名，名字不变 |
| `src/main/bootstrap/RuntimeTypes.ts` | `KnowledgeDomain`、`KnowledgeVectors` | 换包名；改 `KnowledgeDomainApi`、`KnowledgeVectorsApi` |
| `src/main/agent/context/ToolContext.ts` | `KnowledgeDomain`、`KnowledgeSearchResult` | 换包名；`KnowledgeDomain` → `KnowledgeDomainApi` |
| `src/main/tools/context/KnowledgeContextTypes.ts` | 7 个 DTO | 换包名（`/contracts`） |
| `src/main/storage/migrations/Migration003EmbeddingProfileIsolation.ts` | `KnowledgeEmbeddingProfileIsolationMigration` | 换包名，名字不变 |
| `src/plugins/lancedb/main/MemoryVectorBackend.ts` | `EmbeddingApi`、`KnowledgeEmbeddingRuntime` | 换包名；`new EmbeddingApi(f)` → `createKnowledgeEmbeddingClient(f)` |
| `packages/ipc/src/contracts.ts`、`packages/ipc/src/rendererIpcContract.ts` | 5 个 DTO（`/knowledge/contracts`） | `@velaros-ai/knowledge/contracts` |
| `scripts/checks/toolDescriptionBudget.mjs` | `['@velaros-ai/memory/knowledge', ['knowledgeTools']]` | 改包名 |

另外要改但不是 import 的：`package.json` 与 `bun.lock` 加 `@velaros-ai/knowledge`（`^0.6.0`）、
`packages/arch-guard-velaros/src/checks/architecture/memoryProductBoundary.ts` 与
`rendererPortablePackageBoundary.ts` 里按 `@velaros-ai/memory/knowledge` 字符串钉的规则。

`runtime.domain` / `runtime.vectorStore` 这两个短名别名 Desktop 没有用，不受影响。

### 5.2 VelarOS-Workbench / Termel / Extension

零引用，不受影响。
