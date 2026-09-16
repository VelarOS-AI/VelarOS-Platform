# system ↔ project 公共逻辑抽取方案（只读分析报告）

> **快照**：2026-09-15 21:05–21:30（CST），仓库 `~/Desktop/VelarOS/projects/VelarOS-Platform`，HEAD `3489fa6`（fix(system,project): 只读判定不再被参数、前缀和环境变量绕过）＋ project 包未提交的搬家改动。
> **两个包都在被并行实例改**：分析期间 project 的 `impl/tools/*` 被收进 `impl/ProjectTools.ts`＋`impl/operations/*`＋`utils/agent/*`，`exports/kernel.ts` 的逻辑搬进 `utils/tool.ts`；两份 `command-policy.ts` 在 3489fa6 里各改了约 249 行（主要是新增）。下文路径以 21:25 的磁盘为准，**函数名比路径稳定，按函数名找**。
> 本报告没有改仓库任何文件。对比实验脚本放在草稿区（`policy-diff.ts`、`gitignore-diff.ts`、`text-diff.ts`），只 import 源码、不写盘，文中"实测"都出自它们。

---

## 0. 结论先行

| # | 项 | 相同度 | 结论 | 去处 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | 危险命令与只读判定 | 规则主体逐字相同，5 处差异 | 完全可合并 | **新包 `@velaros-ai/shell-command`** | P0 |
| 2 | 审批请求（危险命令、落回）与确认文案 | 3 处构造同形 | 参数化后可合并 | shell-command 的 `./approval`、rehearsal-sandbox | P0/P1 |
| 3 | 演练沙箱（入参、数据、落回确认、筛选、上限） | 数据 9 个类型字段逐一相同，筛选函数逐字相同 | 契约与规则可合并；工具 schema/说明留各空间 | **新包 `@velaros-ai/rehearsal-sandbox`** | P1 |
| 4 | 工具定义辅助（defineSystemTool / defineProjectTool） | 同一件事，6 处行为差异 | 参数化后可合并 | `@velaros-ai/agent/tool-contract` | P1 |
| 5 | 内核模块可调用操作表（system / project / **office 第三份**） | 同形 | 参数化后可合并 | `@velaros-ai/agent/tool-contract` | P0 |
| 6 | 文本文件编码识别/BOM/UTF-16/二进制/原子写入 | 同一件事，project 全面更健壮 | 参数化后可合并 | **新包 `@velaros-ai/text-files`** | P1 |
| 7 | gitignore 解析与 glob 匹配、默认跳过目录 | 两套引擎，各有缺陷；跳过名单 23 项逐项相同 | 参数化后可合并 | **新包 `@velaros-ai/path-rules`** | P2 |
| 8 | 路径包含判断、真实路径 | 两包内各 3–4 份，仓外还有 2 份 | 可合并 | 词法判定→`@velaros-ai/platform`；真实路径→`@velaros-ai/core` | P2 |
| 9 | 敏感路径与凭证判定 | 只在 system | 不是重复，是 project 的缺口 | 暂留 system；若 project 采用再进 path-rules | — |
| 10 | 命令结果整形与输出窗口 | 数据形状同（共 17 字段），整形只在 system | 数据可合并，整形不是重复 | shell-command 二期 | P2 |
| 11 | 错误信封（not-applied、reason/details/下一步、列表上限） | 同一约定三种写法 | 参数化后可合并 | `@velaros-ai/agent/tool-contract` | P1 |
| 12 | 其他：mod/内核模块样板、代理对安全截取、errno、run 的 shell 语法提示词、执行上限常量 | 同形 | 见 §3.12 | agent/mods、core、shell-command | P2/P3 |

**推荐**：新建 4 个按含义命名的包（shell-command、text-files、path-rules、rehearsal-sandbox），另往 agent/tool-contract、platform、core 各加几项；预计**净删源码约 1,700 行**（另搬家约 1,000 行）、**净删测试约 400 行**，外加 P3 的 mod 样板约 250 行。顺带发现 12 处缺陷（§4），其中 2 处是安全相关（沙箱落回确认只看了截断后的前 2000 条；project 内核直调先解析宿主上下文再校验入参）。

---

## 1. 约束：治理规则里跟本方案有关的条款

1. `docs/architecture/module-ownership.md`「共用与重复怎么处理」：跨包相同逻辑抽到**按含义命名**的公共包，两边都依赖它；**域无关原语去 core，跨平台兼容去 platform，其余新建，一包一义**；抽不出去的镜像才用一致性测试守。公共包同样按本标准治理。
2. 同一文档「常量分四处」还写着"跨包的同名常量不共享代码……由仓库层的一致性测试守着（命令策略、沙箱契约）"——**与上一条矛盾**，落地时要在 ADR 里改掉这句。
3. ADR 0005：platform "不执行命令、不读写文件。危险判定与审批仍只在 system" → 命令策略不宜放 platform。
4. core：`package.json` 没有任何依赖；README 要求无领域语义、不依赖任何 VelarOS 领域包、至少被两个不相邻领域复用 → 依赖 iconv-lite / picomatch 的东西、能力域语义（命令策略、沙箱）都进不了 core。
5. **可移植数据文件"不 import"**（system `types/system.ts`、project `types/project.ts`，是 `./contracts` 的来源）→ 公共包里的数据类型不能被两边的可移植契约直接引用。数据契约类合并（沙箱数据、命令回执）的前置条件是把规则放宽为"可以 `import type` 另一个已治理包的 `./contracts`"（传递后仍然可移植）。否则只能继续结构镜像（像 `SystemShellKind` ↔ `ShellKind` 那样）。
6. 治理包的出口规则：类、utils 函数不出包，只能导出契约常量表与"按公开接口标注类型的实例/工厂"→ 公共包要以 `xxxApi` 接口 + 唯一实例的形式出（像现在的 `systemCommandPolicy`），下面的接口草案都按这个写。
7. `platform-boundaries.md`：一个域一个包，除非真有独立分发需求。**新包的理由**：Desktop、Workbench、Termel 现在为了 `analyzeCommandExecution` / `isShellCommandReadOnly` 这类纯函数去依赖整个 `@velaros-ai/project`（它的运行时依赖含 typescript、execa、iconv-lite、picomatch、diff）；Desktop 宿主命令执行器的兜底拒绝（`CommandHelper.validateCommand`：没传 allowDangerous 就拒危险命令）用的也是 project 那份。
8. 拓扑变更要写 ADR（建议 0008）并走 `repository-topology.md` 的 7 步。

---

## 2. 外部消费者（迁移要一起改）

| 仓库 | 文件 | 用到 |
| --- | --- | --- |
| Desktop | `src/main/host/commands/CommandHelper.ts` | `analyzeCommandExecution`（从 `@velaros-ai/project` 根入口） |
| Desktop | `src/mods/project/main/collaboration/ShellCommandClassifier.ts` | `isShellCommandLikelyMutating`（project 根入口） |
| Desktop | `src/main/tools/ToolContextTypes.ts` | `ProjectSandboxPort`（project 根入口——**是旧的工作区 overlay 那个**，见 §3.3 命名冲突） |
| Workbench | `src/main/workspace/CommandExecutionPolicy.ts` | `analyzeCommandExecution`、`CommandExecutionPlan`（`/execution`） |
| Workbench | `src/main/workspace/ProjectCapabilityProvider.ts`、`src/main/agent/WorkbenchAgentUiTools.ts` | `buildBackgroundCommandConfirmationMessage`（`/execution`） |
| Termel | `packages/termel-runtime/src/kernel-tools.ts` | `isShellCommandReadOnly`（`/execution`） |

---

## 3. 逐项分析

### 3.1 危险命令与只读判定

**位置**
- system：`packages/system/src/utils/command-policy.ts`（807 行）——`isSystemShellCommandReadOnly`、`analyzeCommandExecution`、`isParallelCommandExecutionSafe`、`buildBackgroundCommandConfirmationMessage`；包装类 `impl/SystemCommandPolicy.ts`（实例 `systemCommandPolicy`，根入口出包）；类型 `types/commands.ts::SystemCommandExecutionPlan`、`ShellInvocation`。
- project：`packages/project/src/utils/command-policy.ts`（839 行）——`isShellCommandReadOnly`、`isShellCommandLikelyMutating`、`analyzeCommandExecution`、`isParallelCommandExecutionSafe`（别名 `isParallelCommandSafe`）、`buildBackgroundCommandConfirmationMessage`（别名 `buildBackgroundCommandNotice`）；`CommandExecutionPlan`、`ShellInvocation` 直接声明在 utils 里（治理规则不许 utils 声明类型）；`./execution` 入口 `export *` 整个文件。
- 仓库层：`tests/capabilities/command-danger-parity.test.ts`（166 行：危险 50 条、只读绕过 25 条、只读 10 条、日常 28 条）。

**异同**（去掉注释后逐行 diff；危险名单、git 子命令判定、rm/Remove-Item/cmd 词法、sed 整段解析、前缀命令与环境变量赋值、端口提取、长驻判定**逐字相同**，差异只有下面这些）

1. **只读判定多一道兜底**：project 在白名单＋否决表之后还有 `return !/\b(?:delete|exec|okdir|remove|write)\b/i.test(segment)`，system 没有。实测：

   | 命令 | system | project |
   | --- | --- | --- |
   | `cat write.log` | 只读 | 非只读 |
   | `grep -rn "delete" src` | 只读 | 非只读 |
   | `grep -rn remove src` | 只读 | 非只读 |
   | `ls exec` | 只读 | 非只读 |
   | `cat notes/okdir` | 只读 | 非只读 |

   一致性语料里没有这类命令，所以测试是绿的。影响：在 project 里这些命令要过 `prepareMutation` 修改授权、不能并发。system 的做法是逐参数否决（3489fa6 刚补齐 rg/git grep/ls-remote/env -S/time -o/sed 脚本/tree -R），精确；project 的兜底是历史启发式，误报多，也防不住新形态（新形态靠否决表）。
