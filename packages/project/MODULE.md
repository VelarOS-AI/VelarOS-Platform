# @velaros-ai/project 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 九个工具都在 `src/impl/ProjectTools.ts` 一个文件里，是最先看的地方；其次是 `src/contract/` 的三个文件（产品面登记、注入面、常量表）和各实现文件类上方的接口。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`（`--only project` 列出这个包的每一条）。

## 这是什么

项目空间的能力包：让 agent 在一个项目根里读源码、列文件、搜文本、查代码结构、按版本精确改源码、跑命令、在演练沙箱里先跑一遍再落回。
每一次改动都是一个带版本防护的事务：几个文件、几处编辑全成或全不成，可以查看、可以撤销，撤销遇到外部修改拒绝覆盖。
模型编辑只认框架签发的 fileRef：它绑定路径、版本和模型实际看到的那段源码，看不到的行改不了。

它不知道系统空间，也不知道界面长什么样；系统空间是另一个独立的包，两边互不引用。命令判定、沙箱契约这些两个空间共用的东西在能力公共件里（`@velaros-ai/shell-command`、`@velaros-ai/rehearsal-sandbox`，ADR 0008）。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/`，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对。

**产品面**，登记在 `contract/provides.ts`：类实现的 API 定义在各自类的上方、这里 re-export，没有类的公开接口直接声明在这里。

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `projectTools` | `ProjectToolCollection`，元素是 `VelaTool` | 九个模型面工具 |
| `createProjectCodeAnalysisTools` | `ProjectToolCollection` | 可选的 project:code-analysis，宿主有代码图后端时单独登记 |
| `createProjectBundledModDefinition` | `ProjectBundledModDefinition` | 项目空间作为官方内置 mod 的定义 |
| `createProjectCodeAnalysisContribution` | `ProjectCodeAnalysisContribution` | 代码图分析扩展作为可选内置 mod 的定义 |
| `createProjectSpace` | `ProjectSpace` | 一个项目根上的领域内核加九个工具 |
| `createProjectKernelModule` | 上游的 `KernelModuleDefinition` | 挂进内核的模块 |
| `ProjectCapability` | 能力令牌，服务是 `ProjectCapabilityService` | 在内核里按名调用项目工具 |
| `createProjectKernel` | `ProjectKernel` | 领域内核：读写、事务、校验、撤销、代码查询 |
| `createProjectTransactionController` | `ProjectTransactionControllerApi` | 给界面那一侧的有限事务面（`ProjectChangeFeed` 加应用、回滚） |
| `createFileProjectChangeFeed` | `FileProjectChangeFeedApi` | 落盘的变更记录，事务跨进程重启后仍能列出和回滚 |
| `projectApprovalBridge` | `ProjectApprovalBridgeApi` | 把内核的审批请求接到当前那次工具调用的审批端口 |
| `projectFileContext` | `ProjectFileContextApi` | 把项目登记成 agent 文件上下文的来源 |
| `typescriptPlugin` | `ProjectPlugin` | TypeScript 适配器、补丁策略与语法校验器 |
| `createSecretRedactionProvider` | `SecretRedactionProvider` | 按内容正则给 API key、token 打码的脱敏后端 |

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `ProjectToolContext` / `ProjectToolApi` | 是 | 宿主在每次工具调用时给：项目根、按目录执行、修改授权、跑命令、领域内核端口 `AgentProjectKernelPort`、代码查询 `queryCode`，可选的沙箱端口 `ProjectSandboxPort` |
| `CreateProjectKernelOptions` / `ProjectProviders` | 是 | 建内核时给：项目根、策略覆盖、事务状态文件、变更记录写端 `ProjectChangeFeedWriter`，以及可选的策略、审批、文件过滤、脱敏、证据包、日志、命令、遥测、代码智能后端（`PolicyProvider`、`ApprovalProvider`、`FileFilterProvider`、`SecretRedactionProvider`、`ContextProvider`、`LoggerProvider`、`CommandProvider`、`TelemetryProvider`、`ProjectCodeIntelligenceHost`） |
| `ProjectPlugin` / `ProjectPluginContext` | 否 | 插件扩展点：`FileAdapter`、`FileAdapterFactory`、`PatchStrategy`、`ProjectValidator`、`ProjectFixer`、`ProjectHook`、`PipelineStage` |
| `CreateProjectKernelModuleOptions` / `ProjectToolContextResolver` | 挂进内核且要按名调用时 | 产品壳按作用域给出一次工具调用的上下文 |

**常量表**是 `contract/constants.ts`：工具与 mod 身份（`ProjectToolNames`、`ProjectCodeAnalysisToolName`、`ProjectModId`、`ProjectCodeAnalysisModId`、`ProjectSpaceId`、`ProjectPackageVersion`）、错误原因 `ProjectErrorCodes`、入参契约版本 `ProjectToolContract`、工具排位 `ProjectToolExposure`、公开上限（`ProjectFileLimits`、`ProjectChangeLimits`、`ProjectCodeLimits`、`ProjectCommandLimits`、`ProjectSandboxLimits`、`ProjectTransactionLimits`）、内核缺省策略 `ProjectPolicyDefaults`、宿主代码查询的语言服务动作 `ProjectCodeLanguageActions`。工具说明与 schema 里的数字都引它们。

**数据面**是 `types/`，只放类型；`types/project.ts` 是可移植数据（宿主端口上流动的命令回执、授权决定、沙箱数据、宿主代码查询）。

两个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 产品面、注入面、它们用到的数据 |
| `./contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

