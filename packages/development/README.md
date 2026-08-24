# `@velaros-ai/development`

Development 是 Project 代码理解工具复用的语言服务运行时库，不再拥有独立 Mod、工具身份或
Project 空间声明。模型看到的 canonical 工具由 `@velaros-ai/project` 直接提供：
`project:query-code`。

`@velaros-ai/development/runtime` 拥有 JavaScript、TypeScript 与 Python 的即时语言分析、
TypeScript Language Service 缓存和统一 action 路由。`createProjectCodeQuery()` 始终保留内置
语言服务 action；宿主可以注入 `ProjectCodeIndexApi`，在 CodeGraph 安装并启用后为同一个工具
覆盖图谱、依赖、调用链和索引 action。CodeGraph 缺失不会隐藏基础工具。

`ExternalLanguageService` 负责外部 language server 的进程生命周期、JSON-RPC framing、
超时/取消、诊断与导航结果的有界归一。宿主保留二进制与资源发现、启用策略、进程环境和状态展示，
不会由 Development 静默下载或启动任意可执行文件。

工具 schema、`project:query-code` 身份、类别和 Mod Loader 声明都归 `@velaros-ai/project`；
本包只提供可复用实现，不参与 Mod 装载。
