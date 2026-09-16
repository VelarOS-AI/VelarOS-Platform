# @velaros-ai/system 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 七个工具都在 `src/impl/SystemTools.ts` 一个文件里，是最先看的地方；其次是 `src/contract/` 的三个文件（产品面登记、注入面、常量表）和各实现文件类上方的接口，每个类做什么、每个方法做什么都写在那里。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

系统空间的能力包：让 agent 在用户的整台机器上读写文件、跑命令、追踪后台任务，并且每一步都过宿主的审批边界。找文件、搜文本、看进程和端口、终止进程都用 `system:run` 跑系统命令；本地内核另外给宿主自己的界面提供结构化的搜索、进程和端口接口。

它不知道"项目"是什么，也不知道界面长什么样；项目空间是另一个独立的包，两边互不引用、互不提及。该用哪个空间是宿主的责任和提示词约束：宿主发现用户在系统空间里做项目，就提示切到项目空间；项目空间要用系统能力，就派一个系统空间的子 agent 去做。界面与 Electron 专属能力由产品壳负责。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/contract/`（provides 登记的接口、requires、constants）和 `src/types/` 的公开数据文件，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，登记在 `contract/provides.ts`：类实现的 API 定义在各自类的上方、这里 re-export，没有类的公开接口直接声明在这里。交给外面的整件能力：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `systemTools` | `SystemToolCollection`，元素是 `VelaTool` | 七个模型面工具 |
| `createSystemBundledModDefinition` | `SystemBundledModDefinition` | 系统空间作为官方内置 mod 的定义 |
| `createSystemKernelModule` | 上游的 `KernelModuleDefinition` | 挂进内核的模块 |
| `SystemCapability` | 能力令牌，服务是 `SystemCapabilityService` | 在内核里按名调用系统工具 |
| `createLocalSystemKernel` | `LocalSystemKernelApi` | 宿主端口的本机实现，外加宿主界面要的搜索、进程、端口、终止任务，以及交互式任务控制台的写输入、读增量输出、发中断 |

**注入面**，写在 `contract/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `SystemToolContext`，里面是宿主端口 `SystemToolSystemApi` 与上游审批端口 `ApprovalPort` | 必须 | 宿主每次调工具时给。端口只有八个方法（路径解析、后台任务、刷新环境、跑命令，以及演练沙箱的建、看差量、落回、丢弃），每个都有工具在调，门禁核对 |
| `SystemToolContextResolver`，放在 `CreateSystemKernelModuleOptions` 里 | 挂进内核且要按名调用时必须 | 创建内核模块时给 |
| `LocalSystemKernelOptions` | 用本地内核时必须 | 创建本地内核时给 |
| `SystemProcessConfinementProvider` | 可选 | 放在本地内核配置里，没有内置约束后端的平台靠它 |
| 环境变量，全部登记在 `SystemEnvironmentVariables` | 可选 | 四个输入变量由宿主设，三个标记变量由本包写给子进程 |

**数据面**是 `types/`，只放类型；**常量表**是 `contract/constants.ts`，只放值。`./contracts` 入口就是常量表加可移植数据类型文件 `types/system.ts`：工具身份表 `SystemToolNames`、`SystemToolCategoryByName`，身份常量 `SystemModId`、`SystemSpaceId`，错误码 `SystemErrorCodes`，环境变量表 `SystemEnvironmentVariables`，公开上限 `SystemFileLimits`、`SystemCommandLimits`、`SystemFailureLimits`（工具说明与 schema 里的数字都引它们），以及经宿主端口流动的数据结构。演练沙箱的数据形状与上限在公共包 `@velaros-ai/rehearsal-sandbox/contracts`（`SandboxRecord`、`SandboxDiff`、`RehearsalSandboxLimits` 等），宿主端口直接用它们。`types/` 里实现自己的工作类型（写入计划、准备好的命令、清单印记、带回调的选项）没有公开签名用到，所以不出包。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器 | 可移植数据 |

