# @velaros-ai/velar/shell 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/code-surface/shell.d.ts`（由 `@AgentView` 从 `ShellOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/` 三个类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:code-surface`。

## 这是什么

agent 代跑一条 shell 命令的能力，所有空间共用一份：执行前判断它是不是只读、危不危险、是不是长驻服务、能不能和别的调用并发，
给出确认文案，构造危险命令的审批请求；再往上是代码面的 `velar:shell` 命名空间（`run`、`listTasks`、`refreshEnvironment`）。

**能力不绑空间**：`velar:shell` 只有这一份实现，每个空间注入自己的 `ShellSpacePort`——工作目录相对谁、越界算不算、
确认文案怎么写、谁真正起进程，都在端口里。模型那边因此只有一套说明，两个空间看到的是同一份声明与代码模版。
本包不起进程、不读写文件；根入口不碰 Node 模块，渲染进程也能加载。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：三件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `shellOperations` | `ShellOperationsApi` | 代码面 `shell` 命名空间的三个操作：解析工作目录、分类、要确认的先问、钳上限、调空间端口、整形回执 |
| `shellCommandPolicy` | `ShellCommandPolicyApi` | 执行前分类（只读、危险、长驻、端口）、并发判定、确认文案 |
| `shellCommandApproval` | `ShellCommandApprovalApi` | 危险命令的审批请求：文案加高风险手动确认选项，操作身份跨入口一致 |
| `ShellCommandOperationKind` | 契约常量 | 危险命令审批的操作身份种类 |
| `ShellCommandKinds` | 契约常量 | 模型能为一条命令挑的 shell 种类封闭词表，所有 `shell` 字段都取它；派生类型 `ShellCommandKind` |
| `ShellLimits` | 契约常量 | `velar:shell` 的公开上限：超时、输出字符、任务条数 |
| `VelarShellModule` | 生成的合同（`contract/surface.ts`） | `velar:shell` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/code-surface/shell.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |

**数据面**是 `types/`：`types/shell-command.ts` 是可移植数据（命令分类 `ShellCommandPlan`、并发判定的入参与选项；
`velar:shell` 的入参与回执；宿主端口上流动的命令数据：`ShellRunCommandOptions`、`ShellCommandResult`、后台任务、控制台、shell 描述、空间口径 `ShellCommandSpacePolicy`），
`types/approval.ts` 是审批请求的入参与结果（引用 agent 的确认选项类型，从根入口导出），`types/invocation.ts` 是判定内部的工作类型。

