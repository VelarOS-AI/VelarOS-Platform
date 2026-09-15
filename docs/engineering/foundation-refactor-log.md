# 地基重构流水账（2026-09-15 起，马拉松授权）

用户授权：把 system 的规范推成全仓标准，依次处理 project、system 与 project 的公共逻辑、agent 及其余包（ui 不动）。
实现细节自行决策；产品层与设计相关的决定写在「需要你看的」里。每完成一部分提交一次，不推送。

顺序：① 复查 system 的结构 → ② system 实现层与产品层（输入输出契约）复查修 bug，定为仓库标准 → project 按同一套改造并复查 →
③ system 与 project 的公共逻辑抽出去 → 其余包（agent 优先，ui 不动）。

## 需要你看的（产品层、契约、提示词、工具面）

（按时间追加。每条写：改了什么、为什么、影响谁。）

- **project 迁入两个公共件，修掉三个缺陷（09-16 03:50，ADR 0008 附录）。** ① 沙箱落回：原来确认用的是截断到 2000 条的差量、落回却全部落，也不核对确认之后镜像有没有再变；现在向宿主要完整差量（`diffSandbox({ maxFiles: Number.MAX_SAFE_INTEGER, textDiffs: false })`），确认文案按完整三列算，`applySandbox` 带上差量指纹。**宿主契约变化**：`ProjectSandboxPort` 改为扩展 `RehearsalSandboxHostPort`，`diffSandbox` 要认 `textDiffs`、差量要带 `fingerprint`，`applySandbox` 要认 `fingerprint`（Desktop 用系统本地内核实现时这些已经支持）；`ProjectSandbox*` 九个数据类型改从 `@velaros-ai/rehearsal-sandbox/contracts` 取。② 经内核按名调用 project 工具时，原来先解析宿主上下文、后校验入参（和它自己的注释相反），现在先校验；入参不合法报 `VALIDATION`（和 system、office 一样），不再伪装成项目领域的 `INVALID_INPUT`。③ 沙箱 source 写 `..cache` 这类以 `..` 开头的项目内目录不再被误拒。
- **project:run 的判定改用公共判定，行为有两处变化（09-16 03:50）。** project 原来那份只读判定多一道兜底正则：命令里出现 delete、exec、remove、write、okdir 这几个词就判「会改项目」，所以 `grep -rn delete src` 这类只读命令也要过项目修改授权、不能并发；公共判定按参数逐条否决，这类命令现在判只读。危险命令确认文案在递归删除时多一句「如果目标是一个项目或仓库目录（含 .git），未推送的提交和未提交的改动会一起没掉，无法找回」（ADR 0004 的承诺，system 早就有）。
- **project 工具的「适用」一节不再是占位句（09-16 03:50）。** `defineProjectTool` 原来给没写的说明节塞通用句（「需要完成该工具职责所描述的项目操作。」「目标不属于当前项目边界。」等五句），它们原样进了 read、list、search、file、edit、change、run、code-analysis 八个工具的提示词。现在只写真有内容的节：这八个工具各补了一句真正的适用场景，其余占位句删掉。提示词审核指纹要等 agent 第 1 步提交后在干净工作区重算（指纹也登记了 agent 源文件）。

- **project 正式纳入门禁（09-16 03:10）。** 模块卡片、12 条不变量（验收 10 条全经根入口测试）齐了，登记表去掉「迁移中」，门禁与 system 一样零条。
- **project 注入面与产品面收窄（09-16 03:10）。** 工具从来不调、内核从来不读的成员删掉：`AgentProjectKernelPort` 的 `resolveTarget`、`fixTransaction`、`validate`、`diff`（领域内核 `ProjectKernel` 上照旧有，宿主直接调内核不受影响）；`ProjectCodeIntelligenceHost.available`（内核只看 `isProjectEnabled`）；`CreateProjectKernelOptions.metadata`；`SandboxProvider` 与 `ProjectProviders.sandbox`（全仓和两个产品没有一个插件用）。`ProjectKernel` 去掉 `createTaskContext`、`getJournal`（全仓与 Desktop、Workbench 零调用）。影响：宿主实现这些端口时可以少写几个成员；Desktop 代码智能后端上的 `available` 字段多写着也无妨。
- **project 模型看得到的 14 条报错与回执改成中文（09-16 03:10）。** fileRef、续读引用、历史快照授权、文件上下文登记、编辑目标、引用存储不可用等，原文与新文逐条见提交 25393627 的说明；另有 ripgrep 超时诊断改中文（project:search 不转发它，直接调内核的宿主看得到）。命令、路径、错误码、字段名没动。

