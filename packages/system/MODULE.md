# @velaros-ai/system 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 本包没有自己的模型面：模型看到的是四件能力的声明（`baselines/code-surface/files.d.ts`、`images.d.ts`、`shell.d.ts`、`sandbox.d.ts`）。
> 代码这一侧最先看 `src/impl/SystemSpace.ts` 的装配表，其次是 `src/contract/` 的三个文件和各实现文件类上方的接口。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

系统空间：让 agent 在用户的整台机器上读写文件、跑命令、追踪后台任务、演练脚本，每一步都过宿主的审批边界。它由两件东西组成：

- **本地内核**：本机能力的实现——命令与后台任务、交互式控制台、shell 选择与自检、进程约束、演练沙箱引擎，外加宿主自己的界面要的进程、端口、指标与全局搜索。
- **系统空间的装配表**：一个空间就是一张表——给哪几件能力、每件能力用哪个端口。能力本身不在本包，是 `@velaros-ai/velar` 里的能力单元：`velar:files`（本机文件，系统空间专用；项目空间用的是 `velar:project`）、`velar:images`、`velar:shell`、`velar:sandbox`，一件能力只有一份实现。本包只写系统空间的端口：路径可以是本机任意位置、`~` 展开到家目录，读写不问用户，写是逐个原子替换（撤回新建时核对后删掉），命令在本机任意目录跑，沙箱能镜像任意目录，看图能看本机任意位置的图。

它不知道「项目」是什么，也不知道界面长什么样；项目空间是另一个包，两边互不引用。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/` 的公开数据文件，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `createSystemSpace` | `SystemSpaceApi` | 系统空间：一张操作表，`files`、`shell`、`sandbox` 三个命名空间配上系统空间的端口，交给 `createCapabilityPort` 接成能力端口。**表里没有一个字是给模型看的**；入参合不合法由那件能力自己拦 |
| `createLocalSystemKernel` | `LocalSystemKernelApi` | 本地内核：系统空间要的本机能力，外加宿主界面要的环境体检、指标、搜索、进程、端口、终止任务，以及交互式任务控制台的写输入、读增量输出、发中断 |

**注入面**，写在 `contract/requires.ts`：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `SystemSpaceHost` | 装系统空间时必须 | 系统空间要的本机能力：路径解析、跑命令与管后台任务的四件事、演练沙箱的四件事、列出登记着的沙箱。本机实现就是本地内核；它自己声明的两个方法（`resolvePath`、`listSandboxes`）都有装配表在调，门禁核对 |
| `SystemCallContext` | 必须 | 宿主每次分发调用时给：取消信号、审批端口 `ApprovalPort`（来自 agent 包）、会话、可选的交图通道 |
| `LocalSystemKernelOptions` | 用本地内核时必须 | 创建本地内核时给 |
| `SystemProcessConfinementProvider` | 可选 | 放在本地内核配置里，没有内置约束后端的平台靠它 |
| 环境变量，全部登记在 `SystemEnvironmentVariables` | 可选 | 三个输入变量由宿主设，三个标记变量由本包写给子进程 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`，只放值。`./contracts` 入口就是常量表（错误码 `SystemErrorCodes`、环境变量表 `SystemEnvironmentVariables`）加可移植数据 `types/system.ts`（进程、端口、指标、控制台与终止的请求、全局搜索、运行平台）。引用到 shell 能力数据的内核数据（终止结果、控制台增量输出与控制结果、环境体检）在 `types/host.ts`，进程约束的请求与结果在 `types/commands.ts`，都从根入口导出。命令回执、后台任务、shell 描述这些 `velar:shell` 也用的数据在 `@velaros-ai/velar/shell/contracts`，本地内核直接用它们；沙箱的数据形状在 `@velaros-ai/velar/sandbox/contracts`。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器 | 可移植数据 |

**未接线**：`createSystemSpace` 还没有消费者，产品壳那边的 `code:run` 门尚未建。

## 骨干链路

