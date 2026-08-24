# `@velaros-ai/development`

Development 是可组合的代码理解能力包，不拥有项目文件编辑或命令执行。

模型只看到一个结构化工具：`development:query-code`。它通过 action 覆盖符号、关系、依赖、诊断、影响面和索引操作，并由宿主注入实际代码服务。该职责包通过 Mod Loader 的 `availableInSpaces: ['project']` 加入 Project 空间；是否常驻由运行时工具预算决定。

`@velaros-ai/development/runtime` 拥有 JavaScript、TypeScript 与 Python 的即时语言分析、
TypeScript Language Service 缓存和统一 action 路由。宿主只通过 `DevelopmentCodeIndexApi`
注入自身的结构化索引器；`createDevelopmentToolApi()` 将两者组合成工具运行时。这样 Desktop
不再保存一份通用语言工具实现，其他宿主也可以复用同一职责包。

`ExternalLanguageService` 负责外部 language server 的进程生命周期、JSON-RPC framing、
超时/取消、诊断与导航结果的有界归一。宿主保留二进制与资源发现、启用策略、进程环境和状态展示，
不会由 Development 静默下载或启动任意可执行文件。

`./composition` 只提供 Mod Loader 声明：工具归入 `development-code` 类别并常驻 Project 空间。文件读取、原子编辑和受治理命令分别归 `@velaros-ai/project` 的职责切片；系统文件、进程和桌面集成归 `@velaros-ai/system`。这些边界禁止 Development 退化成另一套项目工具集合。

`@velaros-ai/development/contracts` 是浏览器安全的窄契约入口，只暴露稳定工具身份；
渲染层不得为读取工具名而导入 Node 语言服务运行时。