- **project 事务状态文件无效时的报错改成中文（09-16 02:10）。** `Invalid project transaction state: …` → `事务状态文件无效：…`；冒号后面的具体原因（`transaction status/appliedAt mismatch` 这类）暂保持英文，因为它们同时写进 `details.stateValidationFailure`、测试按字串匹配，下一轮连同字段一起改。

- **新包 `@velaros-ai/rehearsal-sandbox`：沙箱数据形状、上限与「确认的就是要落的」落回规则抽成公共件（09-16 01:50，ADR 0008 附录）。** system 已改用它：`@velaros-ai/system` 不再导出 `SystemSandbox*` 九个数据类型和 `SystemSandboxLimits`，宿主改从 `@velaros-ai/rehearsal-sandbox/contracts` 取 `SandboxRecord`、`SandboxDiff`、`RehearsalSandboxLimits` 等（字段完全一样）。模型与用户看到的没有变化（system 的确认文案原样搬过去，末句参数化）。project 迁过来时顺带修掉它「确认用截断差量、落回却全落」的缺陷。

- **工具集合挂进内核的那段逻辑收进 `@velaros-ai/agent/tool-contract`，office 的报错跟着变成中文（09-16 01:10）。** `parseToolWireInput`、`createToolCallableOperations` 取代 system、office 各自的一份（project 那份在它整理完后换）：先严格解析入参、再向宿主解析上下文（坏入参不会触发宿主解析）、核可用、核取消、执行，工具抛的错可交给 `mapError` 翻译。影响：office 经内核调用时的报错从英文（`Office capability input is invalid` 等）变成「办公能力的入参不合法：…」这类中文；system 的文字不变。agent 升 0.6.31，公开 API 基线按只增不减重绑（基线在这之前就已落后 6 个声明，一并绑上）。

- **新包 `@velaros-ai/shell-command`：命令判定从 system 抽出来，新开「能力公共件」一域（09-16 00:50，ADR 0008）。** 只读、危险、长驻判定，并发判定，确认文案，危险命令的审批请求（操作身份跨工具一致）都在这一个包里；system 已改用它，project 在实现层整理完之后迁过来。影响：`@velaros-ai/system` 不再导出 `systemCommandPolicy`、`SystemCommandPolicyApi`、`SystemCommandExecutionPlan`；Desktop、Workbench、Termel 的命令判定改从新包取（对照表在 ADR 0008）。模型看到的没有变化（system 的判定原样搬过去）。**要你拍板的两件事留着没动**：project:run 要不要像 system:run 一样对长驻命令（`npm run dev` 这类）弹低风险确认；危险命令被拒时 system 抛错、project 返回结构化拒绝，要不要统一。
- **仓库里两个测试的假路径换成 example 用户（09-16 00:50）。** `check:public-readiness` 把 macOS 家目录下的具体用户名当开发者本机路径拦下（system 修复代理新加的用例和一个 UI 渲染测试），只改测试数据。