| 链路 | 怎么走 |
| --- | --- |
| 系统空间的一次调用 | 模型的程序调 `read(...)` / `run(...)` / `create(...)` → 能力端口按命名空间找到装配表里那一格 → `resolveCall` 给出这一次调用的审批通道、取消信号、会话 → 装成那件能力要的上下文（端口在构造时装好一次，上下文每次现装）→ 交给 `fileOperations` / `shellOperations` / `sandboxOperations` |
| `velar:files` 的系统端口 | `locate`：`host.resolvePath`（`~` 与相对路径）→ 解开符号链接得到真实目标；读写前不问用户；`commit`：按顺序写或删——写是补建上级目录后原子替换（同目录临时文件写完 fsync 再改名，权限位原样保留，核对 expected），删（撤回一次新建）是核对 expected 之后删掉；出错时在 context.applied 里点名已做的 |
| `velar:images` 的系统端口 | `locate`：`host.resolvePath` → 解开符号链接得到真实目标；`resizeImage`：只在 macOS 上给，sips 先裁后缩、分两次调 |
| `velar:shell` 的系统端口 | `resolveCwd`：`host.resolvePath`；`commandPolicy`：确认文案说在哪个目录（没给就是系统运行环境），风险分类 `system-command:dangerous`；跑命令、列后台任务、刷新环境、终止后台任务直接交给本地内核 |
| `velar:sandbox` 的系统端口 | 建、看差量、落回、丢弃直接交给本地内核；`resolveSource`：`host.resolvePath`；`runInSandbox`：按沙箱 id 找到镜像根，交给 `host.runCommand`（cwd 落在镜像根里，内核就换成钉死在镜像里的执行器）；落回不问用户 |
| 本地内核跑命令 | `runCommand` 解析 cwd → cwd 在某个沙箱根里就交给那个沙箱的执行器，否则交给主执行器 `SystemCommandRunner.run` → 选 shell（挑定的种类本机没有就以 `VALIDATION` 拒绝、一个进程都不起；宿主给了 nativeCommand 就走原生 argv）→ 进程约束 → 受管进程启动 → 采集解码 → 超时 / 取消收敛 → 验证摘要 → 后台登记。每一步见 `SystemCommandRunner.ts` 类上方的说明 |
| 本地内核的演练沙箱 | `SystemSandboxes`：镜像源目录（gitignore 忽略的目录按 ignored 处理，剪掉推送地址，指向源目录外的 `.git` 链接不进镜像）→ 清单落在沙箱目录旁 → 差量按清单算 → 落回先核对源目录、再暂存、再挪到位 → 丢弃只删基目录下正好一层 |

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`、真实路径解析。
- `@velaros-ai/code-surface`：操作表的形状（`CapabilityOperationTable`）。
- `@velaros-ai/velar`：四件能力单元的操作与端口形状（`files`、`images`、`shell`、`sandbox`）；shell 单元另给命令回执与后台任务的数据形状、命令判定，sandbox 单元另给沙箱的数据形状与公开上限。
- `@velaros-ai/agent` 的 `tool-contract` 子路径：审批端口类型、审批操作身份。
- `@velaros-ai/path-rules`：.gitignore 的解析与判定、遍历时的忽略策略（全局搜索与沙箱镜像共用一份）。
- `@velaros-ai/text-files`：原子替换写入（fsync、权限位精确保留、拒绝多硬链接、核对 expected）、读文件头、按编码解码（全局搜索用）。
- `@velaros-ai/platform`：跨平台兼容层（路径、shell、进程命令）。
- `diff`：沙箱差量的文本补丁。

## 状态归谁

- **后台任务表**：每个本地内核持有一个命令执行器，任务表归它私有，在内存里，随内核 `dispose()` 结束；每条任务留到现在的全部输出，只守内存的上限（`ShellLimits.outputChars`，超出只留末尾）；列任务不设条数。已结束的任务只留最近 200 条。
- **交互式任务的控制台缓冲**：和任务表一起归命令执行器，在内存里，每个控制台留最近 10 万字符，更早的输出被挤掉时读取方会拿到 `droppedChars`；随 `dispose()` 清空。
- **演练沙箱登记表**：本地内核持有一份（`SystemSandboxes`），每个沙箱一条记录和一个约束到镜像根的专属执行器；镜像与清单在临时区 `velaros-sandbox/<id>/` 下，内核重启后按清单重新登记；`dispose()` 只停进程，不删镜像。
- **受管子进程登记表**：整个进程一份（`systemProcessManager`），已结束的进程最多保留 512 条回执。
- **能撤回的改动**：不归本包，在 `velar:files` 的文件操作里（`@velaros-ai/velar/files`）。
- **shell 选择**：不缓存，每次运行前重新自检。本机可用的清单由 `inspectEnvironment().shells` 给出（第一个就是默认那个），宿主拿它写进每回合给模型的环境报告。
- **审批记忆**：不归本模块。危险命令的确认请求由 `velar:shell` 造，记不记、记多久由宿主的 `ApprovalPort` 决定。

## 生命周期

- 系统空间的端口在构造时装好一次（它们只依赖宿主）；调用上下文**不缓存**，每次调用都向宿主要一次——审批通道与取消信号是这一次调用的。
- 本地内核由宿主创建；`dispose()` 停掉它管理的后台执行。
- 后台任务由 `run` 的后台模式创建，`listTasks` 查询，模型要停它就用 `run` 执行任务条目里的 `terminateCommand`；宿主自己的界面经本地内核的 `terminateBackgroundTask` 终止。
- 交互式任务就是一条带控制台的后台任务：用户经本地内核的 `writeConsoleInput`、`readConsoleOutput`、`interruptConsole` 与它打交道；写入最多等 `SystemTuning.command.consoleWriteTimeoutMs`，进程没读走就如实报「已排队」。
- 前台命令：超时或取消后一定在期限内收敛，清理没做完就如实标 `cleanupIncomplete`。

## 失败语义

- **默认失败关闭。** 找不到可用 shell 抛 `SYSTEM_SHELL_UNAVAILABLE`；受约束模式没有后端抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`，不退回裸进程。
- **macOS 的约束只管得住文件写，证据如实报 `enforcement: partial`。** Seatbelt 拦住写到写根之外，也堵上了经 cfprefsd 代写偏好设置、发 Apple 事件这两条路；其余由系统服务代办的事拦不全。
- **命令本身失败不是模块错误。** 退出码、超时、取消都如实进回执，`success` 为 false，`verification` 摘要输出末尾。
- 文件与看图的失败语义见各自的能力单元；本包的端口只多两种：写或删的时候文件被别人改了（`VALIDATION`，说明里写明），没有写权限（`PERMISSION`）。
- 演练沙箱：没有约束后端建不出；落回时源文件自建沙箱以来变过、或上级路径是符号链接整批不落（`SYSTEM_SANDBOX_CONFLICT`，冲突列在 message 与 context.conflicts 里）；确认之后镜像又变过整批不落（`SYSTEM_SANDBOX_CHANGED`）；暂存拷不全什么都不落，挪到位的途中失败不回滚、已落回的路径在 message 与 context.applied 里点名；镜像根里的命令遇到读不出来的清单拒绝执行；丢弃时 id 不合形状、这一项是符号链接、路径不在基目录下面一层就拒绝。
- 完整错误码语义见 `src/contract/constants.ts` 里的 `SystemErrorCodes`；代码面把码与说明交给程序，外面按错误码判断，不按错误类。