两个入口对应包清单 `exports` 里的 `./shell` 与 `./shell/contracts`，源文件是单元目录上的 `index.ts` 与 `contracts.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./shell` | Node 宿主与渲染进程 | 三件能力、空间端口、它们用到的数据 |
| `./shell/contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `ShellSpacePort` | 每个挂 `velar:shell` 的空间一份：`resolveCwd`（作用域）、`commandPolicy`（确认文案与风险分类的口径），加上真正跑命令的 `runCommand`、`listBackgroundTasks`、`refreshShellEnvironment`（本机实现是 `@velaros-ai/system` 的本地内核） |
| `ShellOperationContext` | 宿主每次分发 `shell` 命名空间的调用时装好：取消信号、上面那个端口、审批端口、会话 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 代码面 `shell` 命名空间 | 模型的程序调 `run(...)` → `shellOperations.run`：核对取消信号 → `ctx.shell.resolveCwd`（越界在确认之前拒绝）→ `shellCommandPolicy.analyze` → 要确认的按 `ctx.shell.commandPolicy` 的口径经 `ctx.approval` 问（危险命令走 `shellCommandApproval.dangerous` 的手动确认，长驻命令是低风险确认），被拒抛错、一个进程都不起 → 钳超时与输出上限 → `ctx.shell.runCommand` → 后台回执补上端口、理由、是否自动转后台；要了交互式却没拿到控制台时补一句 note。`listTasks` 钳条数后按会话查，`refreshEnvironment` 直接交给端口 |
| 选哪个 shell | 词表 `ShellCommandKinds` 只定取值，不做判定分叉：判定是这五种语法的并集（`rm -rf`、`rd /s`、`Remove-Item -Recurse` 同时认），模型挑哪一种都不会让判定变松；本机有哪几个由环境报告给出，宿主在执行之前核对 |
| 执行前分类 | `shellCommandPolicy.analyze(command)`：去首尾空白 → 危险黑名单（递归删除、丢未提交改动的 git、提权、格式化磁盘等，给出理由）→ 长驻判定（开发服务器、监听）→ 只读判定（白名单命令，逐段看参数、前缀、环境变量赋值、git 全局选项与子命令、sed 整段脚本，出现重定向、子 shell、后台符、换行整条否决）→ 端口提取 |
| 并发判定 | `shellCommandPolicy.isParallelSafe(input, { optIn })`：命令必须是字符串、不转后台、只读、无需确认；optIn（缺省）时还要求入参显式 `parallel: true` |
| 危险命令审批 | `shellCommandApproval.dangerous(input)` → 文案（命令、理由、递归删除的仓库提醒、是否后台、端口）+ `agentToolContracts.createManualApprovalOptions`（高风险、手动、不记忆）+ 操作身份 `agentToolContracts.createApprovalOperationKey('shell-command', { 命令, 工作目录, 前后台 })` → 调用方交给自己的审批端口 |

## 依赖什么

- 上游包：`@velaros-ai/core`（几个类型守卫、`AppError`）；`@velaros-ai/agent` 的 `tool-contract`（手动确认选项、操作身份、审批端口）与 `contracts`（确认选项类型），peer 依赖。
- 只在验收里用：`@velaros-ai/code-surface`（dev 依赖），跑那几条端到端的程序、给代码模版做类型检查。
- 不碰 Node 内置模块：根入口与 `./contracts` 整条引用链门禁核对。
- 不读环境变量。

## 状态归谁

没有状态：三个类都只持有常量与别的无状态实例，判定是纯函数。后台任务、控制台、shell 选择归空间端口背后的宿主。

## 生命周期

没有需要释放的东西。三个实例随进程存在。

## 失败语义

- 判定不抛错：认不出的命令一律判非只读、不危险；空命令什么都不是（不只读、不危险、不长驻）。
- 判定方向是固定的：只读判定宁可误判成「非只读」（多一次修改授权、少一次并发），危险判定宁可误判成「危险」（多弹一次确认）；真正的授权门在宿主的审批端口。
- `shell` 命名空间上的失败一律是抛错：cwd 越界由端口抛（`PERMISSION`），用户拒绝由审批端口抛，挑了本机没有的 shell 由宿主在执行之前抛（`VALIDATION`）。代码面把它们变成模型程序里能 `try/catch` 的异常。
- 命令自己失败（非零退出、超时）不是异常：回执里 `success` 为假，`verification.issues` 带输出末尾。

## 不变量

共 9 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 8 条、门禁 1 条。未验证 0 条。

## 非目标

- 不起进程、不管进程：跑命令、后台任务、控制台、shell 选择是空间端口背后宿主的事。
- 不决定作用域：cwd 相对哪个根解析、越界算不算，全由空间注入的 `ShellSpacePort` 说了算。
- 不在模型面上写空间的差别：模型只看到一份声明；「这个空间里相对路径相对谁」由环境报告和端口的报错说清楚。

## 结构

```text
shell/
  contract/     对外合同：provides.ts 登记三件能力的 API，requires.ts 是空间端口与调用上下文，constants.ts 是操作身份、shell 词表与公开上限；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：shell-command.ts 是可移植数据，approval.ts 是审批请求的入参与结果，invocation.ts 是判定内部的工作类型
  impl/         一类一文件：ShellOperations（velar:shell）、ShellCommandPolicy（判定的唯一出口）、ShellCommandApproval（审批请求）
  utils/        command-policy.ts 是判定本身，limits.ts 是钳上限；全是纯函数，每个函数上方一句说明
  index.ts      `./shell` 入口，只转发
  contracts.ts  `./shell/contracts` 入口，只转发
  template.js   代码模版，嵌进生成声明的模块头
  spec/         不变量登记与验收测试
  test/         实现细节测试
```

**分层。** 上层是 `ShellOperations.ts`（代码面的三个操作），下层是 `ShellCommandPolicy.ts` 与 `ShellCommandApproval.ts`（互不依赖）；上层调下层；演练沙箱的 `run` 也用下层判危险命令、构造审批请求。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记；类的公开方法只能是接口里的方法。整个进程只需要一份，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ShellOperations.ts` | `ShellOperationsApi`（同文件，provides 登记） | 代码面 `shell` 命名空间的三个操作 |
| `ShellCommandPolicy.ts` | `ShellCommandPolicyApi`（同文件，provides 登记） | 执行前分类、并发判定、确认文案的唯一出口 |
| `ShellCommandApproval.ts` | `ShellCommandApprovalApi`（同文件，provides 登记） | 危险命令的审批请求 |
