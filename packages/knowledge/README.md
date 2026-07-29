# @velaros-ai/knowledge

中文接口文档：[`docs/api.zh-CN.md`](docs/api.zh-CN.md)

工作区资料与代码知识域。负责增量摄取、分块、FTS/LanceDB 检索、embedding profile
隔离、诊断与 Agent 工具，不拥有跨会话长期记忆或 MemoryDream。

## Public Imports

- `@velaros-ai/knowledge`
- `@velaros-ai/knowledge/contracts` — browser-safe, type-only Knowledge DTOs
- `@velaros-ai/knowledge/cli`

## Boundary

- 文档、索引状态、检索结果、provider/model profile identity 均由本包拥有。
- embedding 模型选择、provider 凭证和 runtime availability 必须先由宿主解析，再通过
  `KnowledgeEmbeddingConfigPort.resolveEmbeddingRuntime()` 注入。
- 工作区可见性通过 `KnowledgeIndexingPolicy` 注入；本包不依赖 Workspace 实现。
- 本包不依赖 `@velaros-ai/memory`，也不从 Kernel Core 导入 Model/Knowledge/Workspace DTO。
- Renderer、Web Worker、RPC schema 和前端测试从 `/contracts` 导入 DTO；该入口
  不加载 SQLite、LanceDB、Apache Arrow、摄取或运行时实现。
