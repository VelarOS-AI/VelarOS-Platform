# @velaros-ai/velar/shell 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/shell.d.ts`（由 `@AgentView` 从 `ShellOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/` 三个类上方的接口（`contract/provides.ts` 登记它们），本机实现看 `impl/local/LocalShellHost.ts` 与 `ConfinedShellRunner.ts`；utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

agent 代跑一条 shell 命令的能力，所有空间共用一份：执行前判断它是不是只读、危不危险、是不是长驻服务、能不能和别的调用并发，
给危险命令构造审批请求（确认文案加手动确认选项）；再往上是代码面的 `velar:shell` 命名空间（`run`、`listTasks`、`stop`、`refreshEnvironment`）。

**能力不绑空间**：`velar:shell` 只有这一份实现，每个空间注入自己的 `ShellSpacePort`——工作目录相对谁、越界算不算、
确认文案怎么写、谁真正起进程，都在端口里。模型那边因此只有一套说明，两个空间看到的是同一份声明与代码模版。

**本机实现也在这里**（`./local` 入口，只给 Node）：真正跑命令的是本机 shell 宿主 `LocalShellHost`——命令与后台任务、交互式控制台、
shell 选择与自检、进程约束、Windows 原生进程宿主，外加宿主自己的界面要的路径解析、环境体检、指标、进程与端口；
还有受约束执行器 `ConfinedShellRunner`，把命令钉在一个根目录里跑，演练沙箱的每个镜像根用一个。
装空间是产品的事（ADR 0013）：产品把本机宿主接成 `ShellSpacePort` 的执行那一半，自己补作用域与口径。
根入口与 `./contracts` 不碰 Node 模块，渲染进程也能加载（本机实现只从根入口导出类型）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `shellOperations` | `ShellOperationsApi` | 代码面 `shell` 命名空间的四个操作：解析工作目录、分类、危险命令先问、钳超时、调空间端口、把宿主的完整回执整成模型用得上的那几项 |
| `shellCommandPolicy` | `ShellCommandPolicyApi` | 执行前分类（只读、危险、长驻、端口）、并发判定 |
| `shellCommandApproval` | `ShellCommandApprovalApi` | 危险命令的审批请求：文案加高风险手动确认选项，操作身份跨入口一致 |
| `ShellCommandOperationKind` | 契约常量 | 危险命令审批的操作身份种类 |
| `ShellCommandKinds` | 契约常量 | 模型能为一条命令挑的 shell 种类封闭词表，所有 `shell` 字段都取它；派生类型 `ShellCommandKind` |
| `ShellLimits` | 契约常量 | `velar:shell` 的公开上限：超时、输出字符、任务条数 |
| `VelarShellModule` | 生成的合同（`contract/surface.ts`） | `velar:shell` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/shell.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |
| `createLocalShellHost` | `LocalShellHostApi`（`./local` 入口） | 本机 shell 宿主：`ShellHostPort` 的四件事在本机上的实现，外加宿主界面要的路径解析、环境体检、指标、进程、端口、带完整记录的终止、控制台三件事与释放 |
| `createConfinedShellRunner` | `ConfinedShellRunnerApi`（`./local` 入口） | 受约束执行器：命令钉在一个根目录里跑（只许写根与它自己的临时目录，网络按建时的选择），建的时候先探测约束后端 |
| `ShellErrorCodes` | 契约常量 | 本机宿主的专属错误码：`SHELL_UNAVAILABLE`（找不到能用的 shell）、`SHELL_CONFINEMENT_UNAVAILABLE`（要约束却没有后端） |
| `ShellEnvironmentVariables` | 契约常量 | 本机宿主读写的全部环境变量：三个输入（`VELAROS_SHELL_PATH`、`VELAROS_GIT_BASH`、`VELAROS_PROCESS_HOST`）、三个写给子进程的标记 |

**数据面**是 `types/`：`types/shell-command.ts` 是可移植数据（命令分类 `ShellCommandPlan`、并发判定的入参与选项；
`velar:shell` 的入参与回执；宿主端口上流动的命令数据：`ShellRunCommandOptions`、`ShellCommandResult`、后台任务、控制台、shell 描述、空间口径 `ShellCommandSpacePolicy`；
本机宿主给宿主界面的数据：进程 `SystemProcessInfo`、端口 `SystemOpenPortInfo`、资源快照 `SystemMetricsSnapshot`、控制台的请求与增量输出、
带完整记录的终止结果 `ShellTaskTerminateReport`、环境体检 `ShellEnvironmentInspection`），
`types/approval.ts` 是审批请求的入参与结果（引用 agent 的确认选项类型，从根入口导出），`types/invocation.ts` 是判定内部的工作类型，
`types/local.ts` 是本机实现的工作类型（进程约束的策略、请求与结果从根入口导出），`types/processes.ts` 是平台命令的解析结果。

