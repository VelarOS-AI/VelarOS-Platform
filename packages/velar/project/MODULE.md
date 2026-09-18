# @velaros-ai/velar/project 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是两份生成的声明：`baselines/code-surface/project.d.ts`（`velar:project`）与 `code.d.ts`（`velar:code`），那是模型看到的全部。
> 最先看两个操作类上方的接口（`impl/operations/ProjectFileOperations.ts`、`ProjectCodeOperations.ts`），其次是 `contract/` 的三个文件（产品面登记、注入面、常量表）。
> 代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`（`--only velar/project` 列出这个单元的每一条）、`bun run check:code-surface`、`bun run check:project-arch`。

## 这是什么

项目的两件工具，连同它们底下的项目内核：

- **`velar:project`**：受项目治理的文件。读出来的是带行号与版本的源码窗口，窗口上的 fileRef 绑定路径、版本和实际交出去的那几行；
  一次 edit 的步骤（create、overwrite、move、delete、recode、edit）编成一个带版本防护的事务：全成或全不成、跑校验器、可以查看、可以撤销，撤销遇到外部修改拒绝覆盖。
  局部编辑只能改 fileRef 看得到的行，overwrite 要求看过全文，move、delete 只核对版本；文件在读完之后被改过时，按原意图给出新位置与新 fileRef。
- **`velar:code`**：问代码之间的关系（定义、引用、调用、依赖、影响面、诊断），查询交给宿主的语言服务与代码图谱；它要用内核的符号表与读取核对目标，所以和 `velar:project` 住在同一个单元。
- **项目内核**：读取授权与脱敏、受保护与生成文件、校验器、带版本防护的事务、撤销账本、变更记录——就是「受项目治理」的那套治理。宿主按项目根建一个，经空间端口交给两件工具。

两件工具不认识任何空间：项目根、内核、修改授权、代码查询都从空间端口 `ProjectSpacePort` 要。把它们与共用的命令、沙箱、看图装配在一起、给那三件装项目端口的，
是项目空间 `@velaros-ai/project`。项目资源门（同一项目根上写串行、读并发）在这里，空间里的前台命令也排进同一扇门。
本机文件（`velar:files`，系统空间）与这里的项目文件是两件能力：项目的读取治理、事务与校验器是项目的规则，不往系统空间套。

## 提供什么

本单元对外只有三个面，都由接口控制：导出的类型只能来自 `contract/`（provides 登记的接口、requires、constants）和 `types/`，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对。

**产品面**，登记在 `contract/provides.ts`：类实现的 API 定义在各自类的上方、这里 re-export，没有类的公开接口直接声明在这里。

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `projectFileOperations` | `ProjectFileOperationsApi` | `velar:project` 的六个操作：read、list、search、edit、inspect、undo |
| `projectCodeOperations` | `ProjectCodeOperationsApi` | `velar:code` 的两个操作：query、analyze |
| `projectExecutionGate` | `ProjectExecutionGateApi` | 项目资源门：按项目根排队，读之间共享、写独占、排队的写者不被后来的读者饿死；两件工具与项目空间里的前台命令共用这一扇 |
| `createProjectKernel` | `ProjectKernel` | 领域内核：读写、事务、校验、撤销、代码查询 |
| `createProjectTransactionController` | `ProjectTransactionControllerApi` | 给界面那一侧的有限事务面（`ProjectChangeFeed` 加应用、回滚） |
| `createFileProjectChangeFeed` | `FileProjectChangeFeedApi` | 落盘的变更记录，事务跨进程重启后仍能列出和回滚 |
| `projectApprovalBridge` | `ProjectApprovalBridgeApi` | 把内核的审批请求接到当前那次调用的审批端口 |
| `typescriptPlugin` | `ProjectPlugin` | TypeScript 适配器、补丁策略与语法校验器 |
| `createSecretRedactionProvider` | `SecretRedactionProvider` | 按内容正则给 API key、token 打码的脱敏后端 |
| `VelarProjectModule` | 生成的合同（`contract/surface.ts`） | `velar:project` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/project.d.ts` 同一份）；项目空间挂这件能力时交给代码面的门 |
| `VelarCodeModule` | 生成的合同（`contract/surface.ts`） | `velar:code` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/code.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `ProjectOperationContext` / `ProjectSpacePort` | 是 | 空间每次分发调用时给：取消信号、审批端口、会话，以及空间端口——项目根、领域内核端口 `AgentProjectKernelPort`、修改授权（撤销前问）、代码查询 `queryCode`。项目空间的宿主端口在它之上再加命令、沙箱与缩图，那是给共用能力用的 |
| `CreateProjectKernelOptions` / `ProjectProviders` | 是 | 建内核时给：项目根、策略覆盖、事务状态文件、变更记录写端 `ProjectChangeFeedWriter`，以及可选的策略、审批、文件过滤、脱敏、证据包、日志、命令、遥测、代码智能后端（`PolicyProvider`、`ApprovalProvider`、`FileFilterProvider`、`SecretRedactionProvider`、`ContextProvider`、`LoggerProvider`、`CommandProvider`、`TelemetryProvider`、`ProjectCodeIntelligenceHost`） |
| `ProjectPlugin` / `ProjectPluginContext` | 否 | 插件扩展点：`FileAdapter`、`FileAdapterFactory`、`PatchStrategy`、`ProjectValidator`、`ProjectFixer`、`ProjectHook`、`PipelineStage` |

