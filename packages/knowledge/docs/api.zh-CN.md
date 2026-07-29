# `@velaros-ai/knowledge` 接口文档

## 定位与非目标

本包提供文件/代码知识摄取、分块、SQLite FTS 与 LanceDB 混合检索、索引诊断和显式重建。
它不拥有 Workspace、模型目录、凭证、长期记忆或产品 UI。`workspaceRoot` 只是调用方提供的
隔离键和文件根，不代表依赖某个 Workspace 实现。

## 安装

```bash
npm install @velaros-ai/knowledge
```

完整运行时以 ESM 发布，要求 Node.js 20 或更高版本。LanceDB 与
`better-sqlite3` 是运行依赖。只消费 `/contracts` 的浏览器、renderer 或 Web Worker
不需要 Node.js 运行时和 Node 类型声明。

## 公共入口

- `@velaros-ai/knowledge`：运行时、领域、embedding、存储和注入端口。
- `@velaros-ai/knowledge/contracts`：浏览器安全的纯类型领域 DTO。
- `@velaros-ai/knowledge/cli`：命令行入口。

只使用清单公开的入口，不要深层导入 `dist/knowledge/**`。

```ts
import type {
  KnowledgeDiagnostics,
  KnowledgeReindexOptions,
  KnowledgeReindexResult,
  KnowledgeWorkspaceSyncOptions,
  KnowledgeWorkspaceSyncResult,
} from '@velaros-ai/knowledge/contracts'
```

`/contracts` 的运行时 JavaScript 为空，不会加载 SQLite、LanceDB、Apache Arrow、
embedding 请求或索引实现。

## 核心类与接口

- `KnowledgeRuntime`：保留 0.3.x 结构兼容性的最小接口，同时也是默认实现的构造器入口。
- `DefaultKnowledgeRuntime`：拥有完整对象图，公开 `domain` 与 `vectorStore`；旧属性是兼容成员。
- `KnowledgeDomain`：同步、搜索、诊断与显式重建的高层门面。
- `KnowledgeRuntimeProviders`：所有外部依赖的组合接口。
- `KnowledgeEmbeddingConfigPort`：返回当前已经解析好的 provider/model/profile。
- `EmbeddingRequestFactory`、`KnowledgeHttpClient`：embedding 协议与网络端口。
- `KnowledgeDatabaseProvider`、`KnowledgeStoragePathProvider`：关系与向量存储端口。
- `KnowledgeCodeIntelligenceApi`、`KnowledgeIndexingPolicy`：可选代码智能和可见性策略。
- `VectorFailureMonitor`：运行时级故障抑制器；不同实例不共享状态。

`createKnowledgeRuntime(providers)` 是 class 构造入口的兼容工厂。

## 生命周期/并发

一个数据目录或租户对应一个 `KnowledgeRuntime`。启动时调用 `warmup()`，退出时调用
`close()`。同一知识文档的并发写入应由宿主按 `workspaceRoot + path` 串行化；搜索可以并发。
向量失败会降级为文本检索，不会让整个查询不可用。

## 依赖注入

所有环境差异都在 `KnowledgeRuntimeProviders` 边界一次注入。Knowledge 不读取模型环境变量，
也不会自动选择 provider。`resolveEmbeddingRuntime()` 应返回稳定的 provider、model、凭证、
baseURL 与 `configured` 状态。

## 错误模型

无效参数、未配置 embedding、未找到文档和存储错误使用 `AppError`。向量通道失败在可安全
降级时写入诊断并返回文本结果；显式重建会在 `KnowledgeReindexResult.failures` 中逐项报告。

## 最小第三方示例

```ts
import {
  DefaultKnowledgeRuntime,
  type KnowledgeRuntimeProviders,
} from '@velaros-ai/knowledge'

declare const providers: KnowledgeRuntimeProviders

const knowledge = new DefaultKnowledgeRuntime(providers)

await knowledge.warmup()
await knowledge.domain.ensureWorkspaceSynced('/srv/project')
const results = await knowledge.domain.searchKnowledge('认证流程', {
  workspaceRoot: '/srv/project',
})
knowledge.close()
```

仓库中的 [`examples/minimal.ts`](../examples/minimal.ts) 会随包发布，并在发布门禁中以
NodeNext、`skipLibCheck: false` 编译。

## 扩展点

- 用 `EmbeddingRequestFactory` 接入任意 embedding provider。
- 用 `KnowledgeIndexingPolicy` 实现沙箱、租户或忽略文件策略。
- 用 `KnowledgeCodeIntelligenceApi` 接入 LSP、tree-sitter 或远程代码图。
- 在 `KnowledgeApi` 前增加授权、审计或 RPC 门面。

## 兼容策略

profile 身份始终是 `provider + model + dimensions`，查询还绑定当前内容 revision。切换模型只
切换活动 profile，不会删除、重写或自动重建历史向量。只有显式 `reindexKnowledge()` 才为
当前 profile 写入新索引；旧 profile/revision 保留但不可见。0.3.x 继续保留工厂与旧的无状态
`KnowledgeQueryHelper` class 入口；模块级 helper 实例不再公开，包内查询直接使用无状态纯函数。
发布声明使用包内模块化 utility types，不注入 ambient globals，也不会与 Core/UI 的类型声明
冲突。
