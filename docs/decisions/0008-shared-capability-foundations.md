# 0008: 能力公共件单独成域，第一个包是 `@velaros-ai/shell-command`

- Status: accepted
- Date: 2026-09-16
- Owners: 模块所有权治理

## Context

system 与 project 两个空间互不引用，同一段逻辑各写一份：危险命令与只读判定（两份 800 多行、规则逐字相同，差 5 处）、演练沙箱的数据与落回规则、文本文件的编码识别与原子写入、gitignore 与 glob。每修一次判定要改三处（两份实现加一份仓库级一致性测试），3489fa6 就是这样一次提交改了三个文件。
Desktop、Workbench、Termel 为了 `analyzeCommandExecution`、`isShellCommandReadOnly` 这类纯函数去依赖整个 `@velaros-ai/project`。
`docs/architecture/module-ownership.md` 已经定了规矩：跨包的相同逻辑抽到按含义命名的公共包，域无关原语去 core，跨平台兼容去 platform，其余新建、一包一义。抽取方案（草稿区 shared-logic-plan.md）列了四个新包：shell-command、rehearsal-sandbox、text-files、path-rules。

## Decision

新建一个域 `foundations`（能力公共件），放两个以上能力空间共用、又不属于 core（域无关原语）和 platform（跨平台兼容）的包。它们按模块所有权制治理，不登记进 `scripts/capabilities/capability-owners.mjs`（那张表管能力空间，公共件被多个空间依赖，登记进去会被判跨 owner）。

第一个包 `@velaros-ai/shell-command`（0.1.0）：agent 代跑一条 shell 命令的公共语义。

- `shellCommandPolicy`（`ShellCommandPolicyApi`）：执行前分类（只读、危险及理由、长驻、端口）、并发判定（`optIn` 参数化两个空间不同的缺省）、确认文案。判定取 system 那份（精确、没有误报、确认文案带仓库提醒）。
- `shellCommandApproval`（`ShellCommandApprovalApi`）：危险命令的审批请求，高风险、手动、不可记忆，操作身份（种类 `ShellCommandOperationKind`，参数是去首尾空白的命令、工作目录、前后台）跨工具一致；被拒怎么办由空间定。
- 依赖 core，peer 依赖 agent（只用 `tool-contract` 与 `protocol` 的类型）；根入口与 `./contracts` 不碰 Node 模块。
- system 改为依赖它：`SystemCommandPolicy`、`utils/command-policy.ts`、`SystemCommandExecutionPlan` 删除，根入口不再出 `systemCommandPolicy`；system 的 INV-2、INV-3 移为本包的 INV-1、INV-2，INV-18 并进 INV-1。
- project 在它的实现层整理完之后迁过来，届时删掉仓库级 `tests/capabilities/command-danger-parity.test.ts`。

## Alternatives

- 放进 core：core 零依赖、无领域语义；命令安全判定是能力域的语义。
- 放进 platform：ADR 0005 划定 platform 不判断命令危不危险。
- 放进 agent：Termel、Workbench 这类宿主不该为一个判定依赖 agent 运行时；判定本身与 agent 无关（审批请求只借 agent 的两个小函数，用 peer 依赖）。
- 一个「共享包」装下四件事：杂物包，违反一包一义。

## Security and privacy

命令判定是无人值守放行、并发放行、强制确认三道闸的底；合并后只有一份，修一次处处生效。project 那份多出的兜底正则（`delete|exec|remove|write` 任一词出现就判非只读）随迁移删掉：它把 `grep -rn delete src` 这类只读命令判成要修改授权，而真正的写入形态由逐参数否决表覆盖（3489fa6 补齐了 rg、git grep、ls-remote、env -S、time -o、sed 脚本、tree -R）。

## Compatibility and migration

破坏性（地基重构期间不做兼容层）：`@velaros-ai/system` 根入口删掉 `systemCommandPolicy`、`SystemCommandPolicyApi`、`SystemCommandExecutionPlan`。宿主改从 `@velaros-ai/shell-command` 取：`analyzeCommandExecution(x)` → `shellCommandPolicy.analyze(x)`，`isShellCommandReadOnly(x)` → `shellCommandPolicy.isReadOnly(x)`，`isShellCommandLikelyMutating(x)` → `!shellCommandPolicy.isReadOnly(x)`，`buildBackgroundCommandConfirmationMessage(...)` → `shellCommandPolicy.confirmationMessage(...)`，`CommandExecutionPlan` → `ShellCommandPlan`。

## Validation

`check:module-ownership`（新包登记、4 条不变量）、包内验收与实现测试、system 全部测试、`tests/capabilities` 一致性测试、`check:capabilities-arch`、`check:host-contract-consumer`、`check:package-catalog`、`check:lockfile-consistency`。

## Consequences

后续的公共件（rehearsal-sandbox、text-files、path-rules）进同一个域；`module-ownership.md` 里「跨包同名常量不共享代码、各持一份」那句改为「抽成公共包，抽不出去的才镜像」。

## Addendum（2026-09-16）：`@velaros-ai/rehearsal-sandbox`

