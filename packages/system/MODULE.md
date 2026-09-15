# @velaros-ai/system 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 六个工具都在 `src/impl/SystemTools.ts` 一个文件里，是最先看的地方；其次是 `src/contract/` 各文件顶部「类的接口」，每个类做什么、每个方法做什么都写在那里。代码怎么分层见最后一节「结构」。
> 门禁：`bun run check:module-ownership`。

## 这是什么

系统空间的能力包：让 agent 在用户的整台机器上读写文件、跑命令、追踪后台任务，并且每一步都过宿主的审批边界。找文件、搜文本、看进程和端口、终止进程都用 `system:run` 跑系统命令；本地内核另外给宿主自己的界面提供结构化的搜索、进程和端口接口。

它不知道"项目"是什么，也不知道界面长什么样；项目空间是另一个独立的包，两边互不引用、互不提及。该用哪个空间是宿主的责任和提示词约束：宿主发现用户在系统空间里做项目，就提示切到项目空间；项目空间要用系统能力，就派一个系统空间的子 agent 去做。界面与 Electron 专属能力由产品壳负责。

## 提供什么

本包对外只有三个面，都由接口控制：导出的类型只能来自 `src/interface/provides.ts`、`src/interface/requires.ts` 和 `src/contract/`，导出的值必须标注成公开接口；类、工具函数和包内部的接口一律不出包。门禁机械核对，没写进这一节的值导不出去。

**产品面**，写在 `interface/provides.ts`，是交给外面的整件能力：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `systemTools` | `SystemToolCollection`，元素是 `VelaTool` | 六个模型面工具 |
| `createSystemBundledModDefinition` | `SystemBundledModDefinition` | 系统空间作为官方内置 mod 的定义 |
| `createSystemKernelModule` | 上游的 `KernelModuleDefinition` | 挂进内核的模块 |
| `SystemCapability` | 能力令牌，服务是 `SystemCapabilityService` | 在内核里按名调用系统工具 |
| `createLocalSystemKernel` | `LocalSystemKernelApi` | 宿主端口的本机实现 |
| `systemCommandPolicy` | `SystemCommandPolicyApi` | 执行前给命令分类，和 `system:run` 用同一份判定 |
| `currentSystemPlatform`、`createSystemPlatform` | `SystemPlatformCompatibilityApi` | 跨平台兼容层 |
| `velarosSharedResources` | `VelarOSSharedResourcesApi` | 产品家族共享资源目录 |

**注入面**，写在 `interface/requires.ts`，是宿主要塞进来的东西。本包只从这些口子接收外部能力，别处不留钩子：

| 注入点 | 必须 | 谁给、什么时候 |
| --- | --- | --- |
| `SystemToolContext`，里面是宿主端口 `SystemToolSystemApi` 与上游审批端口 `ApprovalPort` | 必须 | 宿主每次调工具时给。端口只有六个方法，每个都有工具在调，门禁核对 |
| `SystemToolContextResolver`，放在 `CreateSystemKernelModuleOptions` 里 | 挂进内核且要按名调用时必须 | 创建内核模块时给 |
| `LocalSystemKernelOptions` | 用本地内核时必须 | 创建本地内核时给 |
| `SystemProcessConfinementProvider` | 可选 | 放在本地内核配置里，没有内置约束后端的平台靠它 |
| 环境变量，全部登记在 `SystemEnvironmentVariables` | 可选 | 四个输入变量由宿主设，三个标记变量由本包写给子进程 |

**数据面**是 `contract/`。可移植数据文件 `contract/system.ts` 整个就是 `./contracts` 入口：工具身份表 `SystemToolNames`、`SystemToolCategoryByName`，身份常量 `SystemModId`、`SystemSpaceId`，错误码 `SystemErrorCodes`，环境变量表 `SystemEnvironmentVariables`，以及经过宿主端口流动的全部数据结构。其余数据只有被公开签名用到时才出包。

四个入口对应 `package.json` 的 `exports`，源文件在 `src/exports/`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 三个面的全部 |
| `./contracts` | 任何进程，含浏览器 | 可移植数据 |
| `./platform-compatibility` | Node 宿主与渲染进程 | 跨平台兼容层 |
| `./shared-resources` | Node 宿主 | 共享资源目录 |