**常量表**是 `contract/constants.ts`：版本 `ProjectPackageVersion`（与 `@velaros-ai/velar` 同一个，写进内置插件）、错误原因 `ProjectErrorCodes`、脱敏占位符 `ProjectRedactionMarker`、
公开上限与模型面缺省值（`ProjectFileLimits`、`ProjectCodeLimits`、`ProjectCommandLimits`、`ProjectTransactionLimits`）、内核缺省策略 `ProjectPolicyDefaults`、宿主代码查询的语言服务动作 `ProjectCodeLanguageActions`。
模型面声明里的数字都引它们；沙箱的上限在 `@velaros-ai/velar/sandbox` 的 `RehearsalSandboxLimits`，看图的在 `@velaros-ai/velar/images` 的 `ImageLimits`。

**数据面**是 `types/`，只放类型；`types/files.ts` 是 `velar:project` 的模型面（入参与回执），`types/code.ts` 是 `velar:code` 的，
`types/project.ts` 是可移植数据（空间端口上流动的修改授权请求与决定、写授权判定、宿主代码查询）。

两个入口对应 `@velaros-ai/velar` 的 `package.json` 里 `./project` 与 `./project/contracts` 两个子路径，源文件是单元根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./project` | Node 宿主 | 产品面、注入面、它们用到的数据 |
| `./project/contracts` | 任何进程，含浏览器 | 常量表、可移植数据与两件工具随包发布的模型面 |

## 骨干链路

项目空间的操作表每次调用都交来一份这一次的上下文（`ProjectOperationContext`），两个操作类按它办：

| 能力 | 链路 |
| --- | --- |
| `project.read` | 资源门读锁 → 入参核对 → 路径钳在项目内（按真实路径）→ 内核 read（授权、脱敏、按行列与字符预算截取）→ 源码窗口（`[行号, 原文]`，长行给带列范围的片段）→ 按实际交出去的行签发 fileRef（同一份源码的几个窗口共用可见范围的并集）与续读页 |
| `project.list`、`project.search` | 资源门读锁 → 内核列举（gitignore 与策略过滤，按稳定指纹分页）/ 搜索（有 ripgrep 用 ripgrep，没有逐文件扫）→ 搜索命中合成可编辑的源码窗口（总量有上限，装不下的只留位置） |
| `project.edit` | 资源门写锁 → 步骤里的路径钳在项目内 → 编辑规划：按 fileRef 取回读取时的版本与可见范围，编成内核的编辑意图（范围越界、定位不唯一在这里拒绝，版本过期时按原意图找新位置）→ 带着要写的路径过宿主的修改授权 → 内核准备事务（补丁、差量、风险，不碰磁盘）→ 应用（校验、审批、按版本核对、全成或全逆序还原）→ 回执带改动处的新窗口（新 fileRef）与 changeRef |
| `project.inspect`、`project.undo` | changeRef 取回事务 → inspect 给差量；undo 过修改授权后在写锁里交内核回滚（外部改过拒绝覆盖，撤过的幂等成功） |
| `code.query`、`code.analyze` | 资源门读锁 → 翻译成宿主代码查询（语言服务类由宿主语言服务执行，代码索引类由代码图谱执行）→ 附来源、覆盖与降级信息 |

失败一律交给 `projectFailure`：代码面只把 `error.code` 与 `error.message` 交给程序，所以原因码当错误码，details 里的位置（第几步第几处）、候选、诊断、改完之后的预览与下一步都写进 message。

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`。
- `@velaros-ai/agent` 的 `tool-contract` 子路径（peer）：审批端口与确认选项；`@velaros-ai/tool-contract`：审批桥给确认请求起的操作身份。
- `@velaros-ai/path-rules`：glob 匹配（策略名单、include/exclude 都经 `utils/glob.ts` 调它，大小写按盘的规矩）、.gitignore 判定与列举时的忽略策略（`git check-ignore` 的执行口由本包注入）。
- `@velaros-ai/platform`：路径文本的包含判定与本平台的大小写规矩。
- `@velaros-ai/text-files`：磁盘文本的编码识别、严格解码、按原编码无损写回（GB18030 下保留没改片段的原字节）、原子替换写入、有界读与流式读；它的失败在 `utils/errors.ts` 的 `projectErrorFromTextFile` 一处按错误码翻成 `ProjectError`。
- `typescript`（JS/TS 解析）、`diff`（差量）、`execa`（子进程）。
- 不读环境变量。