2. **sed 分支**：system `if (executable === 'sed') return isReadOnlySedInvocation(args)`；project `if (sed && !isReadOnlySedInvocation(args)) return false` 后继续走否决表和兜底——结论只在兜底正则上有差。
3. **并发缺省相反**：system 要 `parallel === true`（system:run 的 schema 有 `parallel` 字段，显式声明）；project 是 `parallel !== false`（project:run 的 schema 没有 `parallel` 字段 → 只读命令默认并发），外加一个等价的多余条件 `!plan.isDangerous`。实测 `{ command: 'ls' }`：system false / project true。
4. **确认文案**：system 在"递归删除""find -delete"两类理由后多一句"如果目标是一个项目或仓库目录（含 .git），未推送的提交和未提交的改动会一起没掉，无法找回。"（ADR 0004 的承诺），project 没有。
5. **命名与出口**：`isSystemShellCommandReadOnly` vs `isShellCommandReadOnly`；project 多三个别名；`SystemCommandExecutionPlan` vs `CommandExecutionPlan`（字段相同）。
6. **用法差异**（不在这两个文件里，但同一判定被用成两样）：system:run 对 `shouldRequestConfirmation`（危险或长驻）都确认，长驻是低风险可记忆确认；project:run 只在 `isDangerous` 时确认，`npm run dev` 这类长驻命令直接转后台、不问。

**健壮性**：system 更好（精确、无误报、文案承诺完整、已按治理规则写）。3489fa6 一次提交往两份各改约 249 行（主要是新增）、往一致性测试加 54 行——**每修一次要改三处**，这是抽包最直接的理由。

**能否合并**：完全可以。差异 1/4 统一裁决，差异 3 用选项参数化（先不改行为）。

**去处**：新包 `@velaros-ai/shell-command`。根入口纯函数、零 Node 依赖、渲染进程可载。不放 platform（ADR 0005 划出去了），不放 core（能力域语义），不放 agent（宿主 Termel/Workbench 不该为一个判定依赖 agent）。

**接口草案**
```ts
// packages/shell-command/src/contract/constants.ts —— 理由文案是对外承诺：测试按文字断言，宿主审批卡直接展示
export const ShellCommandDangerReasons = Object.freeze({
  /** 递归删除整个文件夹。 */
  recursiveRemove: '该命令会递归删除整个文件夹及其中全部内容，删除后无法撤销。',
  /** cmd.exe del /q。 */
  quietBulkDelete: '该命令以安静模式删除，目标是文件夹或通配符时会不经确认删掉其中全部文件，删除后无法撤销。',
  /** find … -delete。 */
  treeDelete: '该命令会在整个目录树里批量删除匹配到的文件，删除后无法撤销。',
  // gitDiscard / gitClean / gitStashDrop / gitForcePush / gitForceBranchDelete / gitForceWorktreeRemove /
  // gitRefDelete / gitReflogExpire / gitHistoryRewrite / remoteScript / destructive / privilegedMutation
} as const)
/** 长驻命令的确认理由。 */
export const ShellCommandLongRunningReason = '该命令看起来会启动长期驻留的服务或监听进程。'

// packages/shell-command/src/types/shell-command.ts（可移植）
/** 执行前分类的结果。 */
export interface ShellCommandPlan {
  isReadOnly: boolean
  shouldRequestConfirmation: boolean
  shouldStartInBackground: boolean
  /** 长驻的理由；不长驻为 null。 */
  reason: Nullable<string>
  isDangerous: boolean
  dangerousReason: Nullable<string>
  ports: number[]
}
/** 调度器问"能不能并发"时给的原始入参。 */
export interface ShellCommandConcurrencyInput { command?: unknown; background?: unknown; parallel?: unknown }

// packages/shell-command/src/impl/ShellCommandPolicy.ts
/**
 * 执行前给一条 shell 命令分类，实例是 shellCommandPolicy。两个空间的 run 工具、宿主审批界面、无人值守放行都用这一份。
 * 只读是白名单加整体否决，拿不准一律非只读；危险是黑名单，漏判只是少弹一次确认，真正的授权门在宿主的审批端口。
 */
export interface ShellCommandPolicyApi {
  /** 分类：只读、危险及理由、该不该转后台及理由、要不要确认、可能占用的端口。 */
  analyze(command: string): ShellCommandPlan
  /** 任何参数组合下都不写盘、不执行别的程序才算只读。 */
  isReadOnly(command: string): boolean
  /** 能否与别的调用并发：只读、不转后台、无需确认；optIn 为真时还要求入参显式 parallel: true。 */
  isParallelSafe(input: ShellCommandConcurrencyInput, options?: { optIn?: boolean }): boolean
  /** 危险或长驻命令的确认文案：命令、理由、递归删除时的仓库提醒、是否后台、可能的端口。 */
  confirmationMessage(command: string, plan: ShellCommandPlan, scopeLabel: string, willRunInBackground: boolean): string
}
export const shellCommandPolicy: ShellCommandPolicyApi
```

**迁移步骤**
1. 按治理标准建包（contract/types/impl/utils/exports、MODULE.md 十节、spec），`utils/command-policy.ts` 取 system 版（已合规）；project 的兜底正则删掉（需拍板，§5.6-4）。
2. system `spec/acceptance.test.ts` 的 INV-2、INV-3（含 3489fa6 新增用例）与 INV-18（文字档）连同 `command-danger-parity.test.ts` 的四组语料，搬成新包的验收——语料是这条规则的资产，不是"一致性"资产。system `spec/invariants.md` 把 INV-2/3/18 标"已移到 @velaros-ai/shell-command"（照 INV-1 的先例）。
3. system：`SystemExecutionOperations` 构造参数改收 `ShellCommandPolicyApi`；`SystemTools.ts` 的 `isConcurrencySafe` 改 `shellCommandPolicy.isParallelSafe(input, { optIn: true })`；删 `utils/command-policy.ts`、`impl/SystemCommandPolicy.ts`、`types/commands.ts` 里的 `SystemCommandExecutionPlan`/`ShellInvocation`；根入口不再出 `systemCommandPolicy`（治理规则不许转出别包的值，要保留只能留一个委托类——建议直接删，干净切断）。
4. project：`impl/operations/ProjectExecutionOperations.ts` 与 `ProjectTools.ts` 改用新包；删 `utils/command-policy.ts`；`./execution` 不再 `export *`，三个别名与 `CommandExecutionPlan` 删掉。
5. 宿主按 §2 的 6 处 import 迁移（`analyzeCommandExecution`→`shellCommandPolicy.analyze`、`isShellCommandLikelyMutating(x)`→`!shellCommandPolicy.isReadOnly(x)`、`buildBackgroundCommandConfirmationMessage`→`shellCommandPolicy.confirmationMessage`、`CommandExecutionPlan`→`ShellCommandPlan`）。

**测试**：删 `tests/capabilities/command-danger-parity.test.ts`（166）；project `test/approval-context.test.ts` 前 5 个纯判定用例（约 170 行）删，保留"危险项目审批带精确命令与目录""无宿主作用域时拒绝提权审批"两个行为用例；system acceptance 的 INV-4（system:run 的审批形状）留；`tests/capabilities/tool-operation-approval.test.ts` 留（它守的是两个工具的审批身份）。新包验收补上表 5 条语料。

---

### 3.2 审批请求与确认文案

**位置**
- 危险命令审批请求（同形 3 处）：system `impl/SystemExecutionOperations.ts::run`；project `impl/operations/ProjectExecutionOperations.ts::run` 与 `::sandbox` 的 `run` 分支。三处都是
  `createManualApprovalOptions({ approvalRisk: 'high', riskScope: '<空间>-command:dangerous', operation: { key: createApprovalOperationKey('shell-command', { command: command.trim(), cwd, background }), label: command, target: cwd } })`，文案来自 `buildBackgroundCommandConfirmationMessage`。
- 沙箱落回审批请求（同形 2 处）：system `SystemExecutionOperations.sandbox`、project `ProjectExecutionOperations.sandbox`，`createApprovalOperationKey('sandbox-apply', { sandboxId, created, modified, deleted })`，riskScope `system-sandbox:apply` / `project-sandbox:apply`。文案见 §3.3。
- 只在一边：system `utils/file-safety.ts::confirmSensitiveSystemMutation`（`system-mutation:sensitive-path`）、`confirmCredentialAccess`（`system-read:credential`）；project `impl/operations/ProjectApprovalBridge.ts::installProjectApprovalProvider`（`project:<risk>:<action>`，kind `project-operation`）——不重复。

**异同**
1. riskScope 前缀不同（有意：各空间的记忆范围）。
2. **被拒语义不同**：system 用 `awaitConfirmation`，被拒抛错（`EXECUTION_DENIED`）；project 用 `awaitConfirmationDecision`，被拒返回 `{ approved: false, skipped: true, message }`。`tool-operation-approval.test.ts` 把两种都钉住了。
3. 长驻命令：system 发 `{ approvalRisk: 'low' }` 的体验型确认，project 不问。
4. 操作身份（`operation.key`）必须两边一致——`ToolConfirmationDecisionOptions.operation` 的注释写明"跨工具入口应使用相同 key"，否则用户在 system:run 拒绝过的 `rm -rf ./dist` 换 project:run 就能再问/绕过。现在靠三处手写同一个对象字面量＋仓库层测试守着。

**能否合并**：请求构造参数化后可合并；拒绝语义、riskScope 留给空间。

**去处**：shell-command 的 `./approval` 子入口（peer 依赖 `@velaros-ai/agent`，只用 `tool-contract`；根入口保持零依赖）。落回审批请求随 rehearsal-sandbox（§3.3）。

**接口草案**
```ts
// packages/shell-command/src/impl/ShellCommandApproval.ts（./approval 入口）
/** 危险与长驻命令的审批请求，实例是 shellCommandApproval。只出"请求"，被拒怎么办由空间自己决定。 */
export interface ShellCommandApprovalApi {
  /** 危险命令：文案 + 高风险手动确认（不可记忆）+ 跨工具共享的操作身份（命令去首尾空白、cwd、前后台）。riskScope 由空间给。 */
  dangerous(input: { command: string; plan: ShellCommandPlan; cwd: string; background: boolean; scopeLabel: string; riskScope: string }): { message: string; options: ToolConfirmationDecisionOptions }
  /** 长驻命令：低风险、可按类记忆的体验型确认。 */
  longRunning(input: { command: string; plan: ShellCommandPlan; scopeLabel: string; background: boolean }): { message: string; options: ToolConfirmationDecisionOptions }
  /** 危险命令的操作身份，宿主审批界面对齐 key 用。 */
  operation(input: { command: string; cwd: string; background: boolean }): NonNullable<ToolConfirmationDecisionOptions['operation']>
}
export const shellCommandApproval: ShellCommandApprovalApi
```

