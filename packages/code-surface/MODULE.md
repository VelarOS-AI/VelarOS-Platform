# @velaros-ai/code-surface 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/CodeSurfaceSession.ts` 类上方的接口（`contract/provides.ts` 登记它），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

代码面：模型不再一次一个工具地调，而是**写一段程序**，用生成出来的能力声明把事情一次办完。
程序在执行之前先过 TypeScript 的检查，通过了才在隔离里跑；程序发出的每一次能力调用都转回宿主，
审批、危险判定、运行事件仍在原来那道端口后面。

本包**不认识任何一件具体能力**。哪些能力存在、某次调用要不要向用户要授权、算不算危险，全在宿主那一侧。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：两件东西的 API 定义在各自类的上方，这里 re-export。

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `codeProgramChecker` | `CodeProgramCheckerApi` | 执行之前的那道门。程序是 JavaScript，但照样受类型检查（`checkJs`，类型从声明里推）——字段拼错、读一个不存在的字段、入参形状错、输出被截断，都在这里拦下，报错直接给出正确的名字。模型手滑写了 TypeScript 时不废掉整轮：剥掉类型照跑 |
| `createCodeSurfaceSession` | `CodeSurfaceSessionApi` | 把一次「模型交了段程序」办完：查体量 → 检查 → 隔离里执行 → 把能力调用转给宿主 → 编成给模型看的结果 |
| `nodeSubprocessCodeRunner` | `CodeRunnerApi` | **开发期专用**的隔离运行器，见「非目标」 |
| `createCapabilityPort` | `CodeCapabilityPort` | 能力空间交一张**操作表**（命名空间 → 操作名 → 怎么校验、怎么做），拿回代码面要的那个端口。登记、校验、转发、整形错误这四件事每个空间一模一样，写一遍就够；表里**没有一个字是给模型看的**，模型面只有生成的那份声明 |
| `NodeSubprocessRunnerIsReleaseReady` | 契约常量 | 恒为 `false`：上面那个运行器不许进正式发版，宿主装配时据此拦下 |
| `CodeSurfaceModId` | 契约常量 | 本包作为内核模块的身份 |
| `CodeSurfaceDiagnosticCodes` | 契约常量 | 认得出来的 TypeScript 诊断码：`unresolvedModule` 就是「import 了没授权的能力模块」，那道闸是语言给的 |
| `CodeSurfaceErrorCodes` / `CodeSurfaceLimits` | 契约常量 | 七个错误码；程序源码、blobs、返回值、日志、调用次数、墙钟的对外上限 |
| `ApprovalNamespace` | 契约常量 | 审批模块的命名空间。这个命名空间的调用就是「程序在等人」，会话据此停表——等用户点头的时间不算程序的时间 |

**注入面**在 `contract/requires.ts`：

| 接口 | 宿主要给什么 |
| --- | --- |
| `CodeCapabilityPort` | 代码面与真实能力之间唯一的通道。`listOperations` 报有哪些能力（声明与隔离里的桩都按它造），`invoke` 执行一次调用——**审批、危险判定、权限、运行事件都在它里面撞** |
| `CodeCapabilityCall` / `CodeCapabilityOutcome` | 一次调用的入参与结果；结果里的 `error` 在程序里是一个能 `try/catch` 的异常 |
| `CodeSurfaceEventSink` | 程序跑起来之后陆续发生的事：调用起止与日志。界面要实时看见日志，模型那边不走这条路 |

**数据面**是 `types/code-surface.ts`，可移植：`CodeProgramRequest`（程序与 `blobs`）、`CodeProgramDiagnostic`（一条诊断）、
`CodeProgramEdit` / `CodeProgramRange`（在上一份上改的一处）、`CodeCallNotice`（系统插手过的地方）、
`CapabilityLease` / `ProgramImport`（租约与能力 import）、`GrantedModule`（这一轮授了哪个命名空间）、
`CodeProgramFailure`、`CodeProgramResult`、`CodeProgramCheckResult`
（`CodeProgramCheckSuccess` / `CodeProgramCheckFailure`）。`types/runner.ts` 的 `CodeRunnerApi`、`CodeRunRequest`、
`CapabilityOperation` / `CapabilityNamespaceOperations` / `CapabilityOperationTable` 是能力空间交出来的操作表（`CodeCapabilityPort` 的对偶）。`types/runner.ts` 的 `CodeRunnerApi`、`CodeRunRequest`、
`CodeRunDispatch`、`CodeRunOutcome`、`HoldProgramClock` 是隔离运行器的形状，只走根入口——隔离方案会换，抽成接口才换得动。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 全部：检查器、会话、开发期运行器，以及数据面与注入面的类型。起子进程、跑编译器都要 Node |
| `./contracts` | 渲染进程与任何不碰 Node 的地方 | 只有可移植数据与常量表：错误码、对外上限、程序与结果的形状 |