## 状态归谁

- **领域内核**：每个项目根一个 `LocalProjectKernel`，持有事务仓库（内存里保留最近的事务，可选落盘的事务状态文件）、路径锁、审计日志（内存，有上限）、解析过的目标与证据包（有上限）、插件与登记表。可撤销历史按条数和字节预算（`ProjectTuning.persistence.historyBytes`，内存与状态文件共用）双重淘汰，最旧先出；还没应用的事务与正在写盘的事务永远保留，所以历史再大也不会让提交失败。
- **变更记录**：宿主给的写端（落盘的用 `createFileProjectChangeFeed`，放在宿主私有目录），不给就在内存里。
- **fileRef、续读页与回执引用**：按会话存在进程内存里（`utils/agent/file-refs.ts`），每个会话有条数与字符数上限，最久没用的先出；进程重启后全部作废，重读就是。
- **资源门**：进程内按项目根排队，只在内存里。

## 生命周期

内核随宿主创建、随宿主丢弃，没有要释放的句柄；落盘的变更记录要 `close()`。给了事务状态文件时，重启后内核逐个恢复中断的应用或回滚（并发的事务各有各的恢复点），只还原能证明属于该事务的内容。

## 失败语义

- 错误原因只来自 `ProjectErrorCodes`，挂在 `ProjectError.reason`；交给程序时原因码就是 `error.code`，说明、位置、候选、诊断与下一步都在 `error.message` 里。
- 改动类失败一个文件都没写（`details.executionOutcome = 'not-applied'`）；程序改好入参重提即可。
- 版本过期（文件或列举出的目录）`BASE_REVISION_MISMATCH`；range 超出看到的范围 `SCOPE_VIOLATION`；路径出了项目 `PERMISSION_DENIED`；撤销遇外部修改 `CONFLICT_WITH_EXTERNAL_EDIT`；生成文件 `GENERATED_FILE`；受保护文件 `PROTECTED_FILE`；重启恢复遇到无法归属的改动 `TRANSACTION_RECOVERY_CONFLICT`；宿主缺能力 `NOT_SUPPORTED`；模型给的正则写错或跑不完 `INVALID_INPUT`。
- 改动已被字节预算挤出可撤销历史时，撤销报 `NOT_SUPPORTED` 并说明没有留下撤销记录（改动本身仍在变更记录里可查）；记录已经不在内核里是 `TARGET_NOT_FOUND`，引用本身不是本会话签发的才是 `INVALID_INPUT`。撤销一个已经撤销过的改动是幂等成功，不是错误。

## 不变量

共 19 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排（INV-15 作废；INV-7、INV-16、INV-21 随项目空间搬去 `@velaros-ai/project`，编号都不复用）。
按检验方式：测试 17 条、类型 1 条、门禁 1 条。未验证 0 条。

## 非目标

- 不管项目以外的文件和系统级操作：那是系统空间（`velar:files`）；两件工具出不了项目根。
- 不装配空间、不给共用能力装端口：那是 `@velaros-ai/project`。
- 不做 Git 界面、项目根管理、文件树可见性这些产品功能：它们归产品壳。
- 不自己跑语言服务和代码图谱：`velar:code` 把查询交给宿主的语言服务与代码图谱后端。
- 不做「当前文件视图」这类自动进上下文的东西：代码面里只有程序的返回值与显式输出进上下文。

