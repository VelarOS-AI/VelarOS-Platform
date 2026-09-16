# `@velaros-ai/development` 按仓库标准改造方案

> 对象：`packages/development`（1.1.11），HEAD `606fba59`（数据采于 `7c39d5c9`；其后本范围内只有 core `utils/RealPath.ts` 的写法微调 `0ac2b5f1`，结论不变），本包工作区干净。它是 project 的 `project:code` / `project:code-analysis` 背后的语言服务库：宿主拿它实现 project 注入面里的 `ProjectToolApi.queryCode`，本包自己没有模型工具。
> 标准同其它方案。能力归属表把它登记在 `project` owner 下（`entrySubpaths: ['.', './runtime']`）；`check:capabilities-arch` 另有一条：本包运行时不许加载 project 根入口（类型可以，值只能从 `@velaros-ai/project/contracts` 取）。
> 基线：3 个测试文件 30 pass / 0 fail（`package.json` 的 `test` 只跑其中 2 个，见 §5-7）。性能数字来自草稿区 `plan-small/probe-dev/`。

## 0. 结论先行

- **规模**：`src/` 10 个源文件 3,765 行（JS/TS 导航 932、TS 项目宿主 768、外部语言服务 563、Python 导航 514）；入口 `.`（零消费方）与 `./runtime`（导出 14 个符号，被用 6 个）。
- **消费方**：Desktop、Workbench、Termel 各用 `createProjectCodeQuery` + `ProjectCodeIndexApi`；Termel 另用 `ExternalLanguageService`（类）与 `BuiltinExternalLanguageServers`；仓库发布门 `check:host-contract-consumer` 的夹具用 `executeProjectCodeLanguageQuery` + `LanguageToolContext`/`LanguageReadPort`（「只给读源码端口的宿主」这条窄契约）。
- **主要问题**：TS 语言服务池是模块级状态（两个 Map + 一个 `let`），没有淘汰、宿主也拿不到释放口；语言服务注册在 import 时发生（模块级副作用）；一个文件两个类、三个类都没有接口；上限散在各处（`2500`、`5000`、`limit * 25/30/40/50`、`8_000`、`15_000`…）；路径越界判定同包里三份、写法各不相同，其中一份有错。
- **性能与语义缺陷**：`find_symbols`/`list_exports` 对每个未导出符号整文件重解析一次（900 行的文件约 290 ms）；每条 TS 诊断再整文件解析一次；`referenceCount` 其实是「最多 limit+1」却以总数的名义交给模型；外部语言服务把「8 秒没等到诊断」当成「没有问题」（§5）。
- **目标**：`ProjectCodeQuery`（实现 project 的 `queryCode`）、`LanguageQueries`（只读端口的语言查询）、`ExternalLanguageService` + `ExternalLanguageServerClient`、`TypeScriptProjectPool`、`LanguageServiceRegistry`、两个语言服务类，共 8 个类；入口 `.`、`./contracts`；可调参数进 tuning。
- **要拍板**：`referenceCount` 改口径是模型看得到的变化；外部诊断超时要不要在结果里说明（§7）。

## 1. 现状

### 1.1 入口与消费方

| 符号（`./runtime`） | 谁在用 |
| --- | --- |
| `createProjectCodeQuery`、`ProjectCodeIndexApi` | Desktop `mods/project/main/code/ProjectCodeQuery.ts`、Workbench `ProjectCapabilityProvider.ts`、Termel `capability-contexts.ts` |
| `ProjectCodeIndexQuery`（从 project 转手的类型） | Desktop 1 处 |
| `ExternalLanguageService`（类）、`BuiltinExternalLanguageServers`、`ExternalLanguageServerSpec` | Termel `serve-host/src/external-language-service.ts` |
| `executeProjectCodeLanguageQuery`、`LanguageToolContext`、`LanguageReadPort` | `scripts/release/fixtures/host-contract-consumer/consumer.ts`（发布门） |
| `configureTypeScriptLibraryDirectory` | 无（README 写给 Electron 宿主，Desktop 靠 `<resourcesPath>/typescript/lib` 约定命中） |
| `ExternalLanguageDiagnostic/Hover/Location/Status` | 无直接引用（是 `ExternalLanguageService` 方法的返回类型） |

