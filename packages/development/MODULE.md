# @velaros-ai/development 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看四个类上方的接口（`contract/provides.ts` 登记它们）与 `contract/requires.ts` 的三个注入点，常量表在 `contract/constants.ts`。
> 门禁：`bun run check:module-ownership`。

## 这是什么

Project 代码理解背后的语言服务库。宿主拿它实现 project 注入面里的 `ProjectToolApi.queryCode`：
`project:code` / `project:code-analysis` 把模型的请求翻译成一条 `ProjectCodeQuery` 交过来，语言服务类的七个动作
（找符号、列导出、列引入、找引用方、找引用、诊断、符号影响面）由本包回答，代码图谱类动作交给宿主自己的图后端。

本包自己没有模型面工具，也不认宿主：只要给得起「列文件 / 读正文 / 列符号」三个读方法，Desktop、Workbench、Termel
都能直接用。另有一件独立能力：把用户本机装好的外部语言服务（basedpyright、gopls、rust-analyzer…）按 LSP 拉起来，
给 JavaScript/TypeScript 与 Python 之外的语言补上诊断与跳转。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：每件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `languageQueries` | `LanguageQueriesApi` | 语言查询的唯一入口：`run(input, context)` 把七个动作分派到语言服务再合成一份结果 |
| `createProjectCodeQuery` | 返回 project 注入面要的 `queryCode` 函数 | 按宿主给的代码图谱后端造一份代码查询：语言类走内置，图谱类走宿主 |
| `createExternalLanguageService` | `ExternalLanguageServiceApi` | 按项目根造一份外部语言服务集合：`supports` / `status` / `diagnostics` / `hover` / `definition` / `references` / `stop` |
| `typeScriptProjects` | `TypeScriptProjectsApi` | TypeScript 语言服务池的宿主面：`configureLibraryDirectory` 声明标准库目录，`release` 在关项目时释放 |
| `LanguageServiceIds` | 契约常量 | 内置语言服务的 id：`jsts`、`python` |
| `CodeQuerySources` | 契约常量 | 结果里 `source` 字段的两种来源 |
| `DevelopmentCodeLimits` | 契约常量 | 目录诊断的公开上限：文件数与耗时预算 |
| `BuiltinExternalLanguageServers` | 契约常量 | 内置的九个外部语言服务规格 |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候、必须吗 |
| --- | --- |
| `LanguageToolContext` | 宿主每次语言查询给；必须。里面是中止信号、项目根与只读内核 |
| `LanguageReadPort` | 同上，是内核端口的 `listFiles` / `read` / `listSymbols` 三件事 |
| `ProjectCodeIndexApi` | 宿主的代码图谱后端，建查询时给；可选——给一个永远不可用的空实现也合法 |

**数据面**是 `types/development.ts`（可移植）：外部语言服务交出去的五种形状
（`ExternalLanguageServerSpec`、`ExternalLanguageDiagnostic`、`ExternalLanguageStatus`、`ExternalLanguageLocation`、`ExternalLanguageHover`），
外加常量表派生的 `LanguageServiceId` 与 `CodeQuerySource`。语言查询自己的输入、记录与结果是包内工作类型，不出包——
它们经 `queryCode` 变成普通对象交给 project，由 project 的工具合同负责形状。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 进程（要读磁盘、要拉子进程） | 四件能力、三个注入点与可移植数据 |
| `./contracts` | 渲染进程与浏览器 | 常量表与可移植数据，整条链不碰 Node |

## 骨干链路

本包没有模型面工具，链路按每件能力写：