**迁移**：三处调用改成 `const { message, options } = shellCommandApproval.dangerous({...})`，再按各自语义 `awaitConfirmation` / `awaitConfirmationDecision`。**测试**：`tool-operation-approval.test.ts` 不变（行为不变）；新包加"同命令同 cwd 同前后台 → 同 key"用例；system acceptance INV-4 不变。

---

### 3.3 演练沙箱

**位置**
- system：工具 `impl/SystemTools.ts::sandboxTool`（schema 7 字段，数字引 `SystemSandboxLimits`）；执行 `impl/SystemExecutionOperations.ts::sandbox`；数据 `types/system.ts` 的"演练沙箱"节（`SystemSandboxIgnoredMode`…`SystemSandboxDiscardResult` 共 9 个类型）；工作类型 `types/sandbox.ts`；上限 `contract/constants.ts::SystemSandboxLimits`；规则 `utils/sandbox.ts::selectSandboxChanges`、`buildSandboxApplyConfirmationMessage`、`sandboxApplyConflict`；引擎 `utils/sandbox.ts`（镜像/扫描/差量/落回/剪推送/删除守卫）＋ `impl/SystemSandboxes.ts`；宿主端口 `SystemToolSystemApi.createSandbox/diffSandbox/applySandbox/discardSandbox`；错误码 `SYSTEM_SANDBOX_CONFLICT`。
- project：工具 `impl/ProjectTools.ts::sandboxTool`（schema 10 字段，数字写死）；执行 `impl/operations/ProjectExecutionOperations.ts::sandbox`；规则 `utils/agent/sandbox.ts::requireSandboxPort`、`resolveSourceInsideProject`、`selectSandboxChanges`、`sandboxApplyConfirmationMessage`；数据 `types/project.ts` 的"演练沙箱（与 @velaros-ai/system 的形状一致…）"节（10 个类型，多 `ProjectSandboxRunOptions`）；端口 `contract/requires.ts::ProjectSandboxPort`（多 `runInSandbox`）。
- 仓库层：`tests/capabilities/sandbox-contract-parity.test.ts`（55 行：11 条共享入参的裁决 + 3 种数据的双向赋值）。

**异同**
1. **入参 schema**：7 个共享字段同名同约束；system 的数字引常量，project 写死 64/500/2000（沙箱）与 600_000/50_000（run）——与 system 常量同值，靠一致性测试守。project 多 `run` 动作及 `command/timeoutMs/maxOutputChars`（项目工具出不了项目边界，ADR 0006 第二阶段的设计）。project 的 sandbox 是 role `edit`，被 `defineProjectTool` 自动套了入参复用信封；system:sandbox 没套。
2. **筛选**：`selectSandboxChanges` 两边逐字相同。
3. **落回确认文案**：同结构。system 多一行"其中是系统敏感路径或凭证文件的：…"，结尾"删除和覆盖无法撤销"；project 结尾"删除和覆盖不经过 project:change 的撤销账本"，标题"落回项目 {source}"；预览条数 system 取 `SystemTuning.sandbox.confirmationPreviewItems`（20），project 写死 20。
4. **流程**：两边都是"先 `diffSandbox({ maxFiles: 2000 })` 算选择 → 确认 → `applySandbox`"。project 在工具层查 unknown 路径（system 在引擎 `SystemSandboxes.apply` 里查，结果等价）、再过 `prepareMutation`；system 列敏感路径。被拒：system 抛、project 返回 skipped。create：project 把 source 限在项目内并在工具层补默认值 `network: false, ignored: 'link'`，system 交给宿主 `LocalSystemKernel.createSandbox` 补。只落部分路径时 system 在回执加 note，project 不加。
5. **数据形状**：9 个类型字段逐一相同（system 的 CreateOptions 三字段可选，project 的 CreateRequest 三字段必填——工具已补默认值）；一致性测试只核了 Record/Diff/ApplyResult 三种。
6. **共同缺陷（安全相关）**：确认用的差量是截断的（新增、修改每列 ≤2000 条），而引擎落回时按 `SystemSandboxLimits.files`（20 万）重算并**全部写入**。超过 2000 个新增或修改时，确认卡上的条数偏少；system 的敏感路径筛查也只看了前 2000 条，后面的敏感文件不会出现在确认卡上。
7. **命名冲突**：project 里还有一个无关的 `ProjectSandboxPort`（`types/sandbox.ts`，工作区 overlay：`mode/current/createChildSandbox/writeBackSandbox`），经 `./changes` 与根入口出包；演练沙箱的 `ProjectSandboxPort` 在 `contract/requires.ts`，没有自己的名字出口，只作为 `ProjectToolApi.sandbox` 的类型经 `./agent` 可达。Desktop `ToolContextTypes.ts` 从根入口拿到的是 overlay 那个——Desktop 接 `ProjectToolApi.sandbox` 时两者会撞。

**能否合并**：数据契约、上限、筛选、确认文案、落回审批请求、冲突失败——完全相同或参数化后可合并；工具 schema 与说明——形状相同、文案按空间不同（system 提 `system:edit/system:run`、支持 `~`；project 提 `project:file`、相对项目根），按治理文档留各空间，但数字引公共上限；执行流程——审批语义不同，留各自 Operations。**引擎只 system 有，不是重复**；二期可整体搬进公共包，让"镜像/差量/落回/删除守卫"跟它的不变量（INV-24/25/26）住在一起，system 只留"镜像里的命令钉约束"（INV-23）。

**去处**：新包 `@velaros-ai/rehearsal-sandbox`。

**接口草案**
```ts
// contract/constants.ts
/** 沙箱的公开上限；两个空间的工具说明与 schema 都引它。 */
export const RehearsalSandboxLimits = Object.freeze({
  /** 一个内核同时最多几个沙箱。 */ sandboxes: 5,
  /** 源目录最多多少个文件。 */ files: 200_000,
  /** 源目录最多多少字节。 */ bytes: 2 * 1024 * 1024 * 1024,
  /** diff 两列缺省各列多少条。 */ diffFiles: 200,
  /** diff 两列最多各列多少条。 */ diffFilesMax: 2000,
  /** 一次 diff 最多附几个文本差量。 */ textDiffs: 200,
  /** 单个文本差量最多多少字符。 */ diffFileChars: 200_000,
  /** 一次 diff 的文本差量总字符。 */ diffTotalChars: 2_000_000,
  /** apply 一次最多指定多少路径。 */ applyPaths: 500,
  /** 沙箱 id 最长多少字符。 */ idChars: 64,
})
/** 落回整批不落时的错误原因（system 现为 SYSTEM_SANDBOX_CONFLICT，是否改名需拍板）。 */
export const RehearsalSandboxErrorCodes = Object.freeze({ applyConflict: 'SANDBOX_APPLY_CONFLICT' } as const)

// types/rehearsal-sandbox.ts（可移植）
export type SandboxIgnoredMode = 'link' | 'copy' | 'skip'
export interface SandboxCreateRequest { source: string; network: boolean; ignored: SandboxIgnoredMode }
export interface SandboxRecord { id: string; root: string; source: string; createdAt: number; network: boolean; ignored: SandboxIgnoredMode; fileCount: number; bytes: number; linkedDirectories: string[]; git: boolean }
export interface SandboxDiffOptions { sandboxId: string; maxFiles?: number }
export interface SandboxTextDiff { path: string; diff: string; truncated: boolean }
export interface SandboxDiff { sandboxId: string; source: string; created: string[]; modified: string[]; deleted: string[]; truncated: boolean; gitChanged: boolean; textDiffs: SandboxTextDiff[]; omittedDiffs: number; note?: string }
export interface SandboxApplyOptions { sandboxId: string; paths?: string[] }
export interface SandboxApplyResult { sandboxId: string; created: string[]; modified: string[]; deleted: string[]; skippedGit: boolean }
export interface SandboxDiscardResult { sandboxId: string; removed: boolean }
export interface SandboxSelection { created: string[]; modified: string[]; deleted: string[]; unknown: string[] }
export interface SandboxConflict { path: string; reason: 'changed' | 'missing' | 'appeared'; message: string }

// impl/RehearsalSandboxRules.ts
/** 演练沙箱落回前后的规则，实例是 rehearsalSandboxRules；两个空间的 sandbox 工具共用。 */
export interface RehearsalSandboxRulesApi {
  /** 按相对路径筛三列；不给就全部；给了但三列里都没有的放 unknown。 */
  select(diff: Pick<SandboxDiff, 'created' | 'modified' | 'deleted'>, paths: LooseOptional<readonly string[]>): SandboxSelection
  /** 落回确认文案：目标、三列条数与预览、差量是否截断（截断时写明"实际会落回更多"）、其中的敏感路径；scopeNote 是空间自己的一句（无法撤销 / 不经撤销账本）。 */
  applyConfirmation(input: { target: string; selection: SandboxSelection; truncated: boolean; sensitivePaths?: readonly string[]; scopeNote: string }): string
  /** 落回的审批请求：高风险手动确认 + 操作身份（sandbox-apply、id、三列条数）；riskScope 由空间给。 */
  applyApproval(input: { sandboxId: string; target: string; selection: SandboxSelection; riskScope: string }): ToolConfirmationDecisionOptions
  /** 落回整批不落的失败：not-applied，cause.details.conflicts 列出冲突（截到 ToolFailureLimits.listItems）。 */
  conflictFailure(conflicts: readonly SandboxConflict[]): AppError
}
export const rehearsalSandboxRules: RehearsalSandboxRulesApi

// 二期 impl/RehearsalSandboxStore.ts（Node）—— 现 system utils/sandbox.ts 的引擎
/** 沙箱登记与镜像引擎：建镜像、差量、落回、删除（只删基目录之下），不管进程约束。 */
export interface RehearsalSandboxStoreApi {
  create(source: string, options: { network: boolean; ignored: SandboxIgnoredMode; shouldSkip: (path: string, isDirectory: boolean) => Promise<boolean> }): Promise<SandboxRecord>
  diff(options: SandboxDiffOptions): Promise<SandboxDiff>
  apply(options: SandboxApplyOptions): Promise<SandboxApplyResult>
  discard(sandboxId: string): Promise<SandboxDiscardResult>
  list(): SandboxRecord[]
  /** cwd 落在哪个沙箱镜像根之内（内核重启后按清单重登记）；不在返回 null。 */
  locate(cwd: string): Promise<Nullable<{ record: SandboxRecord; temp: string }>>
}
```