第二个公共件：演练沙箱的数据形状（`SandboxRecord`、`SandboxDiff`、`SandboxApplyOptions` 等九个）、公开上限 `RehearsalSandboxLimits`、落回审批的操作身份 `SandboxApplyOperationKind`，以及 `rehearsalSandboxRules.prepareApply`——只认不截断的完整差量、点名了没变化的路径在问用户之前就拒绝、条数与敏感路径按完整三列算、审批的操作身份带差量指纹。system 已改用它（`SystemSandbox*` 九个类型与 `SystemSandboxLimits` 删除，宿主端口直接用公共类型）；project 迁过来时，它那份「确认用截断差量、落回全落」的同类缺陷随之消失。镜像、差量、落回的引擎暂留 system（二期再议）。

## Addendum（2026-09-16）：project 迁入

project 改用两个公共件：命令判定、危险命令审批请求走 `@velaros-ai/shell-command`（project 那份判定与兜底正则删除，仓库级命令一致性测试删除，语料并进公共包的测试）；沙箱数据、上限与落回规则走 `@velaros-ai/rehearsal-sandbox`（`ProjectSandbox*` 九个镜像类型与 `ProjectSandboxLimits` 删除，`ProjectSandboxPort` 扩展 `RehearsalSandboxHostPort`，落回前要完整差量并带指纹）。

## Addendum（2026-09-16）：`@velaros-ai/text-files`

第三个公共件：磁盘文本的无损读写——编码识别（BOM → 无 BOM 的 UTF-16 → 读到 NUL 算二进制 → 严格 UTF-8 → GB18030）、严格解码、按原编码无损编码、GB18030 下沿用未改片段原字节的 `encodePreserving`、同目录临时文件加改名的原子替换（写完 fsync、权限位精确恢复、符号链接写到目标、拒绝多硬链接）、有界读、流式读。实现以 project 那份为底，它在 GB18030、严格解码、fsync、权限位、硬链接上全面比 system 那份健壮。

- 产品面：`textCodec`（`TextCodecApi`）、`textFileIo`（`TextFileIoApi`），以及它们造的 `TextEncodingProbeApi`（流式识别）、`TextStreamDecoderApi`（按块严格解码）；可移植数据 `TextEncoding`、`DecodedText`、`ExpectedBytes`、`TextChunk`，常量 `TextEncodings`、`TextFileErrorCodes`，从 `./contracts` 取。
- 报错一律 `AppError`，`code` 就是本包的码（`TEXT_FILE_NOT_TEXT`、`TEXT_FILE_LOSSY`、`TEXT_FILE_EXTERNAL_EDIT`、`TEXT_FILE_NOT_REGULAR`、`TEXT_FILE_TOO_LARGE`、`TEXT_FILE_INVALID_MODE`），文件系统的 errno 错误原样抛出；各空间在自己的边界按码翻译一次，不在包里掺空间语义。
- 按块解码不用运行时 TextDecoder 的 GB18030 流式状态：Bun 1.3 的实现会把被块边界切开的字丢掉、末尾没凑齐的字节也不报错，本包自己把没凑齐的字节接到下一块；Node 与 Bun 结果一致。
- 换行适配、行号偏移、文本匹配不进本包：两个空间的编辑语义不同，各自保留。
- project 已改用它：`utils/files/atomic-writer.ts`、`private-byte-io.ts`、`text-stream.ts` 删除，`utils/text.ts` 的编码部分与 `byte-codec.ts` 的字节保留编码删除，`ProjectTextEncoding`、`ProjectTextEncodingProbe`、`ProjectExpectedBytes` 删除改用 `TextEncoding`、`ExpectedBytes`（根入口不再导出 `ProjectTextEncoding`，宿主改从 `@velaros-ai/text-files/contracts` 取 `TextEncoding`）；本包的码在 `utils/errors.ts` 的 `projectErrorFromTextFile` 一处翻成 `ProjectError`（notText、notRegular → NOT_SUPPORTED，lossy、invalidMode → INVALID_INPUT，externalEdit、tooLarge → CONFLICT_WITH_EXTERNAL_EDIT），按 `ProjectError` 分支的逻辑一处未改。
- system 已改用它：`utils/text-file.ts` 的编码识别、编解码、BOM 与 UTF-16 处理、二进制判定、读文件头删除，`SystemTextEncoding` 删除改用 `TextEncoding`，`writeSystemFileAtomically` 改走 `textFileIo.writeBytes`（EACCES、EPERM 仍翻 PERMISSION，拒写的多硬链接文件翻 VALIDATION），有界读的超限翻回原来那句「用 system:run 截取」。随之而来的行为变化：GBK/GB18030 文件能读能改、整份写入不再悄悄改存成 UTF-8；非法 UTF-8 字节按二进制报错而不是读成替换字符；孤立代理项与多硬链接文件在计划期就拒绝（not-applied）；写入 fsync、已有文件权限位精确保留、新文件权限由 umask 定；极短的无 BOM UTF-16 能认出。


## Addendum（2026-09-16）：`@velaros-ai/path-rules`

