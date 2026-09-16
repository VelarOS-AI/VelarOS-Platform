# @velaros-ai/cli 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/VelarosCliRouter.ts` 类上方的接口（`contract/provides.ts` 登记它），注入面在 `contract/requires.ts`，常量表在 `contract/constants.ts`。
> 门禁：`bun run check:module-ownership`。

## 这是什么

VelarOS 唯一的正式命令行发行包，装出来的可执行文件叫 `velaros`。
它只做两件事：把命令行第一段路由到对应的**运维命名空间**，以及给出稳定的输出信封与退出码。
命令本身不在它手里——`velaros terminal` 起的是独立发行的 Termel，产品自己的运维命令由产品注册进来。

它刻意不承载模型工具：Project、System、Browser、Office、Memory 的能力留在 Mod 工具面，不复制成 `velaros <域> tools ...` 的第二套入口。
它也不扫 PATH、不自动发现命令——命令集合只由代码里的注册决定，不随机器环境漂移。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：两件能力的 API 定义在各自的类上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `velarosCli` | `VelarosCliRouterApi` | 带内置命名空间的默认路由器，`bin/velaros.mjs` 用的就是它 |
| `createVelarosCliRouter` | `VelarosCliRouterApi` | 按产品自己的命名空间组一份路由器（入参是 `VelarosCliRouterOptions`），给产品开发者的扩展点 |
| `velarosCliProcess` | `VelarosCliProcessApi` | 进程壳能力：吃 `VelarosCliProcessContext`（`process.argv` 与 `process.env`），写标准输出／标准错误，返回退出码 |
| `VelarosCliEnvelope` | 契约常量 | 信封的结构版本与失败信封的 `kind` |
| `VelarosCliErrorCodes` | 契约常量 | 命令行自己会给出的三个错误码 |
| `VelarosCliExitCodes` | 契约常量 | 对外承诺的退出码：0／1／2／127，以及信号退出码的基数 |
| `CliEnvironmentVariables` | 契约常量 | 本包读的环境变量表（`VELAROS_TERMEL_COMMAND`） |

**注入面**是 `contract/requires.ts` 里的 `VelarosCliNamespaceRunner`：宿主注册进来的一个运维命名空间，拿到去掉第一段之后的参数，自己跑完给出可打印结果。

**数据面**是 `types/cli.ts`（可移植）：`VelarosCliRunOptions`、`VelarosCliEnvironment`、`VelarosCliNamespaceRunResult`、`VelarosCliSuccessEnvelope`、`VelarosCliErrorEnvelope` 与它们用到的 `VelarosCliStatus`。

两个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 进程：装配自己的命令行、嵌入路由器 | 路由器、工厂、进程壳、注入面，加上可移植数据 |
| `./contracts` | 任何进程，含渲染进程与浏览器 | 常量表与信封的数据形状，只用来解析 `--json` 输出 |

装出来的命令不在这两个入口里：`package.json` 的 `bin` 指向包根的 `bin/velaros.mjs`，它只有三行，把 `process.argv`／`process.env` 交给 `velarosCliProcess`。

## 骨干链路

本包没有模型工具，链路按每件事列：

| 事情 | 链路 |
| --- | --- |
| 跑一条命令 | `bin/velaros.mjs` → `velarosCliProcess.run({ argv, environment })` → 剥掉前两项 → `velarosCli.run(argv, { environment })` → 命名空间 → 结果文本按退出码走 stdout 或 stderr → 退出码交回进程 |
| 根帮助 | `run([])`／`help`／`--help`／`-h` → `utils/output.ts` 的 `buildRootHelpText(namespaces)` → 中文帮助；带 `--json` 时给成功信封，`result` 是当前注册的命名空间 |
| 路由到命名空间 | `run(argv)` 取第一段 → 在冻结的注册表里找执行器 → 找到就把 `argv.slice(1)` 与 `{ ...options, cwd }` 交过去，结果原样透出 |
| 未知命名空间 | 抛 `VelarosCliError('UNKNOWN_NAMESPACE', …, 2)` → 被 `run` 自己的 catch 收住 → `buildErrorResult` → 失败信封 |
| 命名空间抛错 | 同一个 catch → `normalizeVelarosCliError` 收成 `EXECUTION_ERROR`（退出码 1），原始文字进 `message` |
| 起 Termel | `terminal` → `TerminalNamespace.run` → 读 `VELAROS_TERMEL_COMMAND`（不设时 `termel`）→ `spawn(command, argv, { stdio: 'inherit' })`，Windows 走 shell → 子进程退出码原样透出 |