**迁移步骤**
1. 先改名 project 的 overlay `ProjectSandboxPort`（如 `ProjectWorkspaceSandboxPort`），通知 Desktop。
2. 放宽可移植文件的 import 规则（§1-5）；system `types/system.ts` 与 project `types/project.ts` 的沙箱节改成 `import type` 公共包（或以别名 `SystemSandboxRecord = SandboxRecord` 保留旧名，破坏性与否由拍板定）。
3. 两边 Operations 改用 `rehearsalSandboxRules`；apply 前的计数与敏感筛查改用不截断的集合（修 §3.3-6）；schema 数字改引 `RehearsalSandboxLimits`。
4. 二期：引擎搬家，`SystemSandboxes` 只留"按镜像根发放受约束的执行器"。

**测试**：parity 测试删掉数据赋值部分，schema 裁决部分保留（工具 schema 仍各持一份）；system `test/sandbox.test.ts`、acceptance INV-24/25/26 在二期随引擎搬；project `test/project-sandbox.test.ts` 留；新增"新增 >2000 个文件时确认文案如实说明截断"用例（两个空间各一条）。

---

### 3.4 工具定义辅助（defineSystemTool / defineProjectTool；输入复用；严格解析）

**位置**：system `utils/tool.ts::defineSystemTool`（入参类型 `types/tool.ts::DefineSystemToolInput`）；project `utils/tool.ts::defineProjectTool`（原 `impl/tools/shared.ts`）。

**异同**
1. **类别**：system 按工具名查 `SystemToolCategoryByName`，工具的类别与 mod 清单同源；project 每个工具手写 `category`，mod 清单另按集合成员推（`ProjectCategoryTools`），两个来源可以不一致。
2. **入参复用**：system 显式 `inputReuse: true`（只有 edit）；project 按 role 自动——所有 `edit` 角色（file/edit/change/sandbox）都套 `withToolInputReuse`。
3. **execute 包装**：system 不包——入参复用由 Agent 执行器在 execute 前还原（`packages/agent/src/tools/Executor.ts` 537 行调 `resolveToolInputReuse`）；project 在 execute 里又 `resolveToolInputReuse` + `schema.parse` 一遍（执行器路径下是空操作 + 二次解析；内核直调路径下需要 `sessionId`/`contextPayloadStore`，拿不到就报 UNAVAILABLE）。
4. **描述**：project 给 suitable/forbidden/protocol/usage/notes 塞通用占位句（"需要完成该工具职责所描述的项目操作。"等 5 句），system 按 ADR 0004 只写真有内容的节（agent 0.6.30 已把这四节改成可选）→ project 每个工具的提示词里有空话。
5. project 有 `inputContractVersion`（缺省 `ProjectToolContract.inputVersion`=2），system 没有。
6. **类型**：system 完整继承 `DefineToolRuntimeSpecInput`，返回 `VelaTool<TInput>`；project 手列字段，返回 `VelaTool<any>`，丢类型。
7. **执行门**：project 旧版在定义器里给 inspect 工具套读门，这次搬家改成执行类自己套，是对的。**合并时别把门放回定义器**：`ProjectExecutionGate.drain` 在队首是写者且有读者时停止放行，外层读门持有＋内层读者排在写者之后＝死锁。

**健壮性**：system 更好（类别单源、类型完整、不重复还原）。**能否合并**：参数化后可合并。**去处**：`@velaros-ai/agent/tool-contract`（它已拥有 `defineToolRuntimeSpec`、`withToolInputReuse`、`resolveToolInputReuse`）。

**接口草案**
```ts
// @velaros-ai/agent/tool-contract
/** 空间工具的定义入参：运行时规格去掉类别（按工具名查表）与契约版本（由定义器统一），外加是否支持入参复用。 */
export type DefineSpaceToolInput<TInput extends Record<string, unknown>, TContext, TName extends string> =
  Omit<DefineToolRuntimeSpecInput<TInput, TContext, unknown, ToolPermission>, 'category' | 'name' | 'inputContractVersion'> & {
    /** 工具名；类别按它查表。 */
    name: TName
    /** 失败后入参可复用：schema 套复用信封，执行器在 execute 前还原；不包 execute。 */
    inputReuse?: boolean
  }

/** 造一个空间专用的工具定义函数：一个工具只属于一个类别（查表），入参契约版本统一，声明 inputReuse 的套信封。 */
export function createSpaceToolDefiner<TName extends string, TContext>(options: {
  categoryByName: Readonly<Record<TName, ToolCategoryId>>
  inputContractVersion?: number
}): <TInput extends Record<string, unknown>>(
  input: DefineSpaceToolInput<TInput, TContext, TName>,
) => ToolContractRuntimeSpec<TInput, TContext, unknown, ToolPermission>
```

**迁移**：system `SystemTools.ts` 顶部 `const defineSystemTool = createSpaceToolDefiner<SystemToolName, SystemToolContext>({ categoryByName: SystemToolCategoryByName })`（治理登记的 toolDefiner 仍叫 defineSystemTool、只在工具文件里调——满足门禁），删 `utils/tool.ts` 的定义器与 `types/tool.ts`。project：`contract/constants.ts` 加 `ProjectToolCategoryByName`（manifest 同源），同法生成 `defineProjectTool`，四个编辑类工具显式 `inputReuse: true`，去占位文案（提示词变更，需拍板，要重算 guidance 审核指纹），删 execute 包装。

**测试**：system acceptance INV-9 照旧；project `test/agent-tool-contract.test.ts`、`project-tool-surface.test.ts`、`project-guidance-drift.test.ts` 随描述改；agent 新增定义器单测（查表、信封、不包 execute）；`check:capabilities-schemas` 冻结的 schema 不变（只要不动字段）。

---

### 3.5 作为内核模块挂载时的可调用操作表

**位置**：system `utils/tool.ts::parseToolInput` + `createSystemCallableOperations`，装配 `SystemTools.ts::createSystemKernelModule`；project `utils/tool.ts::parseProjectToolInput` + `createProjectCallableOperations` + `projectCapabilityError`/`invalidProjectInput`（原 `exports/kernel.ts::createProjectOperations`），装配 `ProjectTools.ts::createProjectKernelModule`；**第三份** `packages/office/src/kernel-module.ts::parseToolInput` + `createOfficeCallableOperations`（多一个 `isCallableOfficeTool` 结构守卫）。

**异同**
1. **顺序**：system/office 先严格解析入参，再解析宿主上下文（system INV-7："未知字段在解析宿主上下文之前就被拒绝"）；project 先 `resolveContext`、核可用，再在 try 里解析入参——坏入参也会触发宿主上下文解析。**project 自己的注释写的是"先严格解析入参、再向宿主解析上下文"，与代码相反。**
2. 没给解析器：system/office 返回空表（只登记、不可调用）；project 类型上必填。
3. 错误：project 把 `ProjectError` 翻成 `AppError(reason, message, error, { projectError })`，入参错误也包成 `ProjectError('INVALID_INPUT')`；system/office 直接 `AppError('VALIDATION')`。
4. 文案：system/project 中文，office 英文。
5. 形状：office 对非工具值 fail-fast，system/project 用 `as VelaTool` 强转。

**能否合并**：参数化后完全可合并（三份）。**去处**：`@velaros-ai/agent/tool-contract`（工具规格是 agent 的概念；kernel 契约不许依赖 agent；agent 已依赖 kernel；tool-contract 入口要浏览器安全，这几个函数只用 zod、AppError 和 kernel ABI 类型，满足）。

**接口草案**
```ts
/** 按作用域解析一次工具上下文（不含 abortSignal，由调用方补）。 */
export type ToolContextResolver<TContext> = (scope: LooseOptional<ScopeRef>, signal: AbortSignal) => Omit<TContext, 'abortSignal'> | Promise<Omit<TContext, 'abortSignal'>>

export interface ToolCallableOperationsOptions {
  /** 报错与缺省 reason 里称呼这组能力的中文名，如「系统能力」「项目能力」「办公能力」。 */
  label: string
  /** 工具抛出的领域错误怎么翻成 AppError；不给就原样抛。 */
  mapError?: (error: unknown) => unknown
}

/** 用工具的 schema 严格解析线上入参：不是对象直接拒；对象 schema 拒收未知字段；报错带字段路径。 */
export function parseToolWireInput(tool: { schema: z.ZodType }, input: unknown, label: string): Record<string, unknown>

/** 工具集合 → 内核可调用操作表：先严格解析入参，再解析上下文、核可用、核取消，最后执行；没给解析器就不登记；非工具值当场报 INVARIANT。 */
export function createToolCallableOperations<TContext extends { abortSignal: AbortSignal }>(
  tools: Readonly<Record<string, ToolContractRuntimeSpec<any, TContext, unknown, ToolPermission>>>,
  resolveContext: LooseOptional<ToolContextResolver<TContext>>,
  options: ToolCallableOperationsOptions,
): Readonly<Record<string, KernelCallableCapabilityOperation>>
```
（P3 可再包一层 `defineToolCapabilityModule({ id, version, token, tools, permissions, resolveContext, label, mapError })`，三份 `activate` 样板也一样。）

**迁移/测试**：三处替换成一行调用（project 传 `mapError`）；system acceptance INV-7 照旧；project `test/kernel-module.test.ts` 加"未知字段在解析上下文之前被拒"；agent 新增单测；office 测试不变。

---

### 3.6 文本文件：编码识别 / BOM / UTF-16 / 二进制 / 原子写入