## 骨干链路

每个工具的定义都在 `src/impl/ProjectTools.ts`，execute 一行交给 `impl/operations/` 里的执行类：

| 工具 | 链路 |
| --- | --- |
| `project:read` | 执行门读锁 → 内核 stat/read（授权、脱敏、按行列与字符预算截取）→ 源码窗口（`[行号, 原文]`）→ 文件上下文协调器定稿时签发 fileRef（绑定路径、版本、看到的范围） |
| `project:list`、`project:search` | 执行门读锁 → 内核列举（gitignore 与策略过滤）/ 搜索（有 ripgrep 用 ripgrep，没有逐文件扫）→ 搜索命中带可编辑的源码窗口 |
| `project:edit`、`project:file`、`project:change` | 执行门写锁 → 按 fileRef 取回读取时的版本与可见范围 → 规划成编辑意图（范围越界、定位不唯一在这里拒绝）→ 内核准备事务（补丁、差量、风险，不碰磁盘）→ 修改授权 → 应用（校验、审批、按版本核对、全成或全逆序还原）→ 回执带新 fileRef 与 changeRef；失败标 not-applied，入参可复用 |
| `project:code` | 执行门读锁 → 翻译成宿主代码查询（语言服务类由宿主语言服务执行，代码索引类由代码图谱执行）→ 附来源、覆盖与降级信息 |
| `project:code-analysis` | 宿主有代码图后端时单独登记 → 执行门读锁 → trace、cycles、deadcode、routing 翻译成代码索引类查询交给宿主 → 附来源与覆盖 |
| `project:run` | 命令判定（`@velaros-ai/shell-command`）→ 危险命令每次由用户亲自确认 → 会改项目的先过修改授权 → 前台在执行门里跑（只读走读锁）、后台交宿主的任务管理 |
| `project:sandbox` | create 只镜像项目之内的目录；run 在镜像里跑（危险命令照样确认）；diff 看变化；apply 向宿主要不截断的完整差量，`rehearsalSandboxRules.prepareApply` 核对并给出确认请求，过修改授权与用户确认后连同差量指纹交给宿主落回；discard 删镜像 |

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`。
- `@velaros-ai/kernel` 的 `contracts/abi`：能力令牌、内核模块定义、可调用能力服务。
- `@velaros-ai/agent` 的 `protocol` 与 `tool-contract` 子路径（peer）：工具运行时规格、mod 清单、审批端口、文件上下文协调器、入参复用、挂进内核时的可调用操作表。
- `@velaros-ai/shell-command`：命令的只读、危险、长驻判定，确认文案，危险命令的审批请求。
- `@velaros-ai/rehearsal-sandbox`：沙箱数据形状、公开上限、宿主沙箱端口形状，落回前的核对与确认请求。
- `zod`（入参 schema）、`typescript`（JS/TS 解析）、`iconv-lite`（GB18030）、`picomatch`（glob）、`diff`（差量）、`execa`（子进程）。
- 不读环境变量。

## 状态归谁

- **领域内核**：每个项目根一个 `LocalProjectKernel`，持有事务仓库（内存里保留最近的事务，可选落盘的事务状态文件）、路径锁、审计日志（内存，有上限）、解析过的目标与证据包（有上限）、插件与登记表。
- **变更记录**：宿主给的写端（落盘的用 `createFileProjectChangeFeed`，放在宿主私有目录），不给就在内存里。
- **fileRef 与续读引用**：记录存在会话的上下文载荷里（`contextPayloadStore`），没有载荷存储时退回进程内存，按作用域隔离。
- **执行门**：进程内按项目根排队，只在内存里。

## 生命周期

内核随宿主创建、随宿主丢弃，没有要释放的句柄；落盘的变更记录要 `close()`。给了事务状态文件时，重启后内核先恢复中断的应用或回滚，只还原能证明属于该事务的内容。

## 失败语义

- 错误原因只来自 `ProjectErrorCodes`，挂在 `ProjectError.reason`；经内核调用时翻成 `AppError`，原因在 `context.projectError`。
- 改动类失败在回执里标 `details.executionOutcome = 'not-applied'`，入参可复用（`inputReuse`）。
- 版本过期 `BASE_REVISION_MISMATCH`、越出可见范围或项目 `SCOPE_VIOLATION` / `PERMISSION_DENIED`、撤销遇外部修改 `CONFLICT_WITH_EXTERNAL_EDIT`、生成文件 `GENERATED_FILE`、重启恢复遇到无法归属的改动 `TRANSACTION_RECOVERY_CONFLICT`。
- 命令自己失败不抛错，如实写进回执；用户或宿主拒绝时返回 `skipped`，不执行。

## 不变量

共 12 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 10 条、类型 1 条、门禁 1 条。未验证 0 条。

## 非目标

- 不管项目以外的文件和系统级操作：那是系统空间；项目工具出不了项目根。
- 不做 Git 界面、项目根管理、文件树可见性这些产品功能：它们归产品壳。
- 不自己跑语言服务和代码图谱：`project:code` 把查询交给宿主的语言服务与代码图谱后端。

## 结构

```text
src/
  contract/     对外合同：provides.ts（产品面，登记类上方接口）、requires.ts（注入面）、constants.ts（常量表）
  types/        只放类型，按域分文件；project.ts 是可移植数据
  impl/         一类一文件，按层分子目录（上层可以引下层）：
    ProjectTools.ts    九个工具的定义、分组、内置 mod、内核挂载、项目空间
    operations/        工具背后的执行类：文件、改动、执行、代码，执行门、审批桥、文件上下文登记
    kernel/            领域内核 LocalProjectKernel，有限事务面，命令与脱敏后端
    plugins/           核心插件、TypeScript 插件与它们的校验器
    transactions/ files/ strategies/ adapters/ registries/ persistence/   事务、文件访问、补丁策略、文件适配器、登记表、持久化
  utils/        纯函数与可调参数（tuning.ts）；agent/（Agent 适配）、editing/（编辑规划）、files/（文件读写）、kernel/、transactions/ 按域分子目录
  exports/      两个入口，只有转发