模型面的七个工具是本模块的主产品。它们都在 `src/impl/SystemTools.ts`，按文件、执行两类排列，每个工具的定义就是模型看到的全部信息面：一句话摘要、适用与禁用场景、协议、用法、示例、参数说明、权限、能力声明。execute 只放简单的一两步（直接调一次宿主端口）；实现多的交给 impl 的类：读、看、写交给 `SystemFileOperations`，跑命令与演练沙箱（含执行前分类、向用户确认、结果整形）交给 `SystemExecutionOperations`。schema 由 `check:capabilities-schemas` 冻结。

截至 2026-09-15，Desktop 和 Workbench 还在用收口前的入口和零件，要随下一次升级迁到上面这三个面上。

## 骨干链路

七个工具都在 `SystemTools.ts`，每个工具定义上方是它的说明。下表每条链路是该工具执行的样子：read / view / edit 在 `SystemFileOperations`，run / sandbox 在 `SystemExecutionOperations`，refresh-environment 与 list-tasks 简单，直接写在 execute 里；箭头右边是类的方法或宿主端口 `ctx.system`。

| 工具 | 链路 |
| --- | --- |
| `system:read` | files 每项一个文件：相对路径相对宿主给 system:run 的默认目录 → 读私钥、云凭证这类文件先向用户确认 → 有界读进来，按认出的编码（UTF-8、带 BOM、UTF-16、GB18030）严格解码，认不出或有非法字节的按二进制报错 → 按字符取一段，默认读到上限，返回它的 range 和内容的版本号；给 version 就读本次运行里 edit 留下的旧版本 → 一次调用总共最多 20 万字符，按顺序分给各文件，预算用完后的文件不读盘、那一项换成失败条目并在 note 里说明 → 结果的 files 一一对应，某个文件读不了只标记它那一项，全部失败才报错 |
| `system:view` | files 每项一张图：整张作为模型可见的内容块交给模型，和用户上传一样 → 内容块按 files 的顺序排，每块前面一行说明是哪个文件；某个文件看不了只标记它那一项。PDF 与其他文档归别的 mod |
| `system:edit` | files 每项一个文件，一批全成或全不成：路径先解开符号链接，同一文件（按真实路径）只能出现一次 → 每个文件先过审批（系统敏感路径、凭证文件，按真实路径判定），第一次被拒就整批不写、不再问后面的 → 再把每一处在原文上定下来、要写的字节按原编码编好，什么都不写（带 version 的先核对；认不出编码、解码再编码得不到原字节的拒改，写不成原编码的新文本——孤立代理项、GB18030 表示不了的字符——拒写，有多个硬链接的文件不碰；各处只在 read 读到的 range 里找，越界的 range 按过期报，多处匹配给锚点），定不下来就整批失败，回执 details.problems 列出第几个文件第几处出了什么问题、入参可复用 → 写之前再 stat 一次，印记变了或文件不大就重读核版本 → 按顺序原子替换写到真实路径（同目录临时文件写完 fsync 再改名，权限位原样保留；链接不会被换成普通文件，结果里 target 给出）：改动前把原内容留成一个版本，newText 整个写入（已有的二进制文件拒改），edits 从后往前一起套用并交回每处的新样子，restore 回滚到留下的版本。edits 写进去的文本跟着原文的换行风格走（看那一段，那一段没有换行就看整个文件）：CRLF 文件里的裸 LF 换成 CRLF，newText 整个写入原样写；路径是管道、设备或套接字的不碰 |
| `system:run` | ① 执行前分类（只读 / 危险 / 后台）→ ② 显式 background 优先，否则按命令形态推断；`interactive` 为真时一定走后台，命令跑在控制台里等用户输入 → ③ 审批：危险命令高风险手动确认，长驻服务低风险确认 → ④ 宿主执行 → ⑤ 整形：输出窗口、召回续接、后台状态续接；要了控制台却没拿到就在 note 里说清楚宿主不支持 |
| `system:refresh-environment` | Windows 上重读用户与系统环境变量写回宿主进程（宿主设的 `VELAROS_SHELL_PATH` 这类输入变量照留）→ 重新选定并自检 shell → 返回 shell 描述与 revision |
| `system:list-tasks` | 给了 taskId 精确查一条，否则按 limit / onlyRunning 列表 → 附 count |
| `system:sandbox` | create：源目录解开链接后镜像到临时区（写时复制；gitignore 忽略的目录缺省链接过去，ignored=copy 时连里面的东西整个复制过来，忽略目录之外被忽略的文件不复制；主人不可写的目录照原权限位建出来）→ 先探测约束后端，没有就拒绝、不留目录 → 剪断镜像里每个仓库（含嵌套仓库、子模块）的推送，指向源目录外真实仓库的 `.git` 链接文件（git worktree）不进镜像 → 清单原子落盘、登记专属执行器，之后 cwd 落在镜像根内的 `system:run` 一律约束到镜像根（内核重启后按清单重新登记，同一沙箱同时被几处用到只建一个执行器；清单读不出来就拒绝执行）→ diff：扫描镜像印记对比清单，新增、修改、删除三列加有界文本差量，.git 只汇总 → apply：先算完整差量（不截断；paths 里没变化的路径在问用户之前就拒绝）、向用户确认（条数、删除、覆盖与敏感路径都按完整三列）→ 宿主拿确认时的差量指纹核对镜像之后没再变，变了整批不落 → 逐个核对源文件自建沙箱以来没变过、上级路径不是符号链接，冲突整批不落 → 新增与覆盖先暂存进源目录里的临时目录，拷不全什么都不落 → 挪到位（镜像把文件换成同名目录的先删那个文件）、按删除列删掉、清掉删空而镜像里也没有的目录，.git 不落 → discard：核对 id 合形状、这一项不是符号链接、正好是基目录下面一层，再递归删除（碰到只读目录先改成主人可写再删；删成功才注销）|