## 结构

```text
project/
  contract/     对外合同：provides.ts（产品面，登记类上方接口）、requires.ts（注入面）、constants.ts（常量表）；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型，按域分文件；project.ts 是可移植数据，files.ts、code.ts 是两件工具的模型面
  impl/         一类一文件，按层分子目录（上层可以引下层）：
    operations/        velar:project 与 velar:code 的操作类、项目资源门
    kernel/            领域内核 LocalProjectKernel，有限事务面，命令、审批与脱敏后端
    plugins/           核心插件、TypeScript 插件与它们的校验器
    transactions/ files/ strategies/ adapters/ registries/ persistence/   事务、文件访问、补丁策略、文件适配器、登记表、持久化
  utils/        纯函数与可调参数（tuning.ts）；agent/（两件工具的适配层）、editing/（编辑规划）、files/（文件读写）、kernel/、transactions/ 按域分子目录
  template.js       velar:project 的代码模版
  code-template.js  velar:code 的代码模版
  index.ts      `./project` 入口，只转发
  contracts.ts  `./project/contracts` 入口，只转发
  spec/         不变量登记、验收测试与测试替身
  test/         实现细节测试；test/support 是两件工具的测试夹具与内核编辑意图的 schema
```

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记，扩展点与空间端口在 `contract/requires.ts`。类的公开方法只能是接口里的方法；用不着实例状态的私有逻辑进 utils。继承 `Error` 的错误类（`ProjectError`）只有字段，放在 utils。

| 层 | 实现文件 | 接口 |
| --- | --- | --- |
| operations | `ProjectFileOperations`、`ProjectCodeOperations`、`ProjectExecutionGate` | 同名加 `Api`，写在各自类上方（provides 登记） |
| kernel | `LocalProjectKernel` | `ProjectKernel`（provides 登记）、`ProjectPluginContext`（requires）、`LocalProjectKernelStartup` |
| kernel | `ProjectTransactionController` | `ProjectTransactionControllerApi`（provides 登记） |
| kernel | `NodeCommandProvider`、`ProjectApprovalBridge`、`PatternSecretRedactionProvider` | `CommandProvider`、`ProjectApprovalBridgeApi`（provides 登记）、`SecretRedactionProvider`（requires） |
| plugins | `CoreProjectPlugin`、`TypeScriptProjectPlugin` | `ProjectPlugin`（requires） |
| plugins | `ScopeValidator`、`PostconditionValidator`、`TypeScriptSyntaxValidator` | `ProjectValidator`（requires） |
| transactions | `TransactionPlanner`、`TransactionCoordinator`、`TransactionOverlay`、`TransactionValidation`、`TransactionStateMachine`、`TransactionRepository`、`TransactionProjectionRepository`、`TransactionRecovery`、`LockManager` | 同名加 `Api` |
| files | `FileStore`、`ProjectQueries`、`ProjectGitIndex` | 同名加 `Api` |
| strategies | `PreparedContentStrategy`、`TextPatchStrategy`、`JsonPatchStrategy`、`JsTsPatchStrategy` | `PatchStrategy`（requires） |
| adapters | 纯文本、JSON、Markdown、通用代码、JS/TS 各一个 `XxxFileAdapter` 与 `XxxFileAdapterFactory` | `FileAdapter`、`FileAdapterFactory`（requires） |
| registries | 适配器、补丁策略、校验器、修复器、hook、流水线、插件七个登记表 | 同名加 `Api` |
| persistence | `AuditJournal`、`FileProjectTransactionStateStore`、`FileProjectChangeFeed`、`MemoryProjectChangeFeed`、`BaseProjectChangeFeed` | 同名加 `Api`；变更记录实现 `ProjectChangeFeedWriter`（requires），落盘的另有 `FileProjectChangeFeedApi`（provides 登记） |

**常量分四处。** 对外承诺的在 `contract/constants.ts`，每个数字一句说明；可调的在 `utils/tuning.ts` 的 `ProjectTuning`，按用途分组、每项一句说明；某个类里固定用的写成那个类的 `private static readonly`；规则数据（命令名单、状态转移表）跟着规则留在各自的 utils 文件里。以上由门禁核对。
