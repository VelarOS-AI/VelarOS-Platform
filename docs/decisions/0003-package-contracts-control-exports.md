# 0003: 包的对外面由接口控制，接口与数据分开

- Status: accepted
- Date: 2026-09-15
- Owners: 模块所有权治理，首个落地包 `@velaros-ai/system`

## Context

`@velaros-ai/system` 收口前有九个入口、根入口 125 个符号。其中 21 个是 utils 里的裸函数，3 个是类，还有一批只为让产品壳拼宿主而递出去的零件：受管进程、shell 选择、输出解码、进程约束、ps 与 lsof 解析、搜索可见性。产品壳实际用到 73 个符号，其中 25 个是这些零件；本包自己的本地内核反而没人用。

结果是边界不清：上面缺什么就往下导什么，零件和内部接口一起出包，任何内部重构都会碰到外部代码。宿主往里塞能力的口子也散在各处，有的是选项里的回调，有的是环境变量，没有一张清单。

## Decision

每个已治理的包对外只有三个面，由 `src/interface/` 里的接口控制：

- 产品面 `provides.ts`：交给外面的整件能力，每件一个接口。
- 注入面 `requires.ts`：宿主必须或可以塞进来的东西，每个注入点一个接口，写清谁给、什么时候给、必不必须。环境变量也算注入，全部登记在可移植数据文件的表里。
- 数据：`src/contract/` 只放数据，不许出现函数类型和方法；公开签名里用到的数据才出包，可移植数据文件整个就是 `./contracts`。

导出规则：入口只转发；导出的类型只能来自 provides、requires 与 contract；导出的值只能是契约常量表，或按公开接口标注类型的实例与工厂。类、utils 函数、包内部接口（`internal.ts`）不出包，错误类不出包、外面按错误码判断。公开接口不许引用内部接口。以上由 `check:module-ownership` 机械核对。

`@velaros-ai/system` 按此收成四个入口：`.`、`./contracts`、`./platform-compatibility`、`./shared-resources`；根入口的运行时值从 40 个收到 15 个，每个都标注公开接口。

## Alternatives

- 保留九个入口，只在文档里标注哪些是内部：没有机械约束，下一次「上面要什么就导什么」照样发生。
- 把受管进程、shell 选择等零件也列进产品面：产品壳可以少改，但零件一出包，包内部就不能再重构；宁可在本地内核上按真实需要开两三个明确的钩子。
- 用卡片清单单独控制导出：清单与代码会漂移；让接口文件本身成为清单，门禁核对两者相等。

## Security and privacy

执行前的危险判定只有一个出口 `systemCommandPolicy`，工具与宿主审批界面用同一份判定。进程约束后端只能经注入面的 `SystemProcessConfinementProvider` 进来。环境变量必须登记，代码里冒出未登记的 `VELAROS_*` 名字就拦，宿主能影响本包行为的配置都在一张表里。

## Compatibility and migration

这是破坏性改动。Desktop 与 Workbench 升级到下一版 Platform 时按下表迁移；工具面的删减见 0004：

| 收口前 | 收口后 |
| --- | --- |
| `./execution`、`./files`、`./processes`、`./desktop`、`./composition` 五个入口 | 删除；用根入口或下面的替代 |
| `manageSystemProcess`、`getManagedSystemProcess`、`captureSystemProcessIdentity`、`resolveSystemProcessStatus`、`stopOwnedSystemProcesses`、`createSystemOutputDecoder`、`buildSystemOwnedProcessSpec`、`terminateSystemProcessTree`、`waitForSystemProcessSpawn`、`buildSystemNativeCommandSpec`、`describeSystemNativeCommand`、`buildSystemProcessConfinementSpawnSpec`、`resolveSystemShell`、`resolveSystemShellReady`、`resolveSystemCommand`、`refreshWindowsEnvironment`、`parseProcessRows` 等解析器、`createSystemSearchIgnorePolicy`、`shouldSkipSystemSearch*` | 不出包。宿主改用 `createLocalSystemKernel(options)` 得到宿主端口的本机实现：跑命令、后台任务、进程端口指标、全局搜索、环境检查与刷新；需要的钩子按真实需要加到 `LocalSystemKernelOptions` |
| `analyzeCommandExecution`、`isSystemShellCommandReadOnly` | `systemCommandPolicy.analyze`、`systemCommandPolicy.isReadOnly` |
| `new SystemPlatformCompatibility(options)` | `createSystemPlatform(options)`；`currentSystemPlatform` 不变 |
| `getSystemShellKind(path)` | `currentSystemPlatform.getShellKind(path)` |
| `SystemShellUnavailableError` | 按 `SystemErrorCodes.shellUnavailable` 判断错误码 |
| `resolveVelarOSShared*Root` | `velarosSharedResources.dataRoot / resourcesRoot / accountRoot` |
| `systemFileTools` 等分类子集、`SystemToolCategories` | 用 `systemTools` 与 `SystemToolCategoryByName` |
| `ToolContext` | `SystemToolContext` |
| `SystemOpenPathResult`、`SystemRevealPathResult`、`SystemOpenApplicationOptions`、`SystemOpenApplicationResult`、`SystemDefaultEditorId`、`SystemToolPromptHint`、`SystemToolInstallRequest`、`SystemToolInstallResult` | 本包没有任何接口用到，已从契约删除；这是产品壳自己的概念，由产品壳定义 |
| `ParsedProcessRow`、`RawPortEntry`、`ResolvedSystemShell`、`SystemSearchIgnorePolicy` 等内部类型 | 不出包 |
| `LocalSystemKernelApi.listCommandRuns`、`SystemCommandRunRecord`、`SystemCommandRunQueryOptions`、`SystemCommandRunStatus` | 删除。命令日志是产品壳的概念，本地内核从不记录；Desktop 的 journal 自己定义记录类型 |
| `SystemToolSystemApi.canStartBackgroundCommands`、`canRefreshShellEnvironment` | 删除。宿主不能或不允许跑后台命令，就在 `runCommand` 里以 PERMISSION 拒绝（子代理的边界在 agent 包里改包 `runCommand`）；刷新环境没有宿主需要禁止 |
| `SystemToolSystemApi.resolveCommandCwd?` | 改成必需的 `resolvePath(path?)`：`~` 与相对路径的解析全交给宿主，文件工具和 `system:run` 的 cwd 用同一个口径，审批看到的目标和实际操作的目标一致 |

已知差距：本包的受管进程在直接子进程退出后总是清理整个进程组，Desktop 自己的执行器会放过用 nohup、setsid、disown 脱离的进程。Desktop 迁到本地内核前，要把这条策略收进本包。

## Validation

`check:module-ownership` 核对上面的全部规则，55 种违规逐一实测被拦。包测试、验收测试、跨包命令危险判定一致性测试、工具 schema 冻结、打包检查全部通过；四个入口在 Node 严格 ESM 下能加载，删掉的五个入口报 `ERR_PACKAGE_PATH_NOT_EXPORTED`；两个渲染进程入口按浏览器打包不含 Node 模块。

## Consequences

包内部可以随意重构，只要 provides、requires 与公开签名里的数据不变。改这两个接口文件等于改对外契约，差量报告要点名。下一个进入治理的包先写这两个文件，再动实现。