七个工具按两个类别分组、作为内置 mod 挂进产品、作为能力服务挂进内核，也在 `SystemTools.ts` 的末尾；挂进内核后每次调用先严格解析入参，再向宿主解析上下文。

宿主侧的第二段链路（`system:run` 的 ④ 里面发生的事）：本地内核解析 cwd，交给命令执行器 `SystemCommandRunner.run` → 选 shell（宿主给了 nativeCommand 就走原生 argv，否则按实际 shell 语法）→ 进程约束 → 受管进程启动 → 采集解码 → 超时 / 取消收敛 → 验证摘要 → 后台登记。每一步做什么见 `src/impl/SystemCommandRunner.ts` 类上方的 `SystemCommandRunnerApi` 的说明。

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`。
- `@velaros-ai/kernel`：内核模块定义与模块 SDK `kernelModules`；`@velaros-ai/kernel/contracts` 出能力令牌等可移植数据。
- `@velaros-ai/agent` 的 `protocol` 与 `tool-contract` 子路径：工具运行时规格、mod 清单、审批端口类型、入参描述辅助。
- `@velaros-ai/shell-command`：命令的只读、危险、长驻判定，确认文案，危险命令的审批请求；system:run 与演练沙箱里的命令都经它。
- `@velaros-ai/rehearsal-sandbox`：演练沙箱的数据形状、公开上限，落回前的核对与确认请求（确认的就是要落的）；镜像、差量、落回的引擎仍在本包。
- `@velaros-ai/path-rules`：.gitignore 的解析与判定、遍历时的忽略策略（全局搜索与沙箱镜像共用一份）、默认跳过的目录名表；本包不注入 git 执行口，按各级 .gitignore 判。
- `@velaros-ai/text-files`：文本文件的编码识别、严格解码、按原编码无损写回，原子替换写入（fsync、权限位精确保留、拒绝多硬链接）、有界读与读文件头；它的报错在 `utils/text-file.ts`、`utils/fs.ts` 翻成本包的 VALIDATION、PERMISSION。
- `zod`：wire 面入参校验。

运行时要宿主给的东西全部列在上一节的注入面里，由 `contract/requires.ts` 定义。

不依赖 `@velaros-ai/project`，两边互不引用。命令判定在公共包 `@velaros-ai/shell-command`，沙箱契约与落回规则在 `@velaros-ai/rehearsal-sandbox`，文本文件的编解码与原子读写在 `@velaros-ai/text-files`，两个空间用的是同一份。

## 状态归谁

- **后台任务表**：每个本地内核持有一个命令执行器，任务表归它私有，在内存里，随内核 `dispose()` 结束；只保留结尾的输出窗口（后台任务最近 4000 字符），不落日志文件；宿主自己留了会话终端日志（`logPath`）时结果里才有召回续接。已结束的任务只留最近 200 条。
- **交互式任务的控制台缓冲**：和任务表一起归命令执行器，在内存里，每个控制台留最近 10 万字符，更早的输出被挤掉时读取方会拿到 `droppedChars`；随 `dispose()` 清空。
- **演练沙箱登记表**：本地内核持有一份（`SystemSandboxes`），每个沙箱一条记录和一个约束到镜像根的专属执行器；镜像与清单在临时区 `velaros-sandbox/<id>/` 下，内核重启后按清单重新登记；`dispose()` 只停进程，不删镜像，用户可能还要看差量。
- **受管子进程登记表**：整个进程一份（`systemProcessManager`），已结束的进程最多保留 512 条回执，供状态查询和 pid 身份核对。
- **文件版本历史**：文件操作持有一份，只在内存里，每个文件留最近 10 份改动前的内容、单份不超过 2 MB、总量不超过 64 MB；随进程消失，持久化的本地历史是宿主的事。
- **shell 选择**：不缓存，每次运行前重新自检。`system:refresh-environment` 在 Windows 上重读用户与系统环境变量写回本进程并给出新的 `revision`，其他平台只重新选 shell。
- **审批记忆**：不归本模块。本模块只发起确认，记不记、记多久由宿主的 `ApprovalPort` 决定。

## 生命周期

- 工具集合与 mod 定义是纯值，随包加载即存在，没有启动顺序。
- 本地内核由宿主创建；`dispose()` 停掉它管理的后台执行。
- 内核模块 `createSystemKernelModule` 在 `activate` 时注册能力服务；每次调用先严格解析入参，再向宿主解析一次上下文。
- 后台任务由 `system:run` 的后台模式创建，`system:list-tasks` 查询，模型要停它就用 `system:run` 执行任务条目里的 `terminateCommand`；宿主自己的界面经本地内核的 `terminateBackgroundTask` 终止。进程退出后状态变 `exited`，拿不准时报 `unknown` 而不是猜。
- 交互式任务（`system:run` 的 `interactive`）就是一条带控制台的后台任务：启动时 stdin 留一根打开的管道，用户经本地内核的 `writeConsoleInput`、`readConsoleOutput`、`interruptConsole` 与它打交道；进程退出后控制台还在任务上，只是 `acceptsInput` 变成 false。输入管道断开（进程关了输入，或写到一半退出）的错误在启动时就接住，不会变成宿主进程的未捕获异常；写入最多等 `SystemTuning.command.consoleWriteTimeoutMs`，进程没读走就如实报「已排队」，上一笔还压在管道里时拒绝再写。
- 前台命令：超时或取消后一定在期限内收敛，清理没做完就如实标 `cleanupIncomplete`。

## 失败语义

- **默认失败关闭。** 找不到可用 shell 抛 `SYSTEM_SHELL_UNAVAILABLE`；受约束模式没有后端抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`，不退回裸进程。
- **macOS 的约束只管得住文件写，证据如实报 `enforcement: partial`。** Seatbelt 拦住本进程与子进程写到写根之外，也堵上了经 cfprefsd 代写偏好设置、发 Apple 事件让别的应用代办这两条路；其余由系统服务代办的事（`open` 按路径启动的应用、钥匙串经 securityd 写入）拦不全。需要绝对边界的调用方不能把 partial 当 full。
- **命令本身失败不是模块错误。** 退出码、超时、取消都如实进 `SystemCommandResult`，`success` 为 false，`verification` 摘要输出末尾。
- **危险命令没有审批通道就拒绝。** 审批事实与约束事实分开记录，谁也不能冒充谁。
- **输出过长不是错误。** 截尾、标记 `truncated`、给出可执行的召回续接。
- 完整错误码语义见 `src/contract/constants.ts` 里的 `SystemErrorCodes`；外面按错误码判断，不按错误类。
- 演练沙箱：没有约束后端建不出（`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`）；落回时源文件自建沙箱以来变过、或上级路径是符号链接（会写到源目录外）整批不落（`SYSTEM_SANDBOX_CONFLICT`，not-applied，cause.details.conflicts 列出每处）；确认之后镜像又变过整批不落（`SYSTEM_SANDBOX_CHANGED`，not-applied）；暂存拷不全什么都不落（not-applied），挪到位的途中失败不回滚，已落回的路径在 context.applied 里点名；镜像根里的命令遇到读不出来的清单拒绝执行（`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`）；丢弃时 id 不合形状、这一项是符号链接、路径不在基目录下面一层就拒绝。