### 1.2 结构与状态

| 文件 | 内容 | 按标准要处理的点 |
| --- | --- | --- |
| `runtime/index.ts` | 七个语言动作的分派 `executeProjectCodeLanguageQuery`、`createProjectCodeQuery`（语言类走内置、索引类走宿主 CodeGraph） | 模块级函数与 `Set`；混合转发 |
| `LanguageService.ts` | 20 多个类型、`LanguageServiceRegistry` 类与模块级实例、选文件/读文件/扫描外壳 | 类无接口；模块级实例；3 个数字常量与 `?? 2500` |
| `LanguageNavigation.ts` | 选服务、校验 `language`、影响面分析；**第 25 行 import 时安装内置插件** | 模块级副作用 |
| `LanguageOperations.ts` | 七个动作的合并外壳 | 纯函数 |
| `JsTsNavigation.ts` | JS/TS 符号、导入导出、引用、诊断 | 越界判定写错（§5-1）、两处重解析（§5-2/3） |
| `PythonNavigation.ts` | 基于 `@codemirror/lang-python` 的 Python 导航 | `toLineColumn` 每次从头切字符串（大文件多引用时平方级，小问题） |
| `TypeScriptProjectHost.ts` | tsconfig 发现与解析、`ts.LanguageService` 池、标准库目录定位 | 模块级 `projectCache`、`pooledProjects`、`let configuredLibraryDirectory`；无淘汰 |
| `ExternalLanguageService.ts` | 外部 LSP 的进程与 JSON-RPC | 两个类同文件、无接口；9 处英文报错；超时写死 |
| `DevelopmentResult.ts` | 结果加 `source` 字段 | 纯函数 |

## 2. 目标布局

```text
src/
  contract/   provides.ts、requires.ts、constants.ts
  types/      development.ts（可移植：ExternalLanguage* 五个数据类型）
              language.ts（语言查询的输入、记录、结果与共享的语言服务行为接口 LanguageNavigationService；不出包）
              typescript.ts（TS 池的内部工作类型，引 typescript 的类型）
  impl/       ProjectCodeQuery.ts、LanguageQueries.ts、LanguageServiceRegistry.ts、JsTsLanguageService.ts、PythonLanguageService.ts、
              TypeScriptProjectPool.ts、ExternalLanguageService.ts、ExternalLanguageServerClient.ts
  utils/      source-files.ts、jsts-syntax.ts、python-syntax.ts、typescript-config.ts、diagnostics.ts、lsp.ts、project-paths.ts、tuning.ts
  exports/    index.ts（Node）、contracts.ts
```

| 现有 | 去处 |
| --- | --- |
| `runtime/index.ts` 的 `createProjectCodeQuery` | `impl/ProjectCodeQuery.ts`：类 + 工厂 `createProjectCodeQuery(codeIndex): ProjectToolApi['queryCode']`（返回 project 端口要的函数形状，宿主代码不变） |
| `runtime/index.ts` 的分派 + `LanguageOperations.ts` + `DevelopmentResult.ts` | `impl/LanguageQueries.ts`（实例 `languageQueries.run(input, context)`，取代 `executeProjectCodeLanguageQuery`） |
| `LanguageService.ts` 的注册表 | `impl/LanguageServiceRegistry.ts`：构造时装好 JS/TS 与 Python 两个服务，不再靠 import 副作用；`LanguageNavigation.ts` 的选服务、`assertKnownLanguage` 成为它的方法 |
| `LanguageService.ts` 的类型 | `types/language.ts`；选文件/读文件/扫描外壳进 `utils/source-files.ts`（参数收 `LanguageToolContext` 接口） |
| `JsTsNavigation.ts` | `impl/JsTsLanguageService.ts`（类上方 `JsTsLanguageServiceApi extends LanguageNavigationService`）+ `utils/jsts-syntax.ts`、`utils/diagnostics.ts` |
| `PythonNavigation.ts` | `impl/PythonLanguageService.ts` + `utils/python-syntax.ts` |
| `TypeScriptProjectHost.ts` | 状态进 `impl/TypeScriptProjectPool.ts`（实例 `typeScriptProjects`）；tsconfig 发现、指纹、标准库闭包等无状态部分进 `utils/typescript-config.ts` |
| `ExternalLanguageService.ts` | 拆成两个类文件 + `utils/lsp.ts`（位置参数、诊断与跳转归一、markup 取文本、帧解析） |
| `JsTsNavigation.isInsideRoot`、`TypeScriptProjectHost.isPathInside`、`ExternalLanguageService.resolveFile` 三份越界判定 | `utils/project-paths.ts` 一份：`currentPlatform.isPathTextInside`，需要真实路径处先 `resolveRealPath` |