模型面的六个工具是本模块的主产品。它们都在 `src/impl/SystemTools.ts`，按文件、执行两类排列，每个工具的定义就是模型看到的全部信息面：一句话摘要、适用与禁用场景、协议、用法、示例、参数说明、权限、能力声明、审批语义，以及 execute 里的执行链路。schema 由 `check:capabilities-schemas` 冻结。

截至 2026-09-15，Desktop 和 Workbench 还在用收口前的入口和零件，要随下一次升级迁到上面这三个面上。

## 骨干链路

六个工具都在 `SystemTools.ts`，每个工具定义上方是它的说明。下表每条链路是该工具 execute 的样子，箭头右边是类的方法或宿主端口 `ctx.system`。

| 工具 | 链路 |
| --- | --- |
| `system:read` | files 每项一个文件：相对路径相对宿主给 system:run 的默认目录 → 读私钥、云凭证这类文件先向用户确认 → 按字符取一段，默认读到上限，返回它的 range 和内容的版本号；给 version 就读本次运行里 edit 留下的旧版本 → 一次调用总共最多 20 万字符，按顺序分给各文件，分完的文件只带位置并在 note 里说明 → 结果的 files 一一对应，某个文件读不了只标记它那一项，全部失败才报错 |
| `system:view` | files 每项一张图：整张作为模型可见的内容块交给模型，和用户上传一样 → 内容块按 files 的顺序排，每块前面一行说明是哪个文件；某个文件看不了只标记它那一项。PDF 与其他文档归别的 mod |
| `system:edit` | files 每项一个文件，一批全成或全不成：先把每个文件的每一处在原文上定下来、什么都不写（带 version 的先核对文件没被改过；各处只在 read 读到的 range 里找，多处匹配给锚点），定不下来就整批失败，回执 details.problems 列出第几个文件第几处出了什么问题、入参可复用（reuse + changes 只改那一处再发） → 敏感路径逐个向用户确认，有一个被拒整批不写 → 按顺序写：改动前把原内容留成一个版本，newText 整个写入，edits 从后往前一起套用并把盖住所有改动那段的新内容和新版本号交回，restore 回滚到留下的版本 |
| `system:run` | ① 执行前分类（只读 / 危险 / 后台）→ ② 显式 background 优先，否则按命令形态推断 → ③ 审批：危险命令高风险手动确认，长驻服务低风险确认 → ④ 宿主执行 → ⑤ 整形：输出窗口、召回续接、后台状态续接 |
| `system:refresh-environment` | 宿主允许刷新才继续 → 宿主重载 PATH 与环境变量 |
| `system:list-tasks` | 给了 taskId 精确查一条，否则按 limit / onlyRunning 列表 → 附 count |

六个工具按两个类别分组、作为内置 mod 挂进产品、作为能力服务挂进内核，也在 `SystemTools.ts` 的末尾；挂进内核后每次调用先严格解析入参，再向宿主解析上下文。

宿主侧的第二段链路（`system:run` 的 ④ 里面发生的事）：本地内核解析 cwd，交给命令执行器 `SystemCommandRunner.run` → 选 shell（宿主给了 nativeCommand 就走原生 argv，否则按实际 shell 语法）→ 进程约束 → 受管进程启动 → 采集解码 → 超时 / 取消收敛 → 验证摘要 → 后台登记。每一步做什么见 `src/contract/commands.ts` 顶部 `SystemCommandRunnerApi` 的说明。

## 依赖什么

- `@velaros-ai/core`：类型守卫、缺席值、日志、`AppError`。
- `@velaros-ai/kernel` 的 `contracts/abi`：能力令牌、内核模块定义。
- `@velaros-ai/agent` 的 `protocol` 与 `tool-contract` 子路径：工具运行时规格、mod 清单、审批端口类型、入参描述辅助。
- `zod`：wire 面入参校验。

运行时要宿主给的东西全部列在上一节的注入面里，由 `interface/requires.ts` 定义。

不依赖 `@velaros-ai/project`，两边互不引用。两个包各有一份命令危险判定；它们是否一致由仓库级测试 `tests/capabilities/command-danger-parity.test.ts` 守着，它经本包的 `systemCommandPolicy` 取判定，不属于本模块。

## 状态归谁