## 不变量

共 25 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排，INV-1 已移出为仓库级跨包约束，INV-2、INV-3、INV-18 随命令判定移到 `@velaros-ai/shell-command`。
按检验方式：测试 23 条、类型 1 条、门禁 1 条。未验证 0 条。

## 非目标

- 不做项目感知：不发现项目、不读项目配置、不做开发环境诊断，工具描述里也不提项目空间。这些工具曾经有过，已从模型面删除。空间之间的切换和协作是宿主的事。
- 不做授权决策与权限记忆：只发起审批，决定权在宿主。
- 不给 `system:run` 能做的事单独开工具：列目录、搜文本、看进程和端口、终止进程、打开文件和应用都用 `system:run` 跑系统命令。原来的 `system:list`、`system:search`、`system:processes`、`system:terminate-task`、`system:open` 已删除。留下的工具各有 run 做不到的理由：读和写把内容和精确匹配绕开 shell 引号并过敏感路径审批，看图片要把内容当图交给模型，后台任务表只在本包，刷新环境改的是宿主进程。整个文件的重写并在 `system:edit` 里，不单开 write。
- 不提供 Electron 专属能力：通知、安装建议界面由产品壳用 `extends` 扩展服务接口。
- 不内置 Windows 的进程约束后端：需要受约束执行的 Windows 宿主自己注入 provider，否则明确失败。