**位置**
- system：`utils/text-file.ts`——`detectSystemTextEncoding`、`detectUtf16NoBom`、`isBinaryBuffer`、`decodeSystemTextBuffer`、`encodeSystemTextContent`、`decodeUtf16Be`/`encodeUtf16Be`、`readSystemTextFile`、`readRawSystemFileBuffer`、`readFileHead`、`readBoundedFile`、`assertRegularFile`、`fileVersionOf`、`detectMediaType`、`clampTextRange`、`sliceTextChars`；`utils/fs.ts::writeSystemFileAtomically`（包 `@velaros-ai/core/utils/FilePersistence::writeFileAtomically`）；`utils/text.ts::adaptReplacementLineEndings`；`SystemFileOperations.planOne` 里"解码再编码必须等于原字节"。
- project：`utils/text.ts`——`ProjectTextEncodingProbe`、`detectProjectTextEncoding`、`detectUtf16NoBom`、`decodeProjectTextBuffer`、`createProjectTextDecoder`、`encodeProjectTextBuffer`、`assertWellFormedProjectText`、`isProbablyBinary`、`normalizeProjectInputText`、`resolveLineEndingAwareTextMatch`、`adaptTextToContentLineEndings`；`utils/files/atomic-writer.ts::atomicWriteProjectBytes/atomicWriteProjectText`；`utils/files/private-byte-io.ts::readBoundedProjectBytes`；`utils/files/text-stream.ts::readProjectTextChunks/readProjectTextFile`；`utils/transactions/byte-codec.ts::encodePreservingProjectBytes/bytesEqual`；`utils/files/file-reader.ts::detectBinaryByPrefix`。

**异同**（实测）

| 情形 | system | project |
| --- | --- | --- |
| GBK/GB18030 文件（"你好"） | 按 UTF-8 解，得 `���`：system:read 给模型乱码且不报错；system:edit 的 edits 被回编检查拦下拒改，但 newText 整份写入没有回编检查，会把文件静默改存成 UTF-8 | 识别为 gb18030，正确读写；未改片段保留原字节（同字异码不被改写） |
| 非法 UTF-8（`61 FF 62`） | 解成 `a�b`，read 成功 | 判不可无损解码（二进制） |
| 写入含孤立代理项的文本 | `Buffer.from(…,'utf-8')` 静默写成 `EF BF BD` | 拒绝并给下一步 |
| 不足 16 字节的无 BOM UTF-16（`"hi\n"`） | 判二进制报错 | 识别 utf16le-nobom（只认 ASCII 交错） |
| BOM 之后的字节 | 不校验 | fatal 解码器校验 |
| 二进制判定 | 前 8 KB 有 NUL | 编码探测失败（NUL，或所有候选解码器失败） |
| 大文件识别 | 只看头 8 KB | 流式整文件探测，常量内存 |
| 原子写入 | 临时名 `<file>.<pid>.<uuid>.tmp`；`writeFile(mode)` 受 umask 影响（原 0664 在 umask 022 下变 0644）；不 fsync；不查硬链接（写多硬链接文件会悄悄拆链）；符号链接由调用方先解开 | 同目录 `.velaros-write-<uuid>.tmp`，`open wx` + `chmod` 精确恢复权限位；fsync 文件与目录；拒绝多硬链接；符号链接写到目标；可选 expected 字节在 rename 前再核一次 |
| 有界读 | `stat` 后整读（读时文件变大照读） | 句柄上读 size+1 字节，读时变长报冲突 |
| 换行适配 | 先原样找，找不到再试 CRLF | 条件满足时先试 CRLF，再原样；返回匹配计数 |
| 编码集合 | 6 种 | 7 种（+gb18030），另有 recode（改磁盘编码/BOM/换行） |

**健壮性**：project 全面更好。system 独有且应留下的：`detectMediaType`（图片魔数，system:view 用）、`clampTextRange`/`sliceTextChars`（按字符取段）、`fileVersionOf`（sha1 前 12 位，是 system:read/edit 对外的版本号）。project 的行/revision 也各自保留。

**能否合并**：识别/解码/编码/字节保留编码/原子写/有界读/流式读——同一件事，参数化后可合并（以 project 实现为底）；版本号、媒体类型、取段语义——各空间自己的，不合。

**去处**：新包 `@velaros-ai/text-files`（依赖 core + iconv-lite；进不了 core：core 零依赖，GB18030 编码要 iconv-lite）。

**接口草案**
```ts
// types/text-files.ts（可移植）
export type TextEncoding = 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16be' | 'utf16le-nobom' | 'utf16be-nobom' | 'gb18030'
export interface DecodedText { content: string; encoding: TextEncoding }
/** 写入前要核对的原字节：文件应不存在（exists: false），或应恰好是这些字节。 */
export interface ExpectedBytes { exists: boolean; bytes?: Uint8Array }

// contract/constants.ts
export const TextFileErrorCodes = Object.freeze({
  /** 不是可无损解码的文本。 */ notText: 'TEXT_FILE_NOT_TEXT',
  /** 目标编码无法无损表示，或文本含孤立代理项。 */ lossy: 'TEXT_FILE_LOSSY',
  /** 写入前发现文件被外部改过。 */ externalEdit: 'TEXT_FILE_EXTERNAL_EDIT',
  /** 不是普通文件。 */ notRegular: 'TEXT_FILE_NOT_REGULAR',
  /** 多硬链接文件，原子替换会拆链。 */ hardLinked: 'TEXT_FILE_HARD_LINKED',
} as const)

// impl/TextCodec.ts
/** 文本编解码，实例是 textCodec。 */
export interface TextCodecApi {
  /** 识别编码：BOM → 无 BOM 的 UTF-16（按 NUL 分布；极短文本只认 ASCII 交错）→ 有 NUL 判二进制 → 严格 UTF-8 → GB18030；都不行返回 null。partial 为真表示只给了开头，末尾截断的多字节字符不算错。 */
  detect(bytes: Uint8Array, options?: { partial?: boolean }): Nullable<TextEncoding>
  /** 识别后解码；认不出返回 null。 */
  decode(bytes: Uint8Array): Nullable<DecodedText>
  /** 编成字节并带上需要的 BOM；文本含孤立代理项或目标编码无法无损表示时抛 lossy。 */
  encode(content: string, encoding: TextEncoding): Uint8Array
  /** 改了一部分文本后重编码：GB18030 下未改片段沿用原字节，其余编码等同 encode。 */
  encodePreserving(original: Uint8Array, before: string, after: string, encoding: TextEncoding): Uint8Array
  /** 流式识别：分块推入，结束时给出编码。 */
  createProbe(): { push(bytes: Uint8Array): void; finish(partial?: boolean): Nullable<TextEncoding> }
  /** 文件用 CRLF、给的文本用 LF 时把匹配文本与替换文本都换成 CRLF，并给出唯一性计数。 */
  matchLineEndingAware(content: string, needle: string, replacement?: string): { index: number; count: number; matchedText: string; replacementText?: string }
}
export const textCodec: TextCodecApi

// impl/TextFileIo.ts（Node）
/** 文本文件的原子写入与有界读取，实例是 textFileIo。 */
export interface TextFileIoApi {
  /** 原子写字节：同目录临时文件 → 精确恢复权限位 → fsync → rename → fsync 目录；符号链接写到它指向的普通文件；多硬链接拒绝；给了 expected 在替换前再核一次。 */
  writeBytes(path: string, bytes: Uint8Array, options?: { mode?: number; expected?: ExpectedBytes }): Promise<void>
  /** 按现有文件的编码写文本（新文件用 fallbackEncoding）；现有文件不能无损解码时拒绝。 */
  writeText(path: string, content: string, options?: { fallbackEncoding?: TextEncoding; mode?: number; expected?: ExpectedBytes }): Promise<void>
  /** 有界读：不是普通文件或超上限报错；读的过程中文件变长报 externalEdit；不存在返回 null。 */
  readBounded(path: string, maxBytes: number): Promise<Nullable<Uint8Array>>
  /** 只读开头若干字节。 */
  readHead(path: string, bytes: number): Promise<Uint8Array>
  /** 流式读完整文本：先整文件识别编码，再用严格解码器逐块解。 */
  readTextChunks(path: string, encoding?: TextEncoding): AsyncGenerator<{ content: string; byteOffset: number }>
}
export const textFileIo: TextFileIoApi
```
错误用公共包自己的码放在 `cause.reason`；project 在边界翻成 `ProjectError`（`NOT_SUPPORTED`/`CONFLICT_WITH_EXTERNAL_EDIT`/`INVALID_INPUT`），system 翻成现有 `VALIDATION/PERMISSION/NOT_FOUND`。

**迁移步骤**：1）建包，搬 project `text.ts` 编码部分、`atomic-writer`、`private-byte-io`、`text-stream`、`byte-codec` 的字节保留编码；2）project 改 import 并加边界翻译；3）system `text-file.ts` 只留取段/媒体类型/版本号，编码全换新包，`writeSystemFileAtomically` 换 `textFileIo.writeBytes`（保留 PERMISSION 翻译），`readBoundedFile` 换 `readBounded`。**system 行为变更需拍板**（§5.6-6）：GBK 能读能改；非法字节不再"成功"；孤立代理拒写；INV-21（文本改动无损）语义不变、更强。

**测试**：project `test/encoding-atomic-write.test.ts`（65）、`text-stream.test.ts`（164）、`transaction-bytes.test.ts` 与 `project-file-recode.test.ts` 的编解码部分 → 新包 spec；system `test/system.test.ts` 的"decodes UTF-16 text…""adapts a replacement to CRLF files""edit refuses what it cannot do losslessly…"留作集成并按新行为改断言；新包补 GBK、非法字节、孤立代理、短 UTF-16、硬链接、umask 用例。

---

### 3.7 gitignore 解析与 glob 匹配、默认跳过的目录