- **后台任务表**：每个本地内核持有一个命令执行器，任务表归它私有，在内存里，随内核 `dispose()` 结束；完整输出写进会话终端日志文件（`logPath`），不写工作区。
- **受管子进程登记表**：整个进程一份（`systemProcessManager`），已结束的进程最多保留 512 条回执，供状态查询和 pid 身份核对。
- **文件版本历史**：文件操作持有一份，只在内存里，每个文件留最近 10 份改动前的内容、单份不超过 2 MB、总量不超过 64 MB；随进程消失，持久化的本地历史是宿主的事。
- **shell 选择缓存**：进程级；`refreshWindowsEnvironment` 会清空并给出新的 `revision`。
- **审批记忆**：不归本模块。本模块只发起确认，记不记、记多久由宿主的 `ApprovalPort` 决定。
- **共享资源根目录**：只算路径，不建目录、不写盘。

## 生命周期

- 工具集合与 mod 定义是纯值，随包加载即存在，没有启动顺序。
- 本地内核由宿主创建；`dispose()` 停掉它管理的后台执行。
- 内核模块 `createSystemKernelModule` 在 `activate` 时注册能力服务；每次调用先严格解析入参，再向宿主解析一次上下文。
- 后台任务由 `system:run` 的后台模式创建，`system:list-tasks` 查询，模型要停它就用 `system:run` 执行任务条目里的 `terminateCommand`；宿主自己的界面经本地内核的 `terminateBackgroundTask` 终止。进程退出后状态变 `exited`，拿不准时报 `unknown` 而不是猜。
- 前台命令：超时或取消后一定在期限内收敛，清理没做完就如实标 `cleanupIncomplete`。

## 失败语义

- **默认失败关闭。** 找不到可用 shell 抛 `SYSTEM_SHELL_UNAVAILABLE`；受约束模式没有后端抛 `SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`，不退回裸进程。
- **命令本身失败不是模块错误。** 退出码、超时、取消都如实进 `SystemCommandResult`，`success` 为 false，`verification` 摘要输出末尾。
- **危险命令没有审批通道就拒绝。** 审批事实与约束事实分开记录，谁也不能冒充谁。
- **输出过长不是错误。** 截尾、标记 `truncated`、给出可执行的召回续接。
- 完整错误码语义见 `src/contract/system.ts` 末尾的 `SystemErrorCodes`；外面按错误码判断，不按错误类。

## 不变量

共 17 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排，INV-1 已移出为仓库级跨包约束。
按检验方式：测试 14 条、类型 1 条、门禁 1 条、文字 1 条。未验证 1 条（INV-18，只有文字，没有机器检验）。

## 非目标

- 不做项目感知：不发现项目、不读项目配置、不做开发环境诊断，工具描述里也不提项目空间。这些工具曾经有过，已从模型面删除。空间之间的切换和协作是宿主的事。
- 不做授权决策与权限记忆：只发起审批，决定权在宿主。
- 不给 `system:run` 能做的事单独开工具：列目录、搜文本、看进程和端口、终止进程、打开文件和应用都用 `system:run` 跑系统命令。原来的 `system:list`、`system:search`、`system:processes`、`system:terminate-task`、`system:open` 已删除。留下的工具各有 run 做不到的理由：读和写把内容和精确匹配绕开 shell 引号并过敏感路径审批，看图片和 PDF 要把内容当图交给模型，后台任务表只在本包，刷新环境改的是宿主进程。整个文件的重写并在 `system:edit` 里，不单开 write。
- 不提供 Electron 专属能力：通知、安装建议界面由产品壳用 `extends` 扩展服务接口。
- 不内置 Windows 的进程约束后端：需要受约束执行的 Windows 宿主自己注入 provider，否则明确失败。

## 结构

```text
src/
  interface/    接口：provides 是产品面，requires 是注入面，internal 是包内部类的接口；每个方法都有中文说明
  contract/     数据：字段、类型、常量表，不含任何函数和方法
  impl/         扁平：SystemTools.ts 放六个工具，其余一个类一个文件，文件名就是类名
  utils/        纯工具函数，按类别分文件；每个函数上方一句中文说明
  exports/      四个对外入口，只转发，package.json 的 exports 指向这里
```

**看代码的顺序**：`SystemTools.ts` → `interface/` 的三个文件 → 需要时看 utils 里函数上方的一句说明。类的实现、数据字段、工具函数的内部一般不用看。