## 骨干链路

**程序是一个 ES 模块**：`import { read } from 'velar:system'` 拿能力、顶层 `await` 直接用、
`export default` 交出答案。写的是真 JavaScript，不是方言——那是代码面唯一的依仗。

**我们发明的东西要导入，语言自带的不动**：`blobs` 走恒常授权的 `velar:program`
（隐形全局是只有提示词告诉过模型才知道的暗知识），`console` 是 JavaScript 自带的，不动。

定下跑哪份源码（整份重写，或在上一份上按 `edits` 改）→ 查体量 → typecheck（不过就**一行都不执行**）→ 隔离里跑 → 程序发的每次调用转给宿主的能力端口
→ 收集 `notices`（系统插手过的地方）→ 编成结果。

**改上一份程序不必整份重写**：`edits` 照 `system:edit` 的协议（`oldText` 一字不差、范围里必须唯一、
一组全成或全不成、各处不许重叠），**不用行号**——模型看不见自己刚写那段代码的行号，让它数行是在让它做最不擅长的事。
同理，诊断一律带**代码帧**：出错那一行连同一个插字符摆出来，它一眼知道改哪儿。

文件内容这类大字符串走 `blobs` 不进 `source`：进了就要过三层转义（JSON → 字符串字面量 → 内容本身），
反引号、`${`、反斜杠、引号全是雷。走 `blobs` 只有一层，和今天的工具调用一样。

## 依赖什么

`typescript`（检查与手滑那条路的剥类型）、`@velaros-ai/core`。能力端口与事件槽由宿主注入。

## 状态归谁

本包不持有任何跨调用状态。一次程序一个隔离进程，跑完即销毁。

## 生命周期

`submit` 是一次性的：进去一段程序，出来一份结果。中止靠传进来的 `signal`，超时由 `timeoutMs` 兜底。

## 失败语义

错误码见 `contract/constants.ts`：`PROGRAM_ERROR`、`TIMEOUT`、`ABORTED`、`RUNNER_CRASHED`、
`UNKNOWN_OPERATION`、`TOO_LARGE`、`INVALID_INPUT`、`OPERATION_FAILED`。typecheck 没过时回的是诊断而不是结果——程序一行都没有执行，形状也不一样。
能力端口报的错在程序里是一个**能 try/catch 的异常**，不是静默的空回执。

## 不变量

共 19 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 18 条、门禁 1 条。未验证 0 条。

## 非目标

- **不判断某次调用危不危险、要不要审批**：那是能力端口的事，门必须下沉到那里——
  代码块里几十条语句不是一个可审查单元。
- **`nodeSubprocessCodeRunner` 不是可发版的隔离**：它挡得住读写文件与起子进程（实测 `ERR_ACCESS_DENIED`），
  **挡不住网络**，Node 的权限模型不覆盖 socket。敏感数据是我们自己经能力端口递进去的，所以这条缺口很要命。
  正式版换 WASM 里的 QuickJS。`NodeSubprocessRunnerIsReleaseReady` 恒为 `false`，宿主装配时据此拦下。
- **不生成能力声明**：声明由能力包那一侧从源码生成，本包只负责按给定的声明检查与执行。

## 结构

```
src/
  contract/   constants.ts 错误码与对外上限；provides.ts 交出去的接口；requires.ts 宿主注入的能力端口与事件槽
  types/      code-surface.ts 可移植数据（程序、诊断、结果）；module-form.ts import 与租约；
              editing.ts 编辑落到原文后的形状；runner.ts 隔离运行器的形状
  impl/       CodeSurfaceSession 会话编排；CodeProgramChecker 执行前的检查；NodeSubprocessCodeRunner 开发期隔离；
              CapabilityOperationPort 操作表接成能力端口
  utils/      compiler.ts 编译器那一侧的活；module-form.ts 挖 import 与租约、改写成隔离能跑的形状；
              edit.ts 在上一份程序上改；diagnostics.ts 带代码帧的诊断；
              result.ts 定源码与编结果；budget.ts 预算裁剪；program.ts 包装；node-executable.ts 找一个真的 node；tuning.ts 可调参数
bin/          code-surface-child.mjs 隔离进程侧引导，自身不引任何模块
```