## 结构

```text
src/
  contract/     对外合同：provides.ts 登记产品面（类实现的 API 定义在类上方，这里 re-export；没有类的公开接口声明在这里），requires.ts 注入面，constants.ts 约定的常量表
  types/        只放类型，按域分文件：system.ts 是可移植数据文件，files.ts、commands.ts、sandbox.ts、processes.ts、tool.ts 各管一域；哪些出包由合同的签名决定；平台数据来自 `@velaros-ai/platform`
  impl/         扁平：SystemTools.ts 放七个工具，其余一个类一个文件，文件名就是类名
  utils/        纯工具函数，按类别分文件；每个函数上方一句中文说明；tuning.ts 是全包的可调参数表
  index.ts      `.` 入口，只转发
  contracts.ts  `./contracts` 入口，只转发
```

**看代码的顺序**：`SystemTools.ts` → `contract/` 的三个文件 → 需要时看 utils 里函数上方的一句说明。类的实现、数据字段、工具函数的内部一般不用看。

**合同、类型、常量分开。** `contract/` 是对外合同：provides 登记产品面、requires 定义注入面、constants 放约定的常量表。`types/` 只放类型，一个值都没有，按域分文件；出不出包不看文件，看合同的签名有没有用到。

**常量分四处。** 对外承诺的（工具名、错误码、环境变量、写进工具说明与 schema 的上限）在 `contract/constants.ts`，每个数字一句说明，工具说明里的数字用模板字符串引它，改一处模型看到的跟着变。包内可调的（超时、缓冲、保留条数、缺省条数、阈值）都在 `utils/tuning.ts` 的 `SystemTuning`，按用途分组、每项一句说明，实现里不再散写数字缺省值。某个类里固定用的文案与名单写成那个类的 `private static readonly`。规则本身的数据（危险命令名单、敏感路径名单）跟着规则留在各自的 utils 文件里，搜索默认跳过的目录名在 `@velaros-ai/path-rules` 的常量表；算法与格式里的数字（哈希取几位）就地写。跨包相同的逻辑抽到按含义命名的公共包（命令判定在 `@velaros-ai/shell-command`，文本编解码与原子读写在 `@velaros-ai/text-files`，gitignore 与 glob 判定在 `@velaros-ai/path-rules`）；沙箱契约在 `@velaros-ai/rehearsal-sandbox`；两个工具的入参 schema 形状相同、文案按空间不同，各持一份，由仓库层的一致性测试守着。以上由门禁核对。