**接口与数据分开。** `interface/` 放行为：谁能做什么，每个方法做什么、返回什么、什么时候失败。`contract/` 放数据：流过边界的东西长什么样，里面不许出现函数类型和方法。带回调或注入对象的选项算行为，放 `interface/`。

**文件怎么分。** 不拆碎文件：一个文件一个职责，内容多没关系。六个工具的定义连同分组与挂载是一个职责，都在 `SystemTools.ts`；每个类一个文件，文件名就是类名；纯函数按类别进 utils。

**类与接口。** 每个类实现 `interface/` 里的一个接口。类的公开方法只能是接口里的方法；私有方法只放用得到实例状态、没法提出去的公共逻辑，用不到的一律进 utils。整个进程只需要一份的类，文件末尾给出那一份，对外的那几份按公开接口标注类型。继承 `Error` 的错误类没有方法，不写接口，也不出包，外面按错误码判断。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `SystemTools.ts` | 没有类 | 六个工具的定义、分组、内置 mod、内核挂载 |
| `LocalSystemKernel.ts` | `LocalSystemKernelApi`（provides），扩展宿主端口 `SystemToolSystemApi`（requires） | 宿主端口的本机实现，只做转接 |
| `SystemCommandPolicy.ts` | `SystemCommandPolicyApi`（provides） | 执行前给命令分类的唯一出口 |
| `SystemPlatformCompatibility.ts` | `SystemPlatformCompatibilityApi`（provides） | 跨平台兼容层 |
| `VelarOSSharedResources.ts` | `VelarOSSharedResourcesApi`（provides） | 产品家族共享资源目录 |
| `SystemCommandRunner.ts` | `SystemCommandRunnerApi`（internal） | 跑命令：前台采集，后台登记成任务、可查可停 |
| `SystemShellResolver.ts` | `SystemShellResolverApi`（internal） | 找 shell、自检、判断命令在不在、刷新 Windows 环境变量 |
| `SystemProcessManager.ts` | `SystemProcessManagerApi`（internal） | 受管子进程登记表 |
| `SystemManagedProcess.ts` | `ManagedSystemProcess`（internal） | 单个受管子进程的超时、取消、有界终止与收尾 |
| `SystemOutputDecoder.ts` | `SystemOutputDecoderApi`（internal） | 子进程输出的 UTF-8 解码 |
| `SystemFileOperations.ts` | `SystemFileOperationsApi`（internal） | 读文本、看图片、写三个文件操作，位置按字符算 |
| `SystemFileHistory.ts` | `SystemFileHistoryApi`（internal） | 改动前留下的文件版本，供召回与回滚；只在内存里 |
| `SystemGlobalSearch.ts` | `SystemGlobalSearchApi`（internal） | 全局搜索：按路径或按内容遍历目录树，给宿主界面用 |
| `GitIgnoreSystemSearchPolicy.ts` | `SystemSearchIgnorePolicy`（internal） | 遍历时按各级 .gitignore 判断跳过哪些条目 |
| `SystemShellUnavailableError.ts` | 错误类，不写接口 | 找不到能用的 shell |

实现分四层，上层可以调下层，下层不调上层：工具（`SystemTools.ts`）→ 宿主（`LocalSystemKernel.ts`）→ 能力（命令、策略、进程、shell、文件操作、文件版本、搜索）→ 平台（兼容层、它的错误、共享资源目录）。每个文件属于哪一层登记在 `scripts/ownership/governed-modules.mjs`。utils 在最底下，谁都可以用，它只引 utils、契约与接口。

`./contracts` 与 `./platform-compatibility` 两个入口会被渲染进程加载，它们的整条引用链不碰 Node 模块。

`SystemTools.ts` 改了要在差量报告里点名，人复核；`interface/provides.ts` 与 `interface/requires.ts` 改了等于改对外契约，也要点名。其余代码由 agent 维护。以上分工、分层、接口与数据的边界、导出规则、环境变量登记都由门禁机械核对。

规模截至 2026-09-15：`src/interface/` 3 个文件约 620 行；`src/contract/` 4 个文件约 930 行，其中 `system.ts` 约 630 行；`src/impl/` 14 个文件约 2460 行，其中 `SystemTools.ts` 约 500 行、13 个类各一个文件；`src/utils/` 13 个文件约 2610 行；`src/exports/` 4 个文件约 80 行。