## 依赖什么

- `@velaros-ai/core`：`AppError.getMessage`、`stringifyPretty`、`isFalse`、`isNotNull`、`readErrnoCode`。
- `@velaros-ai/platform`：`currentPlatform.isWindows()`，用来决定起 Termel 时要不要过 shell（Windows 上 npm 装出来的是 `termel.cmd` 垫片）。
- Node 内置：`node:child_process` 起子进程、`node:os` 读信号号。两者只在 `impl/TerminalNamespace.ts` 里，`./contracts` 这条链上一个都没有。
- 环境变量只读一个 `VELAROS_TERMEL_COMMAND`，登记在常量表里。

## 状态归谁

路由器的状态只有构造时定下、之后不再变的四样：命名空间注册表（冻结）、按字典序排好的名字（冻结）、读时间的方式、取当前目录的方式。
没有缓存、没有磁盘状态、没有全局变量；同一份路由器可以并发调用。
进程壳自己不持状态，只持一份路由器；标准输入输出与退出码归进程，不归本包。

## 生命周期

没有需要释放的东西。`velarosCli` 与 `velarosCliProcess` 随进程存在；`velaros terminal` 起的子进程随它自己的生命周期结束，本包只等它退出。
`import` 本包不启动任何东西：`src/` 下全是声明与类，要跑起来只有 `bin/velaros.mjs` 这一个入口。

## 失败语义

- 路由器永不向宿主抛：未知命名空间给 `UNKNOWN_NAMESPACE`（退出码 2），命名空间抛的任何异常收成 `EXECUTION_ERROR`（退出码 1），宿主拿到的永远是可打印结果。
- `velaros terminal` 找不到可执行文件时给 `TERMEL_NOT_INSTALLED`（退出码 127），不报成执行失败——用户要做的是装 Termel，不是看堆栈。
- 子进程的退出码原样透出；被信号杀死时按 POSIX 惯例报 128 加信号号。
- 文字一律中文，命令名、错误码、环境变量名原样夹在里面；自动化按 `error.code` 判断，不按文字。
- 错误类不出包：外面只拿得到失败信封。

## 不变量

共 9 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 8 条、门禁 1 条。未验证 0 条。

## 非目标

- 不做模型工具的第二套入口：领域能力留在 Mod 工具面，本包不复制它们的参数与权限。
- 不拥有 Termel：运行时、界面、配置、凭据、Extension Bridge 都不在这里，本包只负责把它启动起来。
- 不做命令发现：不扫 PATH、不读安装目录、不维护领域白名单；命令集合只由注册决定。
- 不管进程生命周期：不调 `process.exit`、不装信号处理，退出码交回可执行文件。

## 结构

```text
bin/            可执行入口（不在 src）：velaros.mjs 三行壳，把 process.argv/process.env 交给 velarosCliProcess
src/
  contract/     对外合同：provides.ts 登记两件能力的 API（定义在类上方），requires.ts 是唯一的注入点 VelarosCliNamespaceRunner，constants.ts 是信封字段、错误码、退出码与环境变量表
  types/        只放类型：cli.ts 是可移植数据（运行选项、两种信封、命名空间结果），output.ts 是造信封用的包内工作类型
  impl/         一类一文件：VelarosCliProcess（进程壳）、VelarosCliRouter（路由器与工厂、默认实例）、TerminalNamespace（velaros terminal）
  utils/        errors.ts 是错误类与归一化（错误类不出包），output.ts 是信封、文本与根帮助
  exports/      两个入口，只有转发
spec/           不变量登记与验收测试
```

**分层。** 从上到下三层，下层不引上层：进程壳 → 路由器 → 命名空间。`utils/` 在所有层之下，谁都可以用。

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记，类的公开方法只能是接口里的方法。整个进程只需要一份的类，在文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `VelarosCliProcess.ts` | `VelarosCliProcessApi`（同文件，provides 登记） | 把进程参数与环境交给路由器，写标准输出／标准错误，算出退出码 |
| `VelarosCliRouter.ts` | `VelarosCliRouterApi`（同文件，provides 登记） | 命名空间集合与一次路由；失败一律收成信封，永不向宿主抛 |
| `TerminalNamespace.ts` | `TerminalNamespaceApi`（同文件，包内用） | 起独立发行的 Termel，标准输入输出直通，退出码原样透出 |