- **project 的错误原因做成合同常量表，删掉六个从没出现过的码；宿主端口去掉 codeAnalysisAvailable（09-16 00:10）。** `ProjectErrorCodes`（14 个码，每个写明含义）进 `@velaros-ai/project/contracts`，宿主按码分支有了单一出处。`LOW_CONFIDENCE_TARGET`、`ANCHOR_MISMATCH`、`PATCH_PARSE_ERROR`、`POSTCONDITION_FAILED`、`FORMATTER_CHANGED_TOO_MUCH`、`TEST_FAILED` 全仓没有一处产生、也没有一处判断，删了（合同不该承诺永远不会出现的码）。`ProjectToolApi.codeAnalysisAvailable` 工具从来不调，只有 Desktop 自己在 manifest 里调它当可用性判断；可用性本来就由宿主传给 `createProjectCodeAnalysisTools(isAvailable)` 的回调决定，端口上这一项多余。影响：Desktop 那行 `context.project.codeAnalysisAvailable?.()` 要改成宿主自己的判断。

- **project 的入口收成两个，公开面按「包自己用得上」重划（09-15 23:40）。** 和 system 一样只剩 `@velaros-ai/project`（Node 宿主）与 `@velaros-ai/project/contracts`（可移植数据）；`/files`、`/changes`、`/execution`、`/runtime`、`/agent`、`/composition`、`/kernel`、`/transaction-controller` 都删了。产品（Desktop、Workbench）要跟着改 import，对照如下：
  - 换了形状的：`registerProjectFileContext(ctx)` → `projectFileContext.register(ctx)`（返回是否登记上）；`installProjectApprovalProvider` / `withProjectApproval` → `projectApprovalBridge.install(kernel)` / `.run(ctx, action)`；`new FileProjectChangeFeed({ path })` → `createFileProjectChangeFeed({ path })`；有限事务面的接口改名 `ProjectTransactionControllerApi`（工厂名不变）；`isProjectCodeLanguageQuery` → 常量表 `ProjectCodeLanguageActions`；`PROJECT_PACKAGE_VERSION` → `ProjectPackageVersion`。`createProjectKernel`、`typescriptPlugin`、`createSecretRedactionProvider`、`createProjectSpace`、`projectTools` 等从根入口取。
  - 不再导出、等第三步抽公共包的：命令判定（`analyzeCommandExecution`、`isShellCommandLikelyMutating`、`buildBackgroundCommandConfirmationMessage` 等）将进新包 `@velaros-ai/shell-command`；路径包含判断（`isPathInsideProjectRoot` 等）将进 platform。
  - 删掉的（project 自己一处都没用，是产品主进程和渲染进程之间的数据形状）：57 个宿主数据类型（`ProjectGit*`、`ProjectReadFileResult`、`ProjectRootEntry`、`ProjectInfo`、`ProjectFileEntry` 等）、`ProjectRootSource` / `isProjectRootSource`（值就是 `ProjectSpaceId`）、目录可见性表（`ProjectExcludedDirectoryNames`、`shouldSkipProjectDirectory` 等）。**设计点**：Desktop 文件树用的跳过表和模型 list/search 实际用的排除规则（gitignore 加内置排除 glob）本来就是两套，删掉之后更明显；要不要让界面和模型看到同一套，是产品层重构时要定的。
  - 不再导出的实现细节：各工具的 zod schema（入参类型照旧导出）、`executeAgentProjectRead` 等单个执行函数、`finalizeProjectModelResult`、`ProjectError` 类（宿主按错误码判断）、`DEFAULT_CORE_POLICY`、`ToolContext` 别名、`VelaToolSurface`。
- **project 工具说明里的数字改引常量表，模型看到的两处小变化（09-15 23:40）。** 新增常量表 `ProjectFileLimits`、`ProjectChangeLimits`、`ProjectCodeLimits`、`ProjectCommandLimits`、`ProjectSandboxLimits`、`ProjectTransactionLimits`、`ProjectToolExposure`（工具排位，数值不变），schema 和说明都引它们。模型看到的变化：project:read 的用法从「range（51 或 [42,45]）」改成「range（单个行号或 [首行,末行]）…最多 20 个文件」；project:run 的 timeoutMs、maxOutputChars 补了和 system:run 一样的字段说明。宿主代码查询的形状 `ProjectCodeQuery` 从 zod 推导改成显式类型，放进可移植数据。提示词审核指纹已重算。