三个入口对应包清单 `exports` 里的 `./shell`、`./shell/contracts` 与 `./shell/local`，源文件是单元目录上的 `index.ts`、`contracts.ts` 与 `local.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./shell` | Node 宿主与渲染进程 | 操作、命令策略、审批请求，空间端口，本机实现的接口与配置，它们用到的数据 |
| `./shell/contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |
| `./shell/local` | Node 宿主 | 本机实现的两个工厂：`createLocalShellHost`、`createConfinedShellRunner` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `ShellSpacePort` | 每个挂 `velar:shell` 的空间一份：`resolveCwd`（作用域）、`commandPolicy`（确认文案与风险分类的口径），加上执行那四件（`ShellHostPort`） |
| `ShellHostPort` | `ShellSpacePort` 的执行那一半：`runCommand`、`listBackgroundTasks`、`refreshShellEnvironment`、`terminateBackgroundTask`；本机实现是 `createLocalShellHost`，项目端口在它外面再套一道项目资源门 |
| `ShellOperationContext` | 宿主每次分发 `shell` 命名空间的调用时装好：取消信号、上面那个端口、审批端口、会话 |
| `LocalShellHostOptions` | 用本机宿主时必须，创建时给：工作目录、家目录、平台、普通命令的进程约束策略、约束后端 |
| `ConfinedShellRunnerOptions` | 建受约束执行器时必须：根目录、临时目录、网络开关、平台、约束后端 |
| `ShellProcessConfinementProvider` | 可选，放在上面两份配置里：没有内置约束后端的平台（Windows）靠它，缺了就在受约束模式下、以及建受约束执行器时失败关闭 |
| 环境变量，全部登记在 `ShellEnvironmentVariables` | 可选：三个输入变量由宿主设，三个标记变量由本单元写给子进程 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 代码面 `shell` 命名空间 | 模型的程序调 `run(...)` → `shellOperations.run`：核对取消信号 → `ctx.shell.resolveCwd`（越界在确认之前拒绝）→ `shellCommandPolicy.analyze` → 危险命令按 `ctx.shell.commandPolicy` 的口径走 `shellCommandApproval.dangerous` 的手动确认、经 `ctx.approval` 问，被拒抛错、一个进程都不起（别的命令不问）→ 钳超时，输出只按内存上限收（不折叠）→ `ctx.shell.runCommand` → 回执只留模型用得上的那几项，后台的补上端口与是否自动转后台；要了交互式却没拿到控制台时补一句 note。`listTasks` 按会话查、不设条数，每条带到现在的全部输出；`stop` 按会话经 `ctx.shell.terminateBackgroundTask` 停；`refreshEnvironment` 交给端口后整成默认 shell、可用清单与一句说明 |
| 选哪个 shell | 词表 `ShellCommandKinds` 只定取值，不做判定分叉：判定是这五种语法的并集（`rm -rf`、`rd /s`、`Remove-Item -Recurse` 同时认），模型挑哪一种都不会让判定变松；本机有哪几个由环境报告给出，宿主在执行之前核对 |
| 执行前分类 | `shellCommandPolicy.analyze(command)`：去首尾空白 → 危险黑名单（递归删除、丢未提交改动的 git、提权、格式化磁盘等，给出理由）→ 长驻判定（开发服务器、监听）→ 只读判定（白名单命令，逐段看参数、前缀、环境变量赋值、git 全局选项与子命令、sed 整段脚本，出现重定向、子 shell、后台符、换行整条否决）→ 端口提取 |
| 并发判定 | `shellCommandPolicy.isParallelSafe(input, { optIn })`：命令必须是字符串、不转后台、只读、不危险；optIn（缺省）时还要求入参显式 `parallel: true` |
| 危险命令审批 | `shellCommandApproval.dangerous(input)` → 文案（命令、理由、递归删除的仓库提醒、是否后台、端口）+ `agentToolContracts.createManualApprovalOptions`（高风险、手动、不记忆）+ 操作身份 `agentToolContracts.createApprovalOperationKey('shell-command', { 命令, 工作目录, 前后台 })` → 调用方交给自己的审批端口 |
| 本机宿主跑命令 | `LocalShellHost.runCommand` 解析 cwd（`~` 展开到家目录、相对路径相对工作目录）→ 命令执行器 `ShellCommandRunner.run` → 选 shell（挑定的种类本机没有就以 `VALIDATION` 拒绝、一个进程都不起；宿主给了 nativeCommand 就走原生 argv）→ 进程约束 → Windows 上包进原生进程宿主 → 受管子进程启动 → 采集解码 → 超时 / 取消收敛 → 验证摘要 → 后台登记。每一步见 `ShellCommandRunner.ts` 类上方的说明 |
| 受约束执行器 | `createConfinedShellRunner` 先按「只许写根与临时目录」探测约束后端（没有就抛 `SHELL_CONFINEMENT_UNAVAILABLE`）→ 建一个配好这份约束的命令执行器（TMPDIR 指进临时目录、git 不许交互式要口令）→ `run` 一律前台跑完，cwd 固定是根 |
| 宿主界面 | 环境体检：自检过的默认 shell、本机可用的全部 shell、给定命令在不在；指标：CPU、内存、交换区、系统盘、负载各自定级，外加最占资源的几个进程；进程与端口：跑平台命令读出来、先过滤再截条数；控制台：写输入（缺省补回车，有时限）、读增量（挤掉的如实报）、发中断 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、缺席值、日志、`AppError`、计时器作用域）；`@velaros-ai/agent` 的 `tool-contract`（手动确认选项、操作身份、审批端口）与 `contracts`（确认选项类型），peer 依赖；
  `@velaros-ai/platform`（本机实现用：跨平台的路径、shell 参数、进程与指标命令）。
- 只在验收里用：`@velaros-ai/code-surface`（dev 依赖），跑那几条端到端的程序、给代码模版做类型检查。
- 根入口与 `./contracts` 整条引用链不碰 Node 内置模块，门禁核对；`./local` 只给 Node。
- 环境变量只在本机实现里读写，全部登记在 `ShellEnvironmentVariables`。

## 状态归谁

模型面这一半没有状态：三个类都只持有常量与别的无状态实例，判定是纯函数。本机实现的状态：

- **后台任务表**：每个本机宿主持有一个命令执行器，任务表归它私有，在内存里，随 `dispose()` 结束；每条任务留到现在的全部输出，只守内存的上限（`ShellLimits.outputChars`，超出只留末尾）；已结束的任务只留最近 200 条。
- **交互式任务的控制台缓冲**：和任务表一起归命令执行器，每个控制台留最近 10 万字符，更早的被挤掉时读取方拿到 `droppedChars`。
- **受管子进程登记表**：整个进程一份（`shellProcessManager`），已结束的进程最多保留 512 条回执。
- **shell 选择**：不缓存，每次运行前重新自检；本机可用的清单由 `inspectEnvironment().shells` 给出（第一个就是默认那个）。
- **受约束执行器**：谁建谁持有（演练沙箱每个镜像根一个），`dispose()` 停掉它起的进程。

## 生命周期

模型面的三个实例随进程存在，没有需要释放的东西。本机宿主由宿主创建，`dispose()` 停掉它管理的后台执行；后台任务由 `run` 的后台模式创建，
`listTasks` 查询、`stop` 或宿主界面经 `terminateBackgroundTask` 终止；交互式任务就是一条带控制台的后台任务，写入最多等 `ShellTuning.command.consoleWriteTimeoutMs`。
前台命令超时或取消后一定在期限内收敛，清理没做完就如实标 `cleanupIncomplete`。

## 失败语义

- 判定不抛错：认不出的命令一律判非只读、不危险；空命令什么都不是（不只读、不危险、不长驻）。
- 判定方向是固定的：只读判定宁可误判成「非只读」（少一次并发、少一次无人值守放行），危险判定宁可误判成「危险」（多弹一次确认）。
- `shell` 命名空间上的失败一律是抛错：cwd 越界由端口抛（`PERMISSION`），用户拒绝由审批端口抛，挑了本机没有的 shell 由宿主在执行之前抛（`VALIDATION`）。代码面把它们变成模型程序里能 `try/catch` 的异常。
- 命令自己失败（非零退出、超时）不是异常：回执里 `success` 为假，`verification.issues` 带输出末尾。
- 本机实现默认失败关闭：找不到可用 shell 抛 `SHELL_UNAVAILABLE`；受约束模式没有后端抛 `SHELL_CONFINEMENT_UNAVAILABLE`，不退回裸进程。
- macOS 的约束只管得住文件写，证据如实报 `enforcement: partial`（Seatbelt 拦住写到写根之外，也堵上了经 cfprefsd 代写偏好设置、发 Apple 事件这两条路）；未受约束如实报 `enforcement: none`。
- 后台任务不属于请求里的会话：`PERMISSION`；任务或进程不存在：`NOT_FOUND`；平台命令本身失败：`PLATFORM`。

## 不变量

共 16 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。INV-11～INV-16 是本机宿主的承诺（进程约束、输出、生命周期、shell 选择），随实现从 `@velaros-ai/system` 搬来（原 INV-5、6、10、11、12、30，ADR 0013）。
按检验方式：测试 15 条、门禁 1 条。未验证 0 条。

## 非目标

- 模型面不起进程：操作只经空间端口跑命令；真正起进程的是端口背后的宿主（本机上就是 `./local` 的本机宿主）。
- 不装空间：哪个空间挂 `velar:shell`、给它哪个作用域，是产品的事（ADR 0013）。
- 不决定作用域：cwd 相对哪个根解析、越界算不算，全由空间注入的 `ShellSpacePort` 说了算。
- 不内置 Windows 的进程约束后端：需要受约束执行的 Windows 宿主自己注入约束后端，否则明确失败。
- 不在模型面上写空间的差别：模型只看到一份声明；「这个空间里相对路径相对谁」由环境报告和端口的报错说清楚。

## 结构

```text
shell/
  contract/     对外合同：provides.ts 登记能力的 API，requires.ts 是空间端口、调用上下文与本机实现的配置，constants.ts 是操作身份、shell 词表、公开上限、本机宿主的错误码与环境变量表；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：shell-command.ts 是可移植数据，approval.ts 是审批请求的入参与结果，invocation.ts 是判定内部的工作类型，local.ts 是本机实现的工作类型，processes.ts 是平台命令的解析结果
  impl/         一类一文件：ShellOperations（velar:shell）、ShellCommandPolicy（判定的唯一出口）、ShellCommandApproval（审批请求）；local/ 是本机实现
  utils/        command-policy.ts 是判定本身，limits.ts 是钳上限，results.ts 把宿主的回执整成模型看的样子；本机实现的 process、shells、confinement、command-result、system-info、output；tuning.ts 是本机宿主的可调参数
  native/       Windows 原生进程宿主（C++ 源码与构建脚本，构建产物在 native/win32-<架构>/），随包发布
  index.ts      `./shell` 入口，只转发
  contracts.ts  `./shell/contracts` 入口，只转发
  local.ts      `./shell/local` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/         不变量登记与验收测试
  test/         实现细节测试