分层（登记表 `layers`，上层可以引下层）：`[ProjectCodeQuery, ExternalLanguageService] → [LanguageQueries, ExternalLanguageServerClient] → [LanguageServiceRegistry] → [JsTsLanguageService, PythonLanguageService] → [TypeScriptProjectPool]`。登记表：`portable: 'development.ts'`，`tuning: 'tuning.ts'`，`browserSafeEntries: ['contracts.ts']`，无环境变量表（读的是 Electron 的 `process.resourcesPath`，不是环境变量）。

## 3. 合同草案

**provides**

| 接口（类上方） | 出包的值 | 成员与说明 |
| --- | --- | --- |
| （不登记，类上方的 `ProjectCodeQueryApi` 只在包内） | 工厂 `createProjectCodeQuery(codeIndex: ProjectCodeIndexApi): ProjectToolApi['queryCode']`——返回类型直接用 project 注入面的成员类型，宿主照旧把它塞进 `queryCode` | 语言服务类动作走内置服务；代码索引类动作宿主有 CodeGraph 就交给它，没有就抛 `UNAVAILABLE`（project 按这个码降级） |
| `LanguageQueriesApi` | 实例 `languageQueries` | `run(input: ProjectCodeLanguageQuery, context: LanguageToolContext): Promise<unknown>`——只有读源码端口的宿主也能用（发布门夹具守着这条） |
| `ExternalLanguageServiceApi` | 工厂 `createExternalLanguageService(projectRoot, specs?)` | `supports`、`status`、`diagnostics`、`hover`、`definition`、`references`、`stop` |
| `TypeScriptProjectsApi` | 实例 `typeScriptProjects` | `configureLibraryDirectory(dir)`（取代 `configureTypeScriptLibraryDirectory`）、**新增** `release(projectRoot?)`：宿主关项目时释放语言服务池，解决 §5-5 |

**requires**

| 接口 | 谁给、什么时候、必须吗 |
| --- | --- |
| `ProjectCodeIndexApi` | 宿主的代码图谱后端（Desktop 的 CodeGraph、Workbench 的逻辑图）；建查询时给；可以是永远不可用的空实现（Termel 就是） |
| `LanguageToolContext` | 每次语言查询给：中止信号、项目根、在子目录里执行、只读内核（`LanguageReadPort` = project 内核端口的 `listFiles`/`read`/`listSymbols`） |
| `LanguageReadPort` | 同上，只是一份类型别名，写清只借这三个方法 |

**constants**

| 表 | 内容 |
| --- | --- |
| `BuiltinExternalLanguageServers` | 九个外部语言服务规格（basedpyright、pyright、gopls、rust-analyzer、clangd、json、css、html、vue），名字不变，改成冻结表 |
| `LanguageServiceIds` | `jsts`、`python` |
| `DevelopmentCodeLimits` | 目录诊断最多 200 个文件、耗时预算 20 秒（写进了 README 与交给模型的 note，是对外承诺） |

错误码直接用 core 常量表（`VALIDATION`、`NOT_FOUND`、`UNAVAILABLE`；`UNAVAILABLE` 由 core 方案补进 `CoreErrorCodes`）。

