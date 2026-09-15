# 地基重构流水账（2026-09-15 起，马拉松授权）

用户授权：把 system 的规范推成全仓标准，依次处理 project、system 与 project 的公共逻辑、agent 及其余包（ui 不动）。
实现细节自行决策；产品层与设计相关的决定写在「需要你看的」里。每完成一部分提交一次，不推送。

顺序：① 复查 system 的结构 → ② system 实现层与产品层（输入输出契约）复查修 bug，定为仓库标准 → project 按同一套改造并复查 →
③ system 与 project 的公共逻辑抽出去 → 其余包（agent 优先，ui 不动）。

## 需要你看的（产品层、契约、提示词、工具面）

（按时间追加。每条写：改了什么、为什么、影响谁。）

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
- [ ] ② system 复查修 bug、定为仓库标准；project 改造；project 复查修 bug
- [ ] ③ 公共逻辑抽取
- [ ] 其余包：agent → browser → memory → kernel → model → office → agent-lab → development → core → html-artifacts → computer → cli → document-renderer → surface-protocol