## 不变量

共 19 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排，空号的去向写在登记表开头。
按检验方式：测试 18 条、门禁 1 条。未验证 0 条。

## 非目标

- 不写能力本身：读写文件、跑命令、演练沙箱的操作各在自己的包里，本包只给系统空间的端口。
- 不做项目感知：不发现项目、不读项目配置、不做开发环境诊断。空间之间的切换和协作是宿主的事。
- 不做授权决策与权限记忆：读写文件、落回沙箱都不问人（ADR 0009）；危险命令的确认由 `velar:shell` 造，决定权在宿主。
- 不提供 Electron 专属能力：通知、安装建议界面由产品壳扩展。
- 不内置 Windows 的进程约束后端：需要受约束执行的 Windows 宿主自己注入 provider，否则明确失败。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面，requires.ts 注入面，constants.ts 错误码与环境变量表
  types/        只放类型，按域分文件：system.ts 是可移植数据，host.ts 是引用 shell 数据的内核数据，commands.ts 是进程约束与命令执行的工作类型，
                sandbox.ts 是沙箱引擎的工作类型，processes.ts 是平台命令的解析结果，paths.ts 是路径判定的工作数据
  impl/         扁平，一个类一个文件，文件名就是类名
  utils/        纯工具函数，按类别分文件；每个函数上方一句中文说明；tuning.ts 是全包的可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