可调参数 `DevelopmentTuning`：导航缺省条数 100、目录深度 12、读源文件上限 1,000,000 字节、选文件上限 2,500；各动作选文件的倍数与上下限（25/30/40/50 倍，500–5,000）；影响面最多追 10 个声明文件、相关测试最多 50 个；TS 项目最多 2,000 个文件、依赖类型入口最多 256 个；外部语言服务请求 15 秒、等诊断 8 秒、关闭握手 1 秒、stderr 保留 4,000 字符；片段摘录 240 字符。

**要删的导出与替代**（破坏性，升 2.0.0）

| 现在 | 以后 |
| --- | --- |
| `import … from '@velaros-ai/development/runtime'` | `from '@velaros-ai/development'` |
| `executeProjectCodeLanguageQuery(input, ctx)` | `languageQueries.run(input, ctx)` |
| `new ExternalLanguageService(root, specs)` | `createExternalLanguageService(root, specs)`；类型改用 `ExternalLanguageServiceApi` |
| `configureTypeScriptLibraryDirectory(dir)` | `typeScriptProjects.configureLibraryDirectory(dir)` |
| `ProjectCodeIndexQuery`（转手） | 从 `@velaros-ai/project/contracts` 取 |

产品侧：Desktop 1 个文件、Workbench 1 个、Termel 2 个；仓内：发布门夹具 `consumer.ts`、能力归属表。

## 4. 模型面文字

- 模型经 `project:code` 看到的英文只有一条：`path is outside project: …`（`JsTsNavigation` 的 VALIDATION），改中文。其余 note/degraded 已是中文。
- `ExternalLanguageService` 的 9 条英文报错（`No installed language server is available for .py.` 等）在 Termel 里会被转交给模型或用户，改中文，命令名与扩展名原样保留。
- `referenceCount` 的口径问题见 §5-4，是模型会读的字段。

## 5. 实现层缺陷

1. **项目里 `..xxx` 目录被判成越界**：`JsTsNavigation.isInsideRoot` 用 `relative.startsWith('..')`。`language_diagnostics` 指向 `..cache/x.ts` 直接报「path is outside project」，项目内这种目录下文件的 TS 诊断也会被过滤掉。同包的 `TypeScriptProjectHost.isPathInside` 写对了（比较 `..${sep}`），两份判定不一致。统一走 platform 的 `isPathTextInside`。
2. **`find_symbols` / `list_exports` 对每个未导出符号整文件重解析**：`toSymbolRecord → isSymbolExported → extractExportsFromContent` 每次 `ts.createSourceFile`。project 的 JS/TS 适配器对未导出的声明给 `exported: false`，于是每个未导出的函数、方法、访问器、变量都触发一次全文件解析。实测 933 行的文件单次解析 1.3 ms，按语法树粗数约 220 个声明，一个文件就要约 290 ms；`find_symbols` 缺省最多扫 2,500 个文件。修法：每个文件只算一次导出名集合。`list_exports` 还对每个文件再调一次 `collectSymbolRecords`（再读一次文件、再列一次目录），一并收掉。
3. **每条 TS 诊断再整文件解析一次**：`rangeFromTypeScriptDiagnostic` 为算行列新建 `SourceFile`，而 `diagnostic.file` 本身就是解析好的 `SourceFile`。一个文件几百条诊断就是几百次解析，与 20 秒预算抢时间。
4. **`referenceCount` 名不副实**：`scanReferences` 找到 `limit + 1` 条就停止扫描，`referenceCount` 于是最多是 `limit + 1`，却和 `importerCount`（真实总数）并列交给模型。模型会以为「全项目只有 101 处引用」。改成停扫时写明「至少 N 处」（例如 `referenceCountIsLowerBound: true`），或者继续计数不继续收集——属于模型看得到的变化，列入 §7。
5. **语言服务池没有淘汰，宿主也释放不了**：每个（项目根，tsconfig）常驻一个 `ts.LanguageService`，里面是最多 2,000 个文件的全文；monorepo 里每个子包一个 tsconfig。`clearTypeScriptProjectCache` 存在但不出包。长跑的 Desktop、Termel 打开的项目越多占用越大。修法：`typeScriptProjects.release(projectRoot?)` 出包，宿主在关闭项目时调；池本身加一个按最近使用淘汰的上限（进 tuning）。复现：对一个多包仓库逐个子包跑 `language_diagnostics`，观察池里的服务数只增不减。
6. **外部语言服务把「没等到」当成「没有问题」**：`diagnostics()` 以第一条 `publishDiagnostics` 为准，8 秒没来就返回空数组。rust-analyzer 这类先发语法诊断、再发 check 结果的服务，以及 URI 写法与发出去的不完全一致时（Windows 盘符大小写与编码是常见来源），调用方都会拿到「0 条诊断」而无从分辨。至少在状态里标出超时；启动失败的服务永久记在 `unavailable`，用户装好之后要重启宿主才会再试。
7. **`test/ExternalLanguageService.test.ts` 不在 `test` 脚本里**：`package.json` 只跑 `development.test.ts` 与 `language-diagnostics.test.ts`，CI 从不跑外部语言服务的测试（手动跑是过的）。
8. 失败语义不一致（经 project 到不了，直接调用的宿主会遇到）：`find_importers` 缺 `targetPath` 与 `specifier` 时返回 `{ error: … }` 当成功结果，不抛 `VALIDATION`。
9. 每次取语言服务都把 tsconfig 解析两遍（归属判定一遍、取配置一遍），带 include 通配的根配置会展开整个仓库；随 §5-5 一起在池里缓存解析结果。

