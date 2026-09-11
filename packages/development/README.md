# `@velaros-ai/development`

Development 是 Project 代码理解工具复用的语言服务运行时库，不再拥有独立 Mod、工具身份或
Project 空间声明。模型看到的 canonical 工具由 `@velaros-ai/project` 直接提供：
`project:query-code`。

`@velaros-ai/development/runtime` 拥有 JavaScript、TypeScript 与 Python 的即时语言分析、
TypeScript Language Service 缓存和统一 action 路由。`createProjectCodeQuery()` 始终保留内置
语言服务 action；宿主可以注入 `ProjectCodeIndexApi`，在 CodeGraph 安装并启用后为同一个工具
覆盖图谱、依赖、调用链和索引 action。CodeGraph 缺失不会隐藏基础工具。

`executeProjectCodeLanguageQuery()` accepts `LanguageToolContext`: an abort signal, scoped
working-directory access, and `listFiles` / `read` / `listSymbols` source ports. A language-only
host does not supply approval, command execution, mutation, or system capabilities. The optional
CodeGraph overlay retains `ProjectToolContext` at the Project query boundary.
The language-operation path scopes directories through that injected port directly, so loading it
does not load the Project Agent tool barrel. Project wire/query guards remain on the portable
`@velaros-ai/project/contracts` entry.

`language_diagnostics` 的 `path` 可以是文件或目录。目录按 `extensions` / `maxDepth` 选出
JavaScript/TypeScript 源文件（跳过 `.gitignore` 忽略的文件），单次最多 200 个源文件、耗时预算
20 秒；任一闸触发时 `truncated: true` 并在 `note` 里说明。选中的文件按各自所属的 tsconfig
分组，每组只构建一次程序，诊断结果与逐个文件单独诊断一致；文件之间让出事件循环，中止信号
在两个文件之间生效。没有扫描到任何文件时 `note` 会写明原因，空结果不会伪装成「全部通过」；
结果按错误、警告、提示的顺序排列后再按 `limit` 截断。

TypeScript 类型诊断依赖标准库声明（`lib.*.d.ts`）。宿主按以下顺序定位：

1. `typescript` 包自身所在目录（开发环境与未剔除 `.d.ts` 的安装）；
2. 宿主调用 `configureTypeScriptLibraryDirectory(absoluteDir)` 显式声明的目录；
3. Electron 约定目录 `<process.resourcesPath>/typescript/lib`。

Electron 打包默认剔除 `node_modules` 里的 `.d.ts`，宿主应把
`node_modules/typescript/lib/lib*.d.ts` 作为 extraResources 放到 `typescript/lib`，即可在不改代码
的情况下命中第 3 条。三处都找不到时，诊断结果带 `degraded` 说明并只返回语法诊断，不会把
`Cannot find name 'Record'` 这类由标准库缺席导致的伪错误当作真结果返回。

`ExternalLanguageService` 负责外部 language server 的进程生命周期、JSON-RPC framing、
超时/取消、诊断与导航结果的有界归一。宿主保留二进制与资源发现、启用策略、进程环境和状态展示，
不会由 Development 静默下载或启动任意可执行文件。

工具 schema、`project:query-code` 身份、类别和 Mod Loader 声明都归 `@velaros-ai/project`；
本包只提供可复用实现，不参与 Mod 装载。