**位置**
- system：`utils/search.ts`——`readIgnoreLines`、`parseGitIgnoreRule`、`matchesGitIgnoreRule`、`matchesGitIgnoreSegment`、`gitIgnoreSegmentPatternToRegex`、`directoriesBetween`、`readGitIgnoreRulesBetween`、`findSystemSearchRepoRoot`、`SystemSearchSkippedDirectoryNames` + `shouldSkipSystemSearchEntry`、`MacosTccProtectedSearchDirectoryNames` + `shouldSkipSystemSearchProtectedDirectory`；`impl/GitIgnoreSystemSearchPolicy.ts`（被 `SystemGlobalSearch` 与 **`SystemSandboxes.create`（沙箱镜像）** 用）。
- project：`utils/gitignore.ts::parseGitignore/readGitignoreRules/readAncestorGitignoreRules/isGitignored`；`utils/glob.ts::matchesAny/globToRegExp`；`utils/matcher-cache.ts::createMatcherCache`；`utils/files/file-listing.ts` 的 `git check-ignore --no-index --stdin -z` 批量判定 + 本地规则回退；`utils/files/visibility.ts::ProjectDiscoverySkippedDirectoryNames/shouldSkipProjectDiscoveryDirectory/ProjectExcludedDirectoryNames/ProjectModelRestrictedDirectoryNames`（`./files` 出包）。

**异同**（实测）

| 规则 | 路径 | git 的结论 | system | project |
| --- | --- | --- | --- | --- |
| `/build*` | `build-output/` | 忽略 | **不忽略**（锚定规则逐段精确比较，不认通配） | 忽略 |
| `docs/*.md` | `docs/a.md` | 忽略 | **不忽略** | 忽略 |
| `**/tmp` | `a/b/tmp/` | 忽略 | **不忽略**（不认 `**`） | 忽略 |
| `a/**/b` | `a/x/y/b/` | 忽略 | **不忽略** | 忽略 |
| `[Dd]ist` | `Dist/` | 忽略 | **不忽略**（字符类被当字面） | 忽略 |
| `foo\ `（转义尾空格） | `foo ` | 忽略 | **不忽略**（trimEnd 吃掉） | 忽略 |
| `build/` | 名为 build 的**文件** | 不忽略 | 不忽略（有 directoryOnly） | **忽略**（去掉末尾 `/`，丢了"只匹配目录"） |

另：project 优先用 git 自己的引擎（覆盖"父目录被忽略则子项不能取反捞回"等边界），git 不可用才本地判；system 只有本地解析器。picomatch 的 `{a,b}` 不是 gitignore 语法，project 会多匹配（小概率）。沙箱镜像用的是 system 的弱解析器：`/build*` 这类锚定通配忽略的目录会被整份**复制**进镜像而不是链接过去——慢、占空间，而且复制过来的目录可写，"写忽略目录会被约束拒绝"的承诺对它失效。

跳过名单：`ProjectDiscoverySkippedDirectoryNames` 与 `SystemSearchSkippedDirectoryNames` **23 项逐项相同**；判定规则不同：project 另外跳过全部隐藏目录（allowlist 写的是 `.xcodeproj/.xcworkspace`，而 `Foo.xcodeproj` 本来就不以点开头，这个 allowlist 实际不起作用），system 按 `includeHidden` 开关；macOS TCC 受保护目录只 system 有（系统空间特有，留 system）。

**健壮性**：project 的 glob/gitignore 引擎更好；directoryOnly 只有 system 做对了。**能否合并**：参数化后可合并（以 project 为底，补 directoryOnly，git check-ignore 由注入的执行口提供）。**去处**：新包 `@velaros-ai/path-rules`（依赖 core + picomatch）。

**接口草案**
```ts
// types/path-rules.ts
export interface GitignoreRule { negated: boolean; directoryOnly: boolean; patterns: string[] }
// contract/requires.ts
/** 批量问 git 哪些相对路径被忽略（git check-ignore --no-index --stdin -z）；调用方注入执行口，拿不到 git 返回 null，由本地规则兜底。 */
export type GitCheckIgnoreRunner = (root: string, relativePaths: readonly string[]) => Promise<Nullable<ReadonlySet<string>>>
// contract/constants.ts
/** 遍历与搜索默认跳过的目录名（版本库、依赖、虚拟环境、构建产物、缓存、编辑器配置）。 */
export const DiscoverySkippedDirectoryNames: readonly string[] = Object.freeze([/* 现有 23 项 */])

// impl/PathMatcher.ts
/** glob 匹配，实例是 pathMatcher：以 / 结尾按目录前缀；不含通配按精确或目录前缀；其余走 picomatch（dot，区分大小写），编译结果 LRU 缓存 256 条。 */
export interface PathMatcherApi { matchesAny(path: string, patterns?: readonly string[]): boolean }
export const pathMatcher: PathMatcherApi

// impl/GitignoreRules.ts
/** .gitignore 的解析与判定，实例是 gitignoreRules：取反、锚定、目录限定、**、字符类、转义都认；后面的规则覆盖前面的。 */
export interface GitignoreRulesApi {
  parse(content: string, baseRel?: string): GitignoreRule[]
  readRules(rootAbs: string, dirRel: string): Promise<GitignoreRule[]>
  /** 从根到 dirRel 父目录逐级累积的规则（不含 dirRel 自己的）。 */
  readAncestorRules(rootAbs: string, dirRel: string): Promise<GitignoreRule[]>
  isIgnored(pathRel: string, rules: readonly GitignoreRule[], isDirectory: boolean): boolean
}
export const gitignoreRules: GitignoreRulesApi

// impl/IgnorePolicy.ts —— system 的 GitIgnoreSystemSearchPolicy 与 project 列目录里"git 优先、本地兜底"合成一个
/** 遍历时某个条目要不要跳过：找到所在仓库，按各级 .gitignore（有 git 就问 git）判；不在仓库、根本身被忽略、unrestricted 时什么都不跳。 */
export interface IgnorePolicyApi {
  shouldSkip(absolutePath: string, isDirectory: boolean): Promise<boolean>
  /** 一批条目一起判（一次 git 调用）。 */
  ignoredAmong(entries: ReadonlyArray<{ absolutePath: string; isDirectory: boolean }>): Promise<ReadonlySet<string>>
}
export function createIgnorePolicy(root: string, options?: { unrestricted?: boolean; gitCheckIgnore?: GitCheckIgnoreRunner }): IgnorePolicyApi
```

**迁移/测试**：system `SystemGlobalSearch`、`SystemSandboxes` 换 `createIgnorePolicy`，删 search.ts 的 gitignore 部分与 `GitIgnoreSystemSearchPolicy.ts`（layers 登记同步删）；project `file-listing.ts`、`FileStore`、策略 glob 换新包。system `test/system-search-visibility.test.ts`（66）迁；project `test/glob.test.ts`（71）、`visibility-policy.test.mjs`（27）、`file-store-gitignore.test.ts`（135）中纯规则部分迁；新包加上表 7 条语料。

---

### 3.8 路径包含判断与真实路径

**位置**
- system：`utils/file-safety.ts::isPathInsideRoot`（经 `comparisonPath`，win32/darwin 小写比较）；`utils/search.ts::isInsidePath`（区分大小写，第二份）；`utils/sandbox.ts::assertInsideSandboxBase` 与 `SystemSandboxes.create/runnerFor` 里的 `startsWith(realBase + sep)`（第三、四处）；真实路径 `utils/file-safety.ts::realPathForSafety`（追悬空链接，最多 40 跳，缺失尾巴接回）。
- project：`utils/path.ts::isInsideRoot/toAbs`（区分大小写）；`utils/files/path-containment.ts::getRelativePathInsideProjectRoot/isPathInsideProjectRoot`；`utils/agent/sandbox.ts::resolveSourceInsideProject`（`relative().startsWith('..')`——**会把项目里名叫 `..foo` 的目录误判为出界**）；`utils/agent/file-context.ts` 第 33 行；真实路径 `impl/files/FileStore.ts::realPathPreservingMissing`（不追悬空链接）+ `assertConfinedToRoot`。
- 仓外同类：`packages/browser/src/core/BrowserWorkspaceFileAccess.ts::getRelativePathInsideRoot`、`packages/document-renderer/src/path-policy.ts::isInside`。

**异同**：大小写（system 在 macOS/Windows 不区分，project 区分；project 第二层是 realpath，macOS 上 realpath 给出磁盘大小写，实际风险小）；悬空链接（system 追到目标，写入落到链接目标；project 不追，原子写在 realpath 悬空链接时 ENOENT，失败关闭）；`..foo` 误判（project 一处）。

**能否合并**：词法判定完全可合并；真实路径参数化（是否追悬空链接）后可合并。**去处**：词法 → `@velaros-ai/platform` 的 `PlatformCompatibilityApi`（"路径文本怎么比"本就是它的职责，渲染进程可用，project 本就该从 platform 拿平台约定——ADR 0005）；真实路径 → `@velaros-ai/core/utils/RealPath`（Node 专用逐文件入口，与 `FilePersistence` 同档；capabilities 与 products 两个不相邻领域都在用，满足 core 准入）。

**接口草案**
```ts
// @velaros-ai/platform：PlatformCompatibilityApi「路径文本」组新增
/** candidate 是否在 root 之内（含 root 本身）：两者先按本平台规整（折叠 . 与 ..、统一分隔符），Windows 与 macOS 不区分大小写；任一不是绝对路径返回 false。只算文本不碰磁盘，符号链接由调用方先解开。 */
isPathTextInside(candidate: string, root: string): boolean
/** 同上；在里面时返回相对 root 的可移植路径（root 本身是 '.'），不在返回 null。 */
relativePathTextInside(candidate: string, root: string): Nullable<string>

// @velaros-ai/core/utils/RealPath
/** 判定安全用的真实路径：解开符号链接；路径不存在时解开最近的已存在祖先再把余下各段接回；followDanglingLinks 为真时悬空链接按其指向继续解（最多 40 跳）。 */
export async function resolveRealPath(path: string, options?: { followDanglingLinks?: boolean }): Promise<string>
```

**迁移/测试**：system 四处、project 四处换调用；platform 加用例（大小写、`..foo`、Windows 盘符与 UNC）；system acceptance INV-19（按真实路径判定）与 project `file-context-integration`、`project-sandbox` 相关用例回归。

---

### 3.9 敏感路径与凭证判定

- system 独有：`utils/file-safety.ts::isSensitiveSystemMutationPath`（系统目录、主目录点文件、启动项目录，临时区豁免）、`isCredentialPath`（凭证目录/文件名/扩展名/系统口令文件，大小写按平台）、`confirmSensitiveSystemMutation`、`confirmCredentialAccess`；用在 system:read/view/edit 与沙箱落回确认。
- project：没有等价物。project 有 `readDeny/writeDeny/protectedFiles` 策略 glob（宿主配置，默认空）与 `impl/kernel/providers.ts::createSecretRedactionProvider`（按内容正则打码 `sk-…`、`api_key=…`），都不是按路径识别凭证。