| 能力 | 链路 |
| --- | --- |
| 代码查询（project 的 `queryCode`） | `createProjectCodeQuery(codeIndex)` → `ProjectCodeQuery.run` → 是语言类动作就交给 `languageQueries.run`；否则问 `codeIndex.isAvailable()`，可用就转发并贴上 `source: 'codegraph'`，不可用就抛 `UNAVAILABLE` |
| 语言查询 | `languageQueries.run` → 查中止信号、`languageServiceRegistry.assertKnownLanguage` → 按 action 分派 → `selectLanguageServices` 选服务 → 并行问每个服务 → 排序、截断、合并计数与说明 → 贴上 `source: 'language-service'` |
| 找符号 / 列导出 / 列引入 / 找引用 / 找引用方 | 语言服务 → `utils/source-files.ts` 选文件（按结果条数换算扫描面）→ 逐个经只读端口读正文 → 语法层解析（`utils/jsts-syntax.ts` / `utils/python-syntax.ts`）→ 去重排序 |
| 诊断 | `JsTsLanguageService.getDiagnostics` → 解析路径并卡住项目边界 → 选文件（跳过 .gitignore 与依赖、构建目录）→ `groupFilesByTypeScriptProject` 按所属 tsconfig 分组 → 每组一次 `typeScriptProjectPool.acquire` → 逐文件取语法/语义/建议诊断，文件之间让出事件循环 → 排序截断，截断与降级写进 `note` / `degraded` |
| 符号影响面 | `analyzeImpactWithService` → 声明（找符号）+ 引用（找引用）+ 引用方（沿声明文件逐个找）+ 相关测试路径 |
| 外部语言服务 | `createExternalLanguageService(root, specs?)` → 按扩展名挑规格 → `ExternalLanguageServerClient.start` 拉进程并握手 → `didOpen` / `didChange` 同步正文 → 等 `publishDiagnostics` 或发一条请求 → `utils/lsp.ts` 归一成本包形状 |

## 依赖什么

- `@velaros-ai/core`：`AppError`、`Log`、类型守卫、`TimerScope`、`resolveRealPath`。
- `@velaros-ai/platform`：路径文本包含判断（越界判定的唯一实现）。
- `@velaros-ai/velar/project`：只取类型与 `./project/contracts` 的常量，**运行时不加载项目单元的根入口**（`check:capabilities-arch` 守着这条）。
- `typescript`：JS/TS 的语法树、tsconfig 解析与 `ts.LanguageService`。是 devDependency：公开签名里不出现任何 `ts.*` 类型。
- `@codemirror/lang-python`：Python 的 Lezer 语法树。
- Node 内置模块：`node:fs`、`node:path`、`node:crypto`、`node:child_process`、`node:url`、`node:timers/promises`。
- 不读任何环境变量（标准库目录读的是 Electron 的 `process.resourcesPath`，不是环境变量），所以常量表里没有环境变量表。

## 状态归谁

- **TypeScript 语言服务池**（`TypeScriptProjectPool`）：全包唯一的长寿状态。两级缓存同一把键（`项目根\0配置路径`）——
  解析好的配置加源码快照，以及活的 `ts.LanguageService` 加文件版本表。进程内一份，宿主经 `typeScriptProjects` 释放。
- **语言服务登记处**（`LanguageServiceRegistry`）：构造时装好两个内置服务，之后不变；注册不是 import 时的副作用。
- **外部语言服务**（`ExternalLanguageService`）：按项目根各一份，持有已拉起的客户端与启动失败的规格；客户端持有子进程、
  在等的请求、在等的诊断与打开着的文档。
- 其余全是无状态函数：选文件、读正文、语法解析、结果合并都不留东西。

## 生命周期

- `languageQueries` 与 `typeScriptProjects` 随进程存在，不需要构造。
- 语言服务池按需建、按最近使用淘汰；宿主关项目时调 `typeScriptProjects.release(projectRoot)`，退出时调 `typeScriptProjects.release()`。
- `createExternalLanguageService` 造出来的实例要自己 `stop()`：它会拉起子进程。进程按需拉起，只有真查到那种扩展名的文件才 spawn。
- 声明标准库目录（`configureLibraryDirectory`）会整池重建：已池化的服务绑定了旧的标准库位置。

## 失败语义

- 外面按错误码判断，不按文字。`VALIDATION`：路径越界、`language` 认不出、标准库目录不是绝对路径；
  `NOT_FOUND`：诊断路径不存在；`UNAVAILABLE`：代码图谱类动作没有后端（project 据此降级，不当成失败）。
