# @velaros-ai/memory/knowledge

> `@velaros-ai/memory` 的一个导入切片(`packages/memory/src/knowledge`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

**工作区资料与代码的知识域**:把一个工作区里的文件增量摄取、分块、建 SQLite FTS 与 LanceDB
向量索引,提供混合检索、索引诊断与显式重建,并附带一组 agent 工具。

它**不拥有跨会话长期记忆,也不拥有 MemoryDream**——那些是记忆产品(包根入口)的事。
`workspaceRoot` 在这里只是调用方给的**隔离键 + 文件根**,不代表本切片依赖任何 Workspace 实现。

## 公共入口

- `@velaros-ai/memory/knowledge` —— 运行时、领域、embedding、存储与注入端口
- `@velaros-ai/memory/knowledge/contracts` —— **浏览器安全的纯类型** Knowledge DTO
- `@velaros-ai/memory/knowledge/cli` —— 命令行入口

`/contracts` 的运行时 JavaScript 为空:不会加载 SQLite、LanceDB、Apache Arrow、
embedding 请求或索引实现。renderer、Web Worker、RPC schema 与前端测试从这里取类型。
**不要深层导入 `dist/knowledge/**`。**

## 核心概念

### embedding profile 隔离(本切片最重要的设计)

**profile 身份恒为 `provider + model + dimensions`**,查询还额外绑定当前内容 revision。

由此得到一条关键性质:**换模型只是切换活动 profile,不会删除、改写或自动重建历史向量**。
只有显式调用 `reindexKnowledge()` 才为当前 profile 写入新索引;
旧 profile / 旧 revision 的数据**保留但不可见**。

这条设计是为了让「用户换个 embedding 模型」不再是一次不可逆的破坏性操作。

### 向量失败降级,不是整体失效

向量通道出问题时,在可安全降级的前提下**写诊断并回落到文本检索**,而不是让整个查询不可用。
`VectorFailureMonitor` 是运行时级的故障抑制器,**不同实例之间不共享状态**。

### 主要端口

- `KnowledgeRuntime` / `DefaultKnowledgeRuntime` —— 运行时对象图,公开 `domain` 与 `vectorStore`。
- `KnowledgeDomain` —— 同步、搜索、诊断、显式重建的高层门面。
- `KnowledgeRuntimeProviders` —— 所有外部依赖的组合接口。
- `KnowledgeEmbeddingConfigPort` —— 返回**已经解析好**的 provider / model / profile。
- `EmbeddingRequestFactory` / `KnowledgeHttpClient` —— embedding 协议与网络端口。
- `KnowledgeDatabaseProvider` / `KnowledgeStoragePathProvider` —— 关系与向量存储端口。
- `KnowledgeCodeIntelligenceApi` / `KnowledgeIndexingPolicy` —— 可选代码智能与可见性策略。

## 边界

- 文档、索引状态、检索结果、provider / model profile 身份**均由本切片拥有**。
- **embedding 模型选择、provider 凭证与运行时可用性必须先由宿主解析**,再经
  `KnowledgeEmbeddingConfigPort.resolveEmbeddingRuntime()` 注入。
  本切片**不读模型环境变量,也不会自动挑 provider**。
- 工作区可见性经 `KnowledgeIndexingPolicy` 注入;**本切片不依赖 Workspace 实现**。
- **本切片不依赖 `@velaros-ai/memory`(包根)**,也不从 Kernel Core 导入
  Model / Knowledge / Workspace DTO。

## 生命周期与并发

一个数据目录或租户对应**一个** `KnowledgeRuntime`。启动 `warmup()`,退出 `close()`。
同一知识文档的并发写入应由宿主按 `workspaceRoot + path` 串行化;**搜索可以并发**。

## 用法

```ts
import {
  DefaultKnowledgeRuntime,
  type KnowledgeRuntimeProviders,
} from '@velaros-ai/memory/knowledge'

declare const providers: KnowledgeRuntimeProviders

const knowledge = new DefaultKnowledgeRuntime(providers)
await knowledge.warmup()
await knowledge.domain.ensureWorkspaceSynced('/srv/project')
const results = await knowledge.domain.searchKnowledge('认证流程', {
  workspaceRoot: '/srv/project',
})
knowledge.close()
```

## 错误模型

无效参数、未配置 embedding、未找到文档与存储错误用 `AppError`。
向量通道失败在可安全降级时写诊断并返回文本结果;
显式重建会在 `KnowledgeReindexResult.failures` 里**逐项**报告失败。

## 扩展点

- `EmbeddingRequestFactory` → 接入任意 embedding provider;
- `KnowledgeIndexingPolicy` → 实现沙箱、租户或忽略文件策略;
- `KnowledgeCodeIntelligenceApi` → 接入 LSP、tree-sitter 或远程代码图;
- 在 `KnowledgeApi` 前面加授权、审计或 RPC 门面。