- **project 的工具定义收进一个文件，read/search 的说明与 read 的参数报错改成中文（09-15 22:10）。** 九个工具加 project:code-analysis 的全部定义（说明、schema、示例、权限、能力声明）现在都在 `packages/project/src/impl/ProjectTools.ts`，按读取、改动、代码理解、执行四类排，文件末尾是分组、内置 mod、内核模块和项目空间的组装；execute 各一行，交给 `impl/operations/` 里的六个执行类。模型看到的变化只有两处：project:read、project:search 的摘要和用法原来是英文，改成中文；read 参数校验的四条报错改成中文。工具名、字段名、示例不变。提示词审核指纹已重算。
- **宿主契约：项目工具上下文不再带 `system` 字段（09-15 22:10）。** `ProjectToolContext.system`（只有一个 `canStartBackgroundCommands`）删了，和 system 包按 ADR 0003 删掉同名开关一致：宿主不能或不允许跑后台命令，就在 `project.runCommand` 里以 PERMISSION 拒绝。子代理的边界原来只包了 system 端口的 runCommand，project:run 靠那个开关挡后台命令；开关删了以后我把 agent 包的子代理边界扩到 project 端口（`LoopRuntime.withoutBackgroundCommands`，加了测试），子代理经 project:run 起后台进程仍然被拒。代价：危险命令加后台加子代理这种组合，用户会先看到确认卡，确认后才被拒。
- **project 的入口不再导出单个工具的 schema（09-15 22:10）。** `ProjectCodeSchema`、`ProjectCodeAnalysisSchema` 从 `@velaros-ai/project/contracts` 和 `/agent` 撤掉（入参类型 `ProjectCodeInput`、`ProjectCodeAnalysisInput` 照旧导出）；要 schema 的宿主从工具集合里取 `projectTools['project:code'].schema`。`executeProjectRead` 等单个执行函数也撤了，统一走 `projectCodeOperations` 和 `createProjectCallableOperations`。仓库里没有外部调用方。

- **project 删掉第 1 版模型工具与入参迁移（09-15 21:05）。** project:write、project:rollback、project:query-code 和按行号改的旧版 project:edit/read 不再由生产包提供；第 1 版失败调用迁移成第 2 版复用的逻辑也删了。影响：升级前开始的老会话里模型不能再调旧版工具（新会话本来就只看得到第 2 版）。旧版工具整体挪进 packages/project/test/support/ 当测试驱动器，那 6 个测试文件照旧跑，测的仍是生产里的内核、事务与文件上下文行为。
- **收编的遗留功能改变了模型在失败后看到的内容（09-15 20:50）。** 修改类调用失败且确证没写入时，紧接着的那一次决策里模型看到完整的原参数（上限 32000 字符），不必先召回正文；再往后恢复省略形态。project 的提示词审核指纹因此重算（提示词本身没变，变的是指纹登记的两个 agent 源文件）。
- **system 的报错与提示统一成中文（09-15 20:40）。** 模型会看到的报错、edit 的问题清单、失败回执里的建议下一步、沙箱冲突说明、shell 自检原因共 80 多处从英文改成中文；命令、路径、错误码、字段名不变。工具说明本来就是中文，现在同一个回执里不再中英混排。影响：宿主若按英文报错文本做判断会失效，应改按错误码（`SYSTEM_SHELL_UNAVAILABLE` 这条原先被标成「英文文本是公开契约」，已改口）。

## 决策记录