spec/           不变量登记与验收测试
test/           实现细节测试
```

**看代码的顺序**：三份生成的声明（模型看到的全部）→ `SystemSpace.ts` 的装配表 → `contract/` 的三个文件 → 需要时看 utils 里函数上方的一句说明。

**常量分四处。** 对外承诺的（错误码、环境变量）在 `contract/constants.ts`；模型看得见的上限在各能力包的常量表里。包内可调的（超时、缓冲、保留条数、缺省条数、阈值）都在 `utils/tuning.ts` 的 `SystemTuning`。某个类里固定用的文案写成那个类的 `private static readonly`。规则本身的数据（敏感路径名单、凭证文件名单）跟着规则留在各自的 utils 文件里。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。类的公开方法只能是接口里的方法；私有方法只放用得到实例状态的逻辑。继承 `Error` 的错误类没有方法，不写接口，也不出包。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `SystemSpace.ts` | `SystemSpaceApi`（同文件，provides 登记） | 系统空间的装配表：四件能力配上系统空间的端口 |
| `LocalSystemKernel.ts` | `LocalSystemKernelApi`（同文件，provides 登记），扩展 `SystemSpaceHost`（requires） | 本机能力的实现，只做转接 |
| `SystemSandboxes.ts` | `SystemSandboxesApi`（同文件） | 演练沙箱登记表：镜像、差量、落回、丢弃，每个沙箱一个约束到镜像根的执行器 |
| `SystemCommandRunner.ts` | `SystemCommandRunnerApi`（同文件） | 跑命令：前台采集，后台登记成任务、可查可停；交互式任务另带控制台 |
| `SystemShellResolver.ts` | `SystemShellResolverApi`（同文件） | 找 shell、自检、判断命令在不在、刷新 Windows 环境变量 |
| `SystemProcessManager.ts` | `SystemProcessManagerApi`（同文件） | 受管子进程登记表 |
| `SystemManagedProcess.ts` | `ManagedSystemProcess`（同文件） | 单个受管子进程的超时、取消、有界终止与收尾 |
| `SystemOutputDecoder.ts` | `SystemOutputDecoderApi`（同文件） | 子进程输出的 UTF-8 解码 |
| `SystemGlobalSearch.ts` | `SystemGlobalSearchApi`（同文件） | 全局搜索：按路径或按内容遍历目录树，给宿主界面用 |
| `SystemShellUnavailableError.ts` | 错误类，不写接口 | 找不到能用的 shell |

实现分四层，上层可以调下层，下层不调上层：系统空间（`SystemSpace.ts`）→ 宿主（`LocalSystemKernel.ts`）→ 本机能力（命令、沙箱、进程、shell、搜索）→ shell 错误类。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，只引 utils、types 与合同。

`./contracts` 入口会被渲染进程加载，它的整条引用链不碰 Node 模块。`contract/` 的三个文件改了等于改对外契约，要在差量报告里点名。