spec/           不变量登记、验收测试与测试替身
test/           实现细节测试；test/support 是第 1 版工具驱动器与旧协议 schema
```

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记，扩展点与宿主端口在 `contract/requires.ts`。类的公开方法只能是接口里的方法；用不着实例状态的私有逻辑进 utils。继承 `Error` 的错误类（`ProjectError`）只有字段，放在 utils。

| 层 | 实现文件 | 接口 |
| --- | --- | --- |
| 工具 | `ProjectTools.ts` | 没有类 |
| operations | `ProjectFileOperations`、`ProjectChangeOperations`、`ProjectExecutionOperations`、`ProjectCodeOperations`、`ProjectExecutionGate`、`ProjectApprovalBridge`、`ProjectFileContext` | 同名加 `Api`，写在各自类上方 |
| kernel | `LocalProjectKernel` | `ProjectKernel`（provides 登记）、`ProjectPluginContext`（requires）、`LocalProjectKernelStartup` |
| kernel | `ProjectTransactionController` | `ProjectTransactionControllerApi`（provides 登记） |
| kernel | `NodeCommandProvider`、`PatternSecretRedactionProvider` | `CommandProvider`、`SecretRedactionProvider`（requires） |
| plugins | `CoreProjectPlugin`、`TypeScriptProjectPlugin` | `ProjectPlugin`（requires） |
| plugins | `ScopeValidator`、`PostconditionValidator`、`TypeScriptSyntaxValidator` | `ProjectValidator`（requires） |
| transactions | `TransactionPlanner`、`TransactionCoordinator`、`TransactionOverlay`、`TransactionValidation`、`TransactionStateMachine`、`TransactionRepository`、`TransactionProjectionRepository`、`TransactionRecovery`、`LockManager` | 同名加 `Api` |
| files | `FileStore`、`ProjectQueries`、`ProjectGitIndex` | 同名加 `Api` |
| strategies | `PreparedContentStrategy`、`TextPatchStrategy`、`JsonPatchStrategy`、`JsTsPatchStrategy` | `PatchStrategy`（requires） |
| adapters | 纯文本、JSON、Markdown、通用代码、JS/TS 各一个 `XxxFileAdapter` 与 `XxxFileAdapterFactory` | `FileAdapter`、`FileAdapterFactory`（requires） |
| registries | 适配器、补丁策略、校验器、修复器、hook、流水线、插件七个登记表 | 同名加 `Api` |
| persistence | `AuditJournal`、`FileProjectTransactionStateStore`、`FileProjectChangeFeed`、`MemoryProjectChangeFeed`、`BaseProjectChangeFeed` | 同名加 `Api`；变更记录实现 `ProjectChangeFeedWriter`（requires），落盘的另有 `FileProjectChangeFeedApi`（provides 登记） |

**常量分四处。** 对外承诺的在 `contract/constants.ts`，每个数字一句说明；可调的在 `utils/tuning.ts` 的 `ProjectTuning`，按用途分组、每项一句说明；某个类里固定用的写成那个类的 `private static readonly`；规则数据（命令名单、状态转移表）跟着规则留在各自的 utils 文件里。以上由门禁核对。