- **空结果不伪装成「全部通过」**：没扫到文件、文件数被截断、耗时超预算、标准库缺失，一律写进 `note` / `degraded`。
- **计数不谎报**：`find_references` 凑够 `limit + 1` 条就停扫，此时 `referenceCountIsLowerBound` 为真、`note` 写明「至少」；
  `importerCount` 是真实总数，两者并排交给模型时分得清。
- 外部语言服务「等到超时也没收到诊断」与「真的没问题」分得开：超时的文件数记进 `status()` 的
  `diagnosticsTimedOutFiles` / `diagnosticsComplete`，并留一条警告日志。
- 中止信号在每次列目录、读文件与逐个文件诊断之间生效，抛 `name` 为 `AbortError` 的错误。

## 不变量

共 11 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 9 条、门禁 1 条、类型 1 条。未验证 0 条。

## 非目标

- 不装语言服务：外部语言服务的命令要用户自己装，本包不下载、不安装、不改名。
- 不做代码图谱：跨文件调用链、类型层次、死代码这些归宿主的图后端，本包只把请求转过去。
- 不改代码：只读源码，没有写入、执行与审批能力，也不给自己留这些口子。
- 不做增量索引：每次查询按当前磁盘内容回答，唯一的缓存是 TypeScript 程序的增量缓存。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记三件能力的 API（定义在类上方，这里 re-export），requires.ts 是三个注入点，constants.ts 是语言服务身份、结果来源、诊断上限与内置外部语言服务规格表
  types/        只放类型：development.ts 可移植（外部语言服务的五种数据），language.ts 语言查询的输入与结果，syntax.ts 语法层中间形状，external-language.ts LSP 工作类型，typescript.ts 语言服务池工作类型
  impl/         一类一文件，八个类：代码查询分派、语言查询、语言服务登记处、两个语言服务、TypeScript 项目池、外部语言服务与它的客户端
  utils/        纯函数：选文件与扫描外壳、两种语言的语法解析、tsconfig 发现与解析、诊断归一、LSP 归一、路径边界、结果合并，tuning.ts 是可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现测试：诊断、查询语义、路径边界、外部语言服务
```

**分层**（登记在 `governed-modules.mjs` 的 `layers`，上层可以引下层与同层，下层不许引上层）：

```text
ProjectCodeQuery · ExternalLanguageService
  → LanguageQueries · ExternalLanguageServerClient
    → LanguageServiceRegistry
      → JsTsLanguageService · PythonLanguageService
        → TypeScriptProjectPool
```

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，公开的在 `contract/provides.ts` 登记；
类的公开成员只能是接口里的成员。整个进程只需要一份的，在文件末尾给出那一份，按接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ProjectCodeQuery.ts` | `ProjectCodeQueryApi`（同文件，不出包） | 一条代码查询分两路：语言服务或宿主代码图谱；出包的是工厂 `createProjectCodeQuery` |
| `LanguageQueries.ts` | `LanguageQueriesApi`（provides 登记） | 七个语言动作的分派与多语言结果合并，实例 `languageQueries` |
| `LanguageServiceRegistry.ts` | `LanguageServiceRegistryApi`（同文件，不出包） | 装着两个内置语言服务，负责「这次查询该由谁答」与 `language` 的认与不认 |
| `JsTsLanguageService.ts` | `JsTsLanguageServiceApi`（同文件，不出包） | JavaScript / TypeScript 的语言语义：六个导航动作加类型诊断 |
| `PythonLanguageService.ts` | `PythonLanguageServiceApi`（同文件，不出包） | Python 的语言语义：六个导航动作，没有诊断 |
| `TypeScriptProjectPool.ts` | `TypeScriptProjectsApi`（provides 登记）+ `TypeScriptProjectPoolAccess`（同文件，不出包） | `ts.LanguageService` 池：宿主面只有声明标准库目录与释放，包内面是取语言服务 |
| `ExternalLanguageService.ts` | `ExternalLanguageServiceApi`（provides 登记） | 一个项目上的外部语言服务集合，出包的是工厂 `createExternalLanguageService` |
| `ExternalLanguageServerClient.ts` | `ExternalLanguageServerClientApi`（同文件，不出包） | 一个语言服务进程的 stdio JSON-RPC 客户端 |