**文件怎么分。** 不拆碎文件：一个文件一个职责，内容多没关系。七个工具的定义连同分组与挂载是一个职责，都在 `SystemTools.ts`；每个类一个文件，文件名就是类名；纯函数按类别进 utils。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记，注入面的在 `contract/requires.ts`。类的公开方法只能是接口里的方法；私有方法只放用得到实例状态、没法提出去的公共逻辑，用不到的一律进 utils。整个进程只需要一份的类，文件末尾给出那一份，对外的那几份按公开接口标注类型。继承 `Error` 的错误类没有方法，不写接口，也不出包，外面按错误码判断。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `SystemTools.ts` | 没有类 | 七个工具的定义、分组、内置 mod、内核挂载 |
| `LocalSystemKernel.ts` | `LocalSystemKernelApi`（同文件，provides 登记），扩展宿主端口 `SystemToolSystemApi`（requires） | 宿主端口的本机实现，只做转接 |
| `SystemSandboxes.ts` | `SystemSandboxesApi`（同文件） | 演练沙箱登记表：镜像、差量、落回、丢弃，每个沙箱一个约束到镜像根的执行器 |
| `SystemCommandRunner.ts` | `SystemCommandRunnerApi`（同文件） | 跑命令：前台采集，后台登记成任务、可查可停；交互式任务另带控制台，可写输入、读增量输出、发中断 |
| `SystemShellResolver.ts` | `SystemShellResolverApi`（同文件） | 找 shell、自检、判断命令在不在、刷新 Windows 环境变量 |
| `SystemProcessManager.ts` | `SystemProcessManagerApi`（同文件） | 受管子进程登记表 |
| `SystemManagedProcess.ts` | `ManagedSystemProcess`（同文件） | 单个受管子进程的超时、取消、有界终止与收尾 |
| `SystemOutputDecoder.ts` | `SystemOutputDecoderApi`（同文件） | 子进程输出的 UTF-8 解码 |
| `SystemExecutionOperations.ts` | `SystemExecutionOperationsApi`（同文件） | system:run 与 system:sandbox 的执行：执行前分类、向用户确认、交给宿主、结果整形 |
| `SystemFileOperations.ts` | `SystemFileOperationsApi`（同文件） | 读文本、看图片、写三个文件操作，位置按字符算 |
| `SystemFileHistory.ts` | `SystemFileHistoryApi`（同文件） | 改动前留下的文件版本，供召回与回滚；只在内存里 |
| `SystemGlobalSearch.ts` | `SystemGlobalSearchApi`（同文件） | 全局搜索：按路径或按内容遍历目录树，给宿主界面用 |
| `SystemShellUnavailableError.ts` | 错误类，不写接口 | 找不到能用的 shell |

实现分四层，上层可以调下层，下层不调上层：工具（`SystemTools.ts`）→ 宿主（`LocalSystemKernel.ts`）→ 能力（命令、沙箱、进程、shell、执行操作、文件操作、文件版本、搜索）→ shell 错误类（`SystemShellUnavailableError.ts`）。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，谁都可以用，它只引 utils、types 与合同。

`./contracts` 入口会被渲染进程加载，它的整条引用链不碰 Node 模块；跨平台兼容层与共享资源目录在 `@velaros-ai/platform`。

`SystemTools.ts` 改了要在差量报告里点名，人复核；`contract/` 的三个文件改了等于改对外契约，也要点名。其余代码由 agent 维护。以上分工、分层、接口与数据的边界、导出规则、环境变量登记都由门禁机械核对。

规模截至 2026-09-15：`src/contract/` 3 个文件约 370 行；`src/types/` 6 个文件约 1200 行，其中 `system.ts` 约 640 行；`src/impl/` 15 个文件约 3140 行，其中 `SystemTools.ts` 约 480 行、`SystemFileOperations.ts` 约 430 行；`src/utils/` 15 个文件约 3760 行。