## 6. 步骤、检查与共享文件

1. 先把 §5-2、§5-3、§5-1 按原结构修掉并加用例（行为改动先落，搬家后更难比对）。
2. 搬家：类型、utils、8 个类、两个入口；注册表去副作用；池类化并加 `release`。
3. 合同与常量表；tuning；中文报错。
4. `spec/invariants.md`（建议：INV-1 语言查询只借读源码端口，不需要审批、执行、修改能力；INV-2 CodeGraph 不可用时内置动作照常、索引动作抛 UNAVAILABLE；INV-3 没扫描到文件、被截断、标准库缺失都在 note/degraded 里写明，空结果不伪装成全部通过；INV-4 目录诊断按所属 tsconfig 分组，结果与逐文件诊断一致；INV-5 外部语言服务只启动规格里给的命令、只在项目根内解析文件；INV-6 `./contracts` 不碰 Node（门禁））与验收；把第 3 个测试文件接回 `test` 脚本；`MODULE.md`；README 删掉英文段落。
5. 登记，升 2.0.0；改发布门夹具与能力归属表。project 的测试不引用本包（`project:code` 的测试用假的 `queryCode`），真实链路要在产品里验：建议在 Desktop 升级时对一个真实仓库跑一遍 `project:code` 的七个语言动作做回归。

检查：`bun scripts/ownership/check-module-ownership.mjs --only development`、`bun run --cwd packages/development test`、`bun run check:capabilities-arch`、`bun run check:host-contract-consumer`（打包安装后按 NodeNext 严格编译夹具，最能发现入口问题）、`bun run check:capabilities-schemas`、`bun run check:package-catalog`、`bun run check:lockfile-consistency`。

共享文件：`scripts/ownership/governed-modules.mjs`、`scripts/capabilities/capability-owners.mjs`（`entrySubpaths: ['.', './contracts']`）、`scripts/capabilities/check-arch-boundaries.mjs` 的 `PortableContracts`（可选登记新 `./contracts`）、`scripts/release/fixtures/host-contract-consumer/consumer.ts`、`docs/generated/package-catalog.json`、`bun.lock`。

## 7. 需要拍板

1. **`referenceCount` 改口径**（§5-4）：模型看得到的字段语义变化。建议保留字段、停扫时加一个「至少」标记，并在 project:code 的回执说明里写一句。
2. **外部诊断超时是否写进结果**（§5-6）：`ExternalLanguageServiceApi.diagnostics` 的返回形状要从数组变成「诊断 + 是否完整」，Termel 跟着改。建议改。