```

**分层。** 上层是 `ShellOperations.ts`（代码面的四个操作）与 `local/`（本机实现，互不依赖），下层是 `ShellCommandPolicy.ts` 与 `ShellCommandApproval.ts`（互不依赖）；上层调下层；演练沙箱的 `run` 也用下层判危险命令、构造审批请求。
`local/` 里：本机宿主与受约束执行器 → 命令执行器 → shell 选择、受管子进程登记表、单个受管子进程、输出解码 → shell 不可用的错误类。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ShellOperations.ts` | `ShellOperationsApi`（同文件，provides 登记） | 代码面 `shell` 命名空间的四个操作 |
| `ShellCommandPolicy.ts` | `ShellCommandPolicyApi`（同文件，provides 登记） | 执行前分类、并发判定的唯一出口 |
| `ShellCommandApproval.ts` | `ShellCommandApprovalApi`（同文件，provides 登记） | 危险命令的审批请求 |
| `local/LocalShellHost.ts` | `LocalShellHostApi`（同文件，provides 登记），扩展 `ShellHostPort`（requires） | 本机 shell 宿主，只做转接 |
| `local/ConfinedShellRunner.ts` | `ConfinedShellRunnerApi`（同文件，provides 登记） | 受约束执行器：命令钉在一个根目录里跑 |
| `local/ShellCommandRunner.ts` | `ShellCommandRunnerApi`（同文件） | 跑命令：前台采集，后台登记成任务、可查可停；交互式任务另带控制台 |
| `local/ShellResolver.ts` | `ShellResolverApi`（同文件） | 找 shell、自检、判断命令在不在、刷新 Windows 环境变量 |
| `local/ShellProcessManager.ts` | `ShellProcessManagerApi`（同文件） | 受管子进程登记表 |
| `local/ShellManagedProcess.ts` | `ManagedShellProcess`（同文件） | 单个受管子进程的超时、取消、有界终止与收尾 |
| `local/ShellOutputDecoder.ts` | `ShellOutputDecoderApi`（同文件） | 子进程输出的 UTF-8 解码 |
| `local/ShellUnavailableError.ts` | 错误类，不写接口 | 找不到能用的 shell |