**结论**：不是重复，是缺口，**不抽**。若决定让 project 也对项目里的 `.env`、私钥、`.npmrc` 等先确认（值得评估：project:read 目前会把仓库里的 `id_rsa` 原样交给模型，只靠内容打码兜底），再把 `isCredentialPath` 与三张名单搬进 `@velaros-ai/path-rules`（同属"路径命中规则"），`isSensitiveSystemMutationPath` 仍留 system（系统空间自己的概念）。

---

### 3.10 命令结果整形与输出窗口

- system：`utils/command-result.ts::exposeCommandOutputWindow`（outputWindow + 指向 `context:recall` 的续接）、`buildSystemCommandResult`（成功判定 + 验证摘要）、`summarizeFailureOutput`；`SystemExecutionOperations.run` 补后台续接（指向 `system:list-tasks`）、端口、自动转后台标记。数据：`types/system.ts::SystemCommandResult/SystemBackgroundProcessInfo/SystemVerificationSummary/SystemCommandOutputCapture/SystemCommandOutputWindow/SystemCommandOutputContinuation/SystemRunCommandOptions`。
- project：没有整形，project:run 原样返回宿主的 `ProjectCommandResult`。数据：`types/project.ts::ProjectCommandResult/ProjectBackgroundProcessInfo/ProjectVerificationSummary/ProjectCommandOutputCapture/ProjectRunCommandOptions`。

**异同**：共有 17 个字段（command、cwd、exitCode、signal、stdout、stderr、logPath、durationMs、timedOut、aborted、truncated、capture、cleanupIncomplete、ownership、success、backgroundProcess、verification）逐一同形，`VerificationSummary`、`OutputCapture` 完全相同；system 独有 `shell/outputWindow/outputContinuation/confinement`、后台信息的 `console/statusContinuation`、选项的 `interactive/nativeCommand`；project 独有 `systemToolSuggestion`——ADR 0004 已判定"缺失工具的安装建议是宿主概念"并从 system 删掉，project 还留着（漂移）。Desktop 用系统能力实现 project 的 `runCommand`/`runInSandbox` 时要在两套同形类型之间搬。project 的模型拿不到"末尾真实、可召回完整输出"的提示（缺口）。

**结论**：数据形状参数化后可合并；整形逻辑只 system 有，不是重复。**去处**：shell-command 二期的 `./contracts`（`ShellCommandResult` 等，system/project 各自 `extends` 加独有字段）＋可选的 `shellCommandResults: ShellCommandResultApi { shapeOutputWindow(result, { logQuery }), summarizeFailure(stdout, stderr) }`。**前置**：§1-5 的可移植 import 规则。P2。

---

### 3.11 错误信封

- system：`AppError(code, message, cause: { reason: SystemErrorCodes.x, details: { executionOutcome: 'not-applied', problems | conflicts }, suggestedNextAction }, context: { executionOutcome: 'not-applied' })`——`utils/file-batch.ts::unresolvedEditFailure`、`utils/sandbox.ts::sandboxApplyConflict`；列表截到 `SystemFailureLimits.listItems`（10，注释说是"agent 工具契约约定"——但 agent 那个 10 是 `tools/ExecutionPolicyFailures.ts` 的私有常量 `MaxDetailsArrayItems`，没出包，system 是抄的数）。
- project：`utils/errors.ts::ProjectError(reason, message, details, suggestedNextAction)`；not-applied 写在 `details.executionOutcome`（`utils/transactions/transaction-errors.ts::withNotAppliedOutcome`；对 AppError 则写 `context.executionOutcome`）；内核边界 `projectCapabilityError` 翻成 `AppError(reason, message, error, { projectError })`；诊断截到 `MaxReportedDiagnostics = 10`（又一份 10）。
- agent 读取侧：`ExecutionPolicyFailures.ts` 沿 cause 链找 `reason/details/suggestedNextAction`，not-applied 从 `context.executionOutcome` 读，`Executor.ts` 又从 `details.executionOutcome` 读；并且**专门特判 `context.projectError`**（agent 认得 project 的私有键，反向耦合）。

**结论**：同一约定三种写法，参数化后可合并成一个构造器。`ProjectError` 作为 project 内部领域错误类保留（全包都在用），只在工具/内核边界统一翻译。**去处**：`@velaros-ai/agent/tool-contract`（读的一方在 agent，写的一方跟它放在一起才对得上）。

```ts
/** 失败回执里每个列表最多列几项；Agent 边界按它截，工具构造失败时也按它截。 */
export const ToolFailureLimits = Object.freeze({ listItems: 10 })
/** 挂在 AppError.cause 上的领域原因：稳定机器码、结构化详情、给模型的下一步。 */
export interface ToolFailureCause { reason: string; details?: Record<string, unknown>; suggestedNextAction?: string }
/** 造一个工具失败：code 是通用码；notApplied 为真时 details 与 context 同时标 executionOutcome: 'not-applied'（入参可复用）；applied 列出写到一半已生效的目标。 */
export function createToolFailure(code: ErrorCode, message: string, cause: ToolFailureCause, options?: { notApplied?: boolean; applied?: readonly string[] }): AppError
```
**迁移**：system 两处构造器改用它、`SystemFailureLimits.listItems` 改引 `ToolFailureLimits.listItems`（删该常量会破坏 `./contracts`，需拍板）；project 的 `withNotAppliedOutcome`、`projectCapabilityError` 在边界改用它；project 发版后 agent 删 `context.projectError` 特判。**测试**：agent 加构造器单测；system acceptance INV-20/24、project `project-edit-recovery`、`transaction-write-faults` 回归（回执形状不应变）。

---

### 3.12 其他重复

| 项 | 位置 | 判断 | 建议 |
| --- | --- | --- | --- |
| 内置 mod 清单 + 内核模块样板 | system `SystemTools.ts` 末尾约 110 行；project `ProjectTools.ts` 末尾约 150 行；browser `composition/mod.ts`；office `kernel-module.ts` | 类别表→常驻集→manifest（order 基数、availableInSpaces/residentInSpaces、spaces 的 identityStrategy/boundCapabilityIds）→bundled 定义→能力令牌→defineKernelModule，形状相同 | P3：`@velaros-ai/agent/mods` 加 `defineBundledSpaceMod(...)`，与 §3.5 的 `defineToolCapabilityModule` 配套 |
| 代理对安全截取 | system `utils/text.ts::takeUnicodeSafeTail`、`utils/text-file.ts::clampTextRange`；project `utils/text.ts::assertWellFormedProjectText`、`utils/files/file-reader.ts::assertCharacterBoundary`；agent 另有 4 处（`kernel/tool-output-store.ts`、`FileSnapshotArchive.ts`、`residency/admission.ts`、`retrieval/Pagination.ts`） | 域无关原语 | P2：core `utils/string.ts` 加 `clampToCodePointBoundary(text, index, bias)`、`takeTail(text, maxChars)`；孤立代理判定直接用 Node 20 起就有的 `String.prototype.isWellFormed()`（engines 已是 >=20） |
| errno 读取 | system `utils/fs.ts::readErrnoCode`；project 三处内联 `isObject(error) && 'code' in error`；kernel/cli/browser/office/agent 另有 10+ 文件 | 域无关原语 | P3：core `readErrnoCode(error): Nullable<string>` |
| run 工具的 shell 语法提示词 | system:run 的 protocol 三句与 project:run 的 protocol 两句几乎逐字相同（Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 选；`command -v/$NAME`、`Get-Command/$env:NAME`、`where/%NAME%`；失败先诊断退出码） | 模型面文案重复，改一边忘另一边就漂 | P2：`@velaros-ai/shell-command` 常量表 `ShellCommandGuidance`，两边工具定义引用（提示词变更，差量报告点名） |
| 执行上限 | system `SystemCommandLimits.timeoutMs=600_000/outputChars=50_000`；project:run、project:sandbox 的 schema 写死同样的数 | 宿主执行器是同一个，上限是它的属性 | 随 shell-command 出 `ShellCommandLimits`；沙箱上限见 §3.3 |
| 统一差量 | system `utils/sandbox.ts::renderTextDiff`（`createTwoFilesPatch`，带 `===` 头）；project `utils/diff.ts::unifiedDiff`（`structuredPatch`，git 式 `a/ b/` 头） | 形状相近、格式不同、各 20 行 | 不单独开口；沙箱引擎二期搬家时统一成 git 式 |
| 工具上下文基形 | `{ abortSignal, approval, sessionId?, toolCallId? }` 两边各自声明 | 字段少、收益小 | 不建议单独开工 |

---

## 4. 顺带发现的缺陷（合并时一起修；不合并也该修）

1. **project 内核直调先解析宿主上下文再校验入参**（`utils/tool.ts::createProjectCallableOperations`），注释写的是反的；坏入参也会触发宿主上下文解析（§3.5）。
2. **沙箱落回确认只覆盖截断后的前 2000 条**，引擎却落回全部；system 的敏感路径筛查同样只看了前 2000 条（§3.3-6）。两个空间同病。
3. 只读判定的兜底正则只在 project，一致性语料没覆盖（§3.1）。
4. project:run 不确认长驻命令；并发缺省与 system 相反（§3.1）。
5. project 危险确认缺 ADR 0004 承诺的仓库提醒句（§3.1）。
6. project 两个同名 `ProjectSandboxPort`，Desktop 拿到的是旧的（§3.3-7）。
7. system gitignore 解析缺锚定通配/`**`/字符类/转义空格，影响沙箱镜像"忽略目录只读链接"的承诺；project 丢了目录限定（§3.7）。
8. system 文本：GBK 读成乱码（newText 整份写入还会把 GBK 文件静默改存成 UTF-8）、非法字节静默替换、孤立代理静默替换、短 UTF-16 误判、原子写不 fsync、权限位受 umask、拆硬链接（§3.6）。
9. project `resolveSourceInsideProject` 误拒 `..foo` 目录（§3.8）。
10. agent 失败提取特判 `context.projectError`（§3.11）。
11. project visibility 的 hidden allowlist（`.xcodeproj/.xcworkspace`）不起作用（§3.7）。
12. `module-ownership.md` 两节自相矛盾（§1-2）。