第四个公共件：路径命中规则——glob 匹配、.gitignore 的解析与判定、遍历时的忽略策略、默认跳过的 23 个目录名。实现以 project 那份 glob/gitignore 引擎为底（system 那份逐段精确比较的解析器认不出 `/build*`、`docs/*.md`、`**/tmp`、`a/**/b`、`[Dd]ist`、转义的尾随空格），补上 system 那份唯一做对的 directoryOnly（`build/` 只匹配目录）。

- 产品面：`pathMatcher`（`PathMatcherApi`）、`gitignoreRules`（`GitignoreRulesApi`）、`createIgnorePolicy` 造的 `IgnorePolicyApi`；注入面 `GitCheckIgnoreRunner`（批量问 `git check-ignore --no-index --stdin -z`，拿不到 git 返回 null 由本地规则兜底——本包不起子进程）；可移植数据 `GitignoreRule`、`PathMatchOptions`、`IgnoreCandidate`、`IgnoreRulesOrigin`，常量 `DiscoverySkippedDirectoryNames`，从 `./contracts` 取。
- glob 匹配多了大小写敏感开关：缺省区分（git 自己就是这么判的），大小写不敏感的盘上按路径身份判定时传 `caseSensitive: false`。编译缓存是 `PathMatcher` 实例的状态，不再是模块级可变状态。
- 「目录被忽略则里面的一切跟着被忽略」由判定时按各级上级目录推，不再给每条规则额外展开一条 `pattern/**`——那种展开会让名叫 `build` 的**文件**被 `build/` 命中。
- 注释与取反判在还原转义之前：`\#foo`、`\!foo` 是字面量（project 那份先还原转义，`\#foo` 被当成注释整行丢掉）。
- 真实路径与「在不在根里」不进本包：前者在 `@velaros-ai/core/utils/RealPath`，后者在 `@velaros-ai/platform` 的 `isPathTextInside`／`relativePathTextInside`（ADR 0005）。

## Addendum（2026-09-16）：`@velaros-ai/tool-contract`

第五个公共件，也是第一个不是从两个空间合并而来、而是**从 agent 拆出来**的：写一条工具要用到的全部契约。
七个空间（system、project、browser、office、memory、computer、knowledge）原来只为「写工具」就把整个 agent 运行时列成 peerDependency，而工具契约本身与 agent 的回合循环没有关系。按「一包一义」与「出现独立消费者才成包」，它独立成包。

- 产品面：`toolContracts`（`ToolContractDefinitionApi`：定义工具、编译模型面说明、鸭子判定与只读判定）、`toolDescriptions`（`ToolDescriptionsApi`：分节语法的渲染、判定、解析、精简与两道长度闸）、`toolSchemas`（`ToolSchemasApi`）、`toolIdentity`（`ToolIdentityApi`）、`toolInputForgiveness`（`ToolInputForgivenessApi`）、`toolKernelModules`（`ToolKernelModulesApi`）、`toolFailures`（`ToolFailuresApi`）、`toolExamples`（`ToolExampleRegistryApi`），以及模块级工厂 `createToolExampleRegistry`、`renderToolExampleInputs`、`serializeToolExampleInput`；注入面 `ToolContextResolver`；可移植数据与常量从 `./contracts` 取。
- 三件到处重复的公共件随这一轮落进去：`toolContracts.createDefiner` 取代四份逐行同构的 `defineXTool`；`toolKernelModules.define` 与 `ToolCapabilityService` 取代 system、project、office 三份内核模块样板；`toolFailures.create` 与 `ToolFailureLimits` 统一 `not-applied` / `skipped` / `failed` 三种失败信封，各包只出自己的错误码。
- 本轮**不搬**的三块，理由写在这里以免下一轮重开会：`ApprovalPort` / `InteractionPort` 与它们的缺省实现（`ToolConfirmationDecisionOptions` 的签名闭包要拖进 `UserActionCard` 一族 17 个类型，`InteractionPort` 要拖进整套执行记录，都是产品面而不是工具契约）；`withToolInputReuse` / `resolveToolInputReuse` 一族（账房绑着 agent 的 `ContextPayloadStore`）；`fileContextFor` 与文件上下文登记（同上）。它们仍从 `@velaros-ai/agent/tool-contract` 出，agent 收口那一轮再定去留。
- 工具协议类型（`ToolPermission`、`ToolCategoryId`、`ToolCapabilitySchema`、`ToolExposurePolicy`、`ToolContractRole`、`ToolSurfaceProfileId`、`ToolModelInputModality` 一族）在本包的可移植文件里是**同形副本**：agent 的可移植数据文件按标准一个 import 都不许有，两边只能各持一份，由仓库级一致性测试 `tests/tool-contract/protocol-mirror.test.ts` 守着（同 `SystemShellKind` 的先例）。agent 收口那一轮若放宽可移植文件的 import 规则，这份副本删掉、agent 改从本包取。
- `tool-input-bounds`（有界读与递归深度的那几个 zod 帮手）留在 agent：它们的返回类型是 zod 推出来的形状，写成显式接口会把 zod 版本钉进合同；browser 继续从 `@velaros-ai/agent/tool-contract` 取。