| 时间 | 决策 | 理由 |
| --- | --- | --- |
| 09-15 20:05 | 收编此前会话留下的 9 个未提交文件（agent 的失败调用原参数还原 + 两个测试），单独提交 5df228b | 用户确认没有会话在跑；改动完整、测试通过，丢掉会损失一个已做完的功能 |
| 09-15 20:05 | 模型看到的文字（工具说明、报错、建议的下一步）统一中文，命令、路径、错误码、字段名保持原样 | 工具说明已是中文，报错中英混杂读起来割裂；用户未反对默认做法 |
| 09-15 20:05 | 其他包的工具面按 system 的判据简化：别的工具替代得了、只剩仪式感的才删；模型没用过但有独特能力的不删 | 用户要求简化工具面；判据沿用已定的 system 做法 |
| 09-15 21:00 | 旧版工具不直接连测试一起删，而是挪进 test/support 当驱动器 | 6 个测试文件借旧版工具测真行为，改写成第 2 版 fileRef 流程成本高；挪走后生产面干净、覆盖不丢，以后可以逐个改写 |
| 09-15 21:00 | ProjectError 暂留、挪进 utils/errors.ts，门禁允许 utils 放只有字段的错误类 | 190 处抛出、agent 的纠错逻辑读它的字段，一并换成 AppError 牵连太大；是否统一成 AppError 另行评估 |
| 09-16 03:10 | 删掉 project 的命令校验器与 prettier/eslint 修复器及其预设（CommandValidator、PrettierFixer、EslintFixer、command-checks） | 自 80c8e7de（8 月把 validationPlugin 入口删掉）起没有任何入口能用到，一个半月没人发现；要找回就从那个提交之前取 |
| 09-16 03:10 | 删掉 `createFileFilterProvider`、`createAllowAllPolicyProvider` 与路径包含判断的三个旧函数 | 全仓与两个产品零引用（Desktop 仍 import 那三个路径函数，但根入口早已不导出，属于产品层重构时的接线；第三步会在 platform 提供统一的路径包含判断） |
| 09-16 03:10 | 只有测试在用的第 1 版协议（`utils/edit-intent.ts`、`utils/agent/edit-target.ts`、`EditTarget`）挪进 `test/support` | 生产包里不留只为旧测试服务的代码，测试照旧用它们驱动内核 |
| 09-16 03:10 | 模型入参的 `ProjectCodeScope` 与宿主查询的 `ProjectCodeLanguageScope` 合成一个 `ProjectCodeScope`（放在可移植数据里） | 字段一模一样，一个概念两个名字 |
| 09-16 03:10 | 登记为 project 复查轮的待办：utils 里的模块级可变状态（`file-refs` 没有载荷存储时的进程内兜底、glob 与 JS/TS 解析的记忆化缓存）；门禁收紧「utils 不存状态」 | fileRef 兜底存储是有语义的状态，改法牵涉整个 Agent 适配层；记忆化缓存不改变结果，门禁收紧时要给它留口子 |
| 09-16 02:10 | project 事务状态文件的格式上限（Maximum*）归为可调参数进 `ProjectTuning.persistence`，并写明「不能小于内核保留的事务数」 | 它们跟着内核的事务保留数与宿主策略走，不是对外承诺；格式版本号属于格式规则，留在校验旁边 |
| 09-16 02:10 | 删掉 `PluginRegistrySink`，插件登记表直接收 `ProjectPluginContext` | 两者形状一模一样，一个概念两个名字 |
| 09-16 01:30 | 门禁加「迁移中」状态与 `--only`/`--list`：迁移中的包照查照报条数、不计入失败；每个包的 ✓ 不再被前面包的失败吞掉 | project（以及之后的 agent）改造期间就能登记、看燃尽，登记表不用一直挂在工作区里不提交 |
| 09-16 00:50 | 公共件单独成域 `foundations`，不进 core、不进 platform、不登记进能力归属表 | core 要零依赖无领域语义，platform 按 ADR 0005 不判断命令危险；公共件被多个能力空间依赖，登记成能力 owner 会被判跨 owner |
| 09-16 00:50 | shell-command 的判定取 system 那份，project 的兜底正则迁移时删掉 | system 那份逐参数否决、没有误报，确认文案带 ADR 0004 承诺的仓库提醒；兜底正则把 `grep -rn delete src` 判成要修改授权 |
| 09-16 00:50 | 并发判定参数化（optIn），不在这次统一两个空间的缺省 | system:run 的 schema 有 parallel 字段、要求显式声明；project:run 没有这个字段、只读即并发；统一与否是产品决定 |
| 09-16 00:50 | 审批请求只出「文案 + 选项」，被拒语义留给空间 | system 被拒抛错、project 返回 skipped，两种都有测试钉着；公共包只保证操作身份一致 |
| 09-16 00:10 | 门禁再放宽两处：utils 可以放只有字段、写了中文说明的错误类；宿主端口「工具真会调」的核对从工具文件出发沿相对 import 走到 impl 与 utils，端口字段名可登记 | ProjectError 被 utils 里上百处抛出，utils 又不许引 impl；project 的端口调用在 utils/agent 里，只看工具文件和它直接委托的类会误报「没人调」 |
| 09-16 00:10 | project 实现层达标拆给四个并行子代理：内核与文件、事务与持久化、策略插件适配器、工具函数与合同文档；各自只改自己的目录，用临时索引提交 | 约 700 条门禁问题、互相之间多为纯机械工作；按目录切开冲突最少，共用索引的提交竞态用临时索引规避 |
| 09-15 23:40 | 门禁放宽一条：合同文件可以 `import type` provides.ts 登记过的类上方接口 | 项目空间（`ProjectSpace.kernel`）要引用领域内核的接口；接口按规矩写在类上方，合同里只能引用它，不能搬走 |
| 09-15 23:40 | 有限事务面和落盘变更记录保留并改成类加工厂，没有删 | 眼下产品没用，但它是给界面那一侧的最小权限面（拿不到内核），产品层重构接 IPC 时正用得上；实例上用 `#` 私有字段存内核，测试钉住「没有可枚举状态、只有五个方法」 |
| 09-15 23:40 | 旧版工具驱动器定义完之后把全局示例表还原成现行工具的示例 | 旧版有三个工具和现行同名，定义时覆盖全局示例表，谁先加载决定别的测试读到哪版示例，全量跑时偶发失败 |
| 09-15 23:40 | 声明搬家脚本修一处：类的 `extends` 按值引用处理 | 原来当成类型位置，搬走的子类被补成 `import type` 父类，运行时报错 |
| 09-15 22:10 | project 的工具定义收进 `impl/ProjectTools.ts` 一个文件，重实现搬进 `impl/operations/` 的六个执行类（文件、改动、执行、代码、执行门、审批桥） | 和 system 同一套：工具文件只放定义、execute 不超过 4 句；原来 14 个工具文件、9 个 schema 文件、3 个组装文件各管一片，改说明要跳 3 处 |
| 09-15 22:10 | project:edit、project:file、project:change 三个入参 schema 在工具文件里具名导出 | 编辑类工具的 schema 会被 agent 的 `withToolInputReuse` 包成 pipe，测试要断言原始对象形状，只能拿到未包装的那个 |
| 09-15 22:10 | 执行门（同一项目根的读写排队）从模块级函数改成 `ProjectExecutionGate` 类，由三个执行类构造注入 | 一类一文件、类上方写接口；测试可以各建一个门互不干扰 |
| 09-15 20:05 | 公共逻辑的去处由我定：system 与 project 共用的部分进按含义新建的包，不塞进 platform | 用户授权；platform 只管跨平台兼容，一包一义 |

## 进度

- [x] ① system 结构复查（386ea2d、114a6c3、d692e79）
- [ ] ② system 复查修 bug（已完成：18 条，9 个提交 21fcb91…c8a2983）、定为仓库标准（已完成）；project 改造（已完成：工具面 8d7513e、入口 bc93fd0、错误码 1ea639d、实现层四路、卡片与不变量，门禁零条）；project 复查修 bug
- [ ] ③ 公共逻辑抽取
- [ ] 其余包：agent → browser → memory → kernel → model → office → agent-lab → development → core → html-artifacts → computer → cli → document-renderer → surface-protocol