---

## 5. 推荐方案

### 5.1 新建 4 个包

| 包 | 目录 | 职责一句话 | 依赖 | 入口 |
| --- | --- | --- | --- | --- |
| `@velaros-ai/shell-command` | `packages/shell-command` | agent 代跑一条 shell 命令的公共语义：执行前判定（只读、危险、长驻、端口、能否并发）、确认文案与审批请求，二期加执行回执的数据形状 | core；`./approval` 另 peer `@velaros-ai/agent`（只用 tool-contract） | `.`（纯函数，渲染进程可载）、`./approval`、`./contracts` |
| `@velaros-ai/text-files` | `packages/text-files` | 磁盘文本文件的无损读写：编码识别与转换（UTF-8/BOM/UTF-16/GB18030）、二进制判定、换行适配、原子写入、有界与流式读取 | core、iconv-lite | `.`（Node）、`./contracts` |
| `@velaros-ai/path-rules` | `packages/path-rules` | 路径命中规则：glob 匹配、.gitignore 解析与判定（git check-ignore 优先）、遍历默认跳过的目录（将来可收凭证路径识别） | core、picomatch | `.`（Node）、`./contracts` |
| `@velaros-ai/rehearsal-sandbox` | `packages/rehearsal-sandbox` | 演练沙箱的契约与规则：数据形状、上限、落回的筛选/确认/审批请求/冲突失败，二期收镜像、差量、落回、删除守卫的引擎 | core、peer agent；二期加 path-rules、text-files、diff | `.`、`./contracts` |

四个都是"一个含义"：一条命令的执行语义、一个文本文件的无损读写、一组路径命中规则、一种沙箱。不合成一个"共享包"（那就是杂物包）；也不塞进 platform/core（§1-3、§1-4 的理由）。

**依赖方向**
```
core ← platform
core ← shell-command ┄┄(./approval peer)┄┄ agent/tool-contract
core ← text-files
core ← path-rules
core ← rehearsal-sandbox ← (二期) path-rules、text-files
system  → platform、shell-command、text-files、path-rules、rehearsal-sandbox、kernel、agent(peer)
project → platform、shell-command、text-files、path-rules、rehearsal-sandbox、kernel、agent(peer)
Desktop / Workbench / Termel → shell-command（不再为一个判定依赖 project）
公共包不依赖任何能力包；system 与 project 仍互不引用
```

### 5.2 已有包新增

| 包 | 新增 | 收掉的重复 |
| --- | --- | --- |
| `@velaros-ai/agent/tool-contract` | `createSpaceToolDefiner`、`parseToolWireInput`、`createToolCallableOperations`（可选 `defineToolCapabilityModule`）、`createToolFailure` + `ToolFailureLimits` | §3.4、§3.5（含 office）、§3.11 |
| `@velaros-ai/agent/mods`（P3） | `defineBundledSpaceMod` | §3.12 mod 样板（system/project/browser） |
| `@velaros-ai/platform` | `PlatformCompatibilityApi.isPathTextInside`、`relativePathTextInside` | §3.8 词法包含判断 |
| `@velaros-ai/core` | `utils/RealPath.resolveRealPath`、`utils/string` 的代理对安全截取、`readErrnoCode` | §3.8 真实路径、§3.12 |

agent 公开 API 基线按 additive 重绑（`check:agent-public-api`）。

### 5.3 不建议合并的

- 两个空间的工具入参 schema 与说明（system:sandbox↔project:sandbox、system:run↔project:run）：形状相同但文案与路径语义按空间不同，按治理文档"各持一份 + 一致性测试"，数字与共享文案引公共常量。
- 审批的拒绝语义（抛错 vs 结构化拒绝）与 riskScope 前缀：各空间自己的产品语义，公共包只出"请求"。
- system 的系统敏感路径判定、TCC 受保护目录、媒体类型、版本号；project 的行/revision/事务字节计划。
- 统一差量渲染（格式不同、量小）。

### 5.4 预计删除的重复行（按 21:25 的磁盘估）

| 项 | 两边现状 | 合并后公共实现 | 净删源码 | 测试 |
| --- | --- | --- | --- | --- |
| 命令判定 | 807 + 839 + 33 = 1,679 | ~830 | **~850** | 净删 ~350（parity 166 + project 纯判定用例 ~170 + 重复断言） |
| 审批请求构造 | 3 处 × ~18 | ~40 | ~15 | — |
| 沙箱契约与规则 | 数据 76 + 83，规则 36 + 30，端口与常量 ~25 ≈ 250 | ~130 | ~120 | parity 数据部分 ~20 |
| 工具定义 + 可调用操作表（含 office） | 92 + 20 + 130 + ~76 ≈ 320 | ~100 | ~220 | — |
| 文本文件 | system ~155，project ~530（搬家） | ~560 | ~150（system 侧整删） | 搬 ~300，净删 ~40 |
| gitignore / glob / 跳过名单 | system ~265，project ~270（搬家） | ~320 | ~215 | 搬 ~150 |
| 包含判断 / 真实路径 | 两包 8 处 ~155 | ~50 | ~100 | — |
| 失败信封 / 上限 | ~40 | ~25 | ~15 | — |
| 代理对 / errno（两包内） | ~80 | ~25 | ~55 | — |
| **合计（P0–P2）** | | | **≈ 1,700 行** | **≈ 400 行净删**，另搬家 ~450 行 |
| P3：mod + 内核模块样板（system/project/browser/office） | ~350 | ~90 | ~250 | — |

另有约 1,000 行是"搬家不删"（project 的文本、gitignore 实现，system 的沙箱引擎二期）。

### 5.5 分期（每期结束 `check:module-ownership`、`check:capabilities-arch`、`check:capabilities-schemas`、`check:agent-public-api`、`check:package-catalog`、`bun run check` 全绿；e2e 按规矩最后一步跑）

- **P0**（风险低、收益高，等 project 这轮搬家提交后再动）
  1. `@velaros-ai/shell-command`（判定 + 文案 + `./approval`），两空间与三个宿主迁移，删命令一致性测试。
  2. agent/tool-contract：`parseToolWireInput` + `createToolCallableOperations`（顺带修 §4-1，office 一起换）、`createToolFailure` + `ToolFailureLimits`。
- **P1**
  3. `@velaros-ai/rehearsal-sandbox` 契约与规则（修 §4-2；先改名旧 `ProjectSandboxPort`）。前置：可移植 import 规则放宽。
  4. `createSpaceToolDefiner`（project 加类别表、去占位文案——拍板后做）。
  5. `@velaros-ai/text-files`（system 行为变更拍板后做）。
- **P2**
  6. `@velaros-ai/path-rules`（修 system gitignore）；platform 包含判断；core 真实路径与代理对。
  7. shell-command 二期（命令回执数据形状与整形、shell 语法提示词常量）；rehearsal-sandbox 二期（引擎搬家）。
- **P3**：`defineBundledSpaceMod` / `defineToolCapabilityModule`、core `readErrnoCode`；若决定，凭证路径进 path-rules 并给 project 用。

### 5.6 需要人拍板的项

1. 新增 4 个包与一个新域（拓扑变更，写 ADR 0008）。
2. 放宽"可移植数据文件不 import"：允许 `import type` 另一个已治理包的 `./contracts`（否则沙箱数据、命令回执只能继续镜像）。
3. `module-ownership.md`「常量分四处」那句改口。
4. 命令判定统一：删 project 兜底正则（project 里 `grep delete` 这类命令不再要修改授权）；并发缺省（显式 opt-in 还是只读即并发）；确认文案加仓库提醒（project 用户看到的审批文案变）。
5. project:run 是否也确认长驻命令；危险命令被拒是抛错还是结构化拒绝（两空间统一与否）。
6. system 文本行为变更（GBK 能读能改、非法字节不再"成功"、孤立代理拒写）。
7. project 工具描述去占位文案（提示词变更，要重算 guidance 审核指纹）。
8. 出口删除（破坏性）：system 根入口 `systemCommandPolicy`、`SystemCommandPolicyApi`、`SystemCommandExecutionPlan`；project `./execution` 的判定函数、三个别名与 `CommandExecutionPlan`；`SYSTEM_SANDBOX_CONFLICT` 是否改名；`SystemFailureLimits` 是否删。
9. project 是否引入凭证路径确认（§3.9）。

### 5.7 登记与门禁改动清单

- 根 `package.json` 的 `velaros.domainPackages` 新增一个域（建议 `"foundations": ["shell-command", "text-files", "path-rules", "rehearsal-sandbox"]`），`docs/architecture/repository-topology.md` 的 Domains 表加一行。
- 新域门：公共包只许依赖 core、platform、kernel 契约、agent（peer，只用 tool-contract）与彼此（rehearsal-sandbox → path-rules/text-files）；能力包可依赖它们。**不要把它们登记进 `scripts/capabilities/capability-owners.mjs` 的 `CapabilityOwners`**——否则 system/project 依赖它们会被 `check:capabilities-arch` 判"跨 owner"；另写一个 `check:foundations-arch`（或在 capabilities 门里加方向检查）。
- `scripts/ownership/governed-modules.mjs` 加四条登记（无 toolsFile/toolDefiner/hostPort，照 platform 那条）；每包 `MODULE.md` 十节、`spec/invariants.md`、`spec/acceptance.test.ts`；shell-command 的 `browserSafeEntries: ['index.ts', 'contracts.ts']`。
- 构建拓扑 `scripts/build/buildPackageTopology.mjs`、发布 `scripts/release/*`、`generate:package-catalog`、`check:dependency-licenses`（iconv-lite、picomatch、diff 已在 project 依赖里，许可已审）。
- system、project 的 `package.json` 加依赖；project 新依赖 platform。
- system `spec/invariants.md`：INV-2/3/18 标"已移到 @velaros-ai/shell-command"，二期 INV-24/25/26 标"已移到 @velaros-ai/rehearsal-sandbox"；system/project 的 `MODULE.md`「依赖什么」「提供什么」同步。
- Desktop / Workbench / Termel 按 §2 迁移，随下一版火车。
