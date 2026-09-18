# @velaros-ai/code-surface 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看 `src/impl/CodeProgramGate.ts` 与 `src/impl/CodeSurfaceSession.ts` 类上方的接口（`contract/provides.ts` 登记它们），utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`。

## 这是什么

代码面：模型不再一次一个工具地调，而是**写脚本**，用生成出来的能力声明把事情一次办完。
脚本在执行之前先过 TypeScript 的检查，通过了才在隔离里跑；脚本发出的每一次能力调用都转回宿主，
危险判定、运行事件仍在原来那道端口后面。

本包**不认识任何一件具体能力**。哪些能力存在、某次调用算不算危险，全在宿主那一侧。

模型面上是四个工具（`impl/CodeSurfaceTools.ts`）：`script:exec` 一次给几步——跑代码、存进脚本库、改版本、退回旧版本、按记录重放；
`script:history`、`script:show`、`script:diff` 只读时间线。每一次调用、每一步的代码、参数与结果都记在这个空间的**时间线**上，
脚本库（每个路径的各版本）也在里面；项目空间还给工作区打标记，记下每一步改了哪些文件——**只存哈希，不存文件内容**。
写脚本的规矩、`velar:program` 的声明与常驻模块的完整声明由 `describe` 编好，宿主放进系统提示词最前面那段（按空间恒定，能命中前缀缓存）；
工具说明只讲入参怎么填。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：几件东西的 API 定义在各自类的上方，这里 re-export。

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `codeProgramChecker` | `CodeProgramCheckerApi` | 执行之前的那道门。脚本是 JavaScript，但照样受类型检查（`checkJs`，类型从声明里推），连同它 import 到的库里的脚本一起查——字段拼错、读一个不存在的字段、入参形状错、输出被截断，都在这里拦下，报错直接给出正确的名字；出在库里别的脚本上的诊断带着它的路径。模型手滑写了 TypeScript 时不废掉整轮：剥掉类型照跑 |
| `createCodeSurfaceSession` | `CodeSurfaceSessionApi` | 把一段脚本办完：查体量 → 检查 → 隔离里执行（连同库里的脚本、参数与大段文本）→ 把能力调用转给宿主 → 编成给模型看的结果，另外交出落定的调用账（带 changeRef 的记下它），时间线记账用 |
| `nodeSubprocessCodeRunner` | `CodeRunnerApi` | **开发期专用**的隔离运行器，见「非目标」 |
| `codeSurfaceTools` | `CodeSurfaceToolCollection`（其中的 `CodeSurfaceTool`） | 门在模型面上的四个工具，按工具名索引。都常驻、回执不卸载；exec 同一会话不并发；执行时交给上下文里的门，exec 的回执写成 agent 原样转给模型的内容块（文字在前、图在后），模型不收图时图不放进去；只读的三个交回一块文字 |
| `createCodeSurfaceKernelModule` / `CodeSurfaceCapability` | `CodeSurfaceCapabilityService` | 把四个工具挂进 VelarOS 内核的模块与它的身份令牌；宿主给了上下文解析器，才能按名调用 |
| `CodeSurfaceToolNames` / `CodeSurfaceToolCategoryId` / `CodeSurfaceKernelModuleVersion` | 契约常量 | 门的工具名（`script:exec`、`script:history`、`script:show`、`script:diff`）、工具类别（`script`，宿主在会话里打开它门才出现）、内核模块版本 |
| `ScriptStepOps` / `ScriptDiffKinds` | 契约常量 | exec 一步能做的六件事（write、edit、restore、remove、run、replay）；diff 比什么（code、files） |
| `createCodeProgramGate` | `CodeProgramGateApi` | 模型写脚本的那扇门：按会话记导入过的模块，按空间开时间线（同一个目录进程里一条）。`exec` 按顺序办完每一步并记进时间线（同一条时间线上的 exec 排队做），`history`、`show`、`diff` 只读时间线；给模型的说明（规矩、四个工具、常驻模块的完整声明、其余模块的方法名）也由它编 |
| `createCapabilityPort` | `CodeCapabilityPort` | 能力空间交一张**操作表**（命名空间 → 操作名 → 那个函数），拿回代码面要的那个端口。登记、转发、整形错误这三件事每个空间一模一样，写一遍就够。表里**没有校验也没有一个字给模型**：说明在生成的声明里，校验在操作方法自己里——盖在调用方这一侧换个入口就漏 |
| `NodeSubprocessRunnerIsReleaseReady` | 契约常量 | 恒为 `false`：上面那个运行器不许进正式发版，宿主装配时据此拦下 |
| `CodeSurfaceModId` | 契约常量 | 本包作为内核模块的身份 |
| `CodeSurfaceDiagnosticCodes` | 契约常量 | 认得出来的 TypeScript 诊断码：`unresolvedModule` 就是「import 了没授权的能力模块」，那道闸是语言给的 |
| `CodeSurfaceErrorCodes` / `CodeSurfaceLimits` | 契约常量 | 十三个错误码；对外上限——脚本源码、blobs 加 input、调用次数、墙钟、exec 一次几步、history 一次几条、脚本路径多长，以及**回给模型的总量**（`resultChars`）和它下面每条通道各自的上限 |

**注入面**在 `contract/requires.ts`：

| 接口 | 宿主要给什么 |
| --- | --- |
| `CodeCapabilityPort` | 代码面与真实能力之间唯一的通道。`listOperations` 报有哪些能力（声明与隔离里的桩都按它造），`invoke` 执行一次调用——**危险判定、运行事件都在它里面撞** |
| `CodeCapabilityCall` / `CodeCapabilityOutcome` | 一次调用的入参与结果；结果里的 `error` 在程序里是一个能 `try/catch` 的异常 |
| `CodeSurfaceEventSink` | 脚本跑起来之后陆续发生的事：调用起止与日志。界面要实时看见日志，模型那边不走这条路 |
| `CodeSurfaceTimelinePort` | 这个空间的时间线放在哪（应用数据目录下的一个目录，每个项目一份）、给哪个目录打标记（项目空间给项目根，系统空间不给）、保留上限（不给用缺省）。同一个目录只该由一个宿主进程写 |
| `CodeSurfaceSpacePort` | 这一次调用所在的空间：挂的模块、按这次调用装好的能力端口、时间线 |
| `CodeSurfaceToolContext` | 四个工具每次被调用时宿主给的上下文：取消信号、会话身份（带上分支与检查点）、门、这一次调用所在的空间、模型收不收图、界面事件槽 |
| `CodeSurfaceToolContextResolver` / `CreateCodeSurfaceKernelModuleOptions` | 内核按工具名调用时，宿主用它把作用域换成一份门的上下文；建内核模块时放在选项里给 |

**数据面**是 `types/code-surface.ts`，可移植：`CodeProgramRequest`（脚本、它在库里的位置、它会 import 到的库里的脚本、`input` 与 `blobs`）、`CodeProgramDiagnostic`（一条诊断，出在库里别的脚本上时带路径）、
`CodeProgramEdit`（在底稿上改的一处：`oldText` 换 `newText`）、`CodeCallNotice`（系统插手过的地方）、`ScriptFileChange`（一步改了的一个文件与前后哈希）、
`CapabilityLease` / `ProgramImport`（租约与能力 import）、`GrantedModule`（这一轮授了哪个命名空间）、
`CapabilityModuleSurface`（一件能力随包发布的模型面）/ `MountedCapabilityModule`（空间挂的一件能力与它常不常驻）、
`CodeProgramFailure`、`CodeProgramResult`、`CodeProgramCheckResult`
（`CodeProgramCheckSuccess` / `CodeProgramCheckFailure`）。
门的入参与回执在 `types/gate.ts`，只走根入口：`CodeGateExecInput`、`CodeGateQuery`、`CodeGateReply`、`ScriptStepInput`、`ScriptStepReport`、
`ScriptHistoryInput`、`ScriptShowInput`、`ScriptDiffInput`。
`CapabilityOperation` / `CapabilityNamespaceOperations` / `CapabilityOperationTable` 是能力空间交出来的操作表（`CodeCapabilityPort` 的对偶）。`types/runner.ts` 的 `CodeRunnerApi`、`CodeRunRequest`、
`CodeRunDispatch`、`CodeRunOutcome`、`HoldProgramClock` 是隔离运行器的形状，只走根入口——隔离方案会换，抽成接口才换得动。

两个入口对应 `package.json` 的 `exports`，源文件是 `src` 根上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `.` | Node 宿主 | 全部：检查器、会话、门、开发期运行器，以及数据面与注入面的类型。起子进程、跑编译器、读写时间线都要 Node |
| `./contracts` | 渲染进程与任何不碰 Node 的地方 | 只有可移植数据与常量表：错误码、对外上限、脚本与结果的形状、一步改了的文件 |

## 骨干链路

**四个工具**（`impl/CodeSurfaceTools.ts`）：`script:exec` → `ctx.gate.exec`（开这个空间的时间线、排队、交给一次 `ScriptExecution`）→
`scriptToolResult` 把回执写成内容块：文字在前，每张图前面一行说明，`result` 与内容块里的文字逐字一致（agent 据此原样转给模型）；
模型不收图时图不放进去、只说一声。`script:history`、`script:show`、`script:diff` → `ctx.gate.history / show / diff`（`ScriptTimelineViews` 读时间线）→ `textToolResult`，一块文字。

**一次 exec**（`impl/ScriptExecution.ts`）：开头扫一遍工作区打标记，和上一次记下的比，外面改过的记成外部改动（整份退回之前某一点时认得出是哪一点）；
然后按顺序做每一步，每一步做完先落日志再做下一步，某一步没成就停：
- write、edit、restore：定下正文（edit 在底稿上按 `edits` 改）→ 连同它 import 到的库里的脚本一起过检查（要是 JavaScript）→ 存成这个路径的新版本（和最新版一样就不存；版本号接着这个路径存过的最后一版往下排）；
- remove：把脚本从库里拿掉（各版本还在，restore 或者再 write 就回来了），还在 import 它的脚本当场点名；
- run：代码是 `program`，或者 `from` 已有的代码（脚本的一版、之前某一步的代码，带 `edits` 就先改），参数不给就沿用那一步当时的 →
  顺着相对 import 找全库里的脚本（最新版）→ 交给会话跑 → 跑完再扫一遍工作区，记下这一步改了哪些文件；
- replay：取那一步当时的代码、参数与库版本 → 跑之前核对它改过的文件还是改前的样子 → 跑 → 跑完核对改出来的和当时一样，对不上就算没成；
  给 from、to 一段调用号时，按先后展开成那一段里跑成了、改过文件的每一步，文件已经是它改后（或这一段做完）的样子的跳过。
不是这一轮写的代码（库里的脚本、之前某一步的代码）import 的能力模块直接给上，不让模型为它们先读一遍声明。

**时间线**（`impl/ScriptTimeline.ts`，落盘在 `impl/TimelineStorage.ts`，标记在 `impl/WorkspaceMarkers.ts`）：一个目录里 `journal.jsonl`（每次调用开头一行、每一步一行）、
`objects/`（代码、参数、结果、目录节点，按 sha256 寻址，同样的内容只存一份）、`stat-cache.json`。标记是只含哈希的目录树的根：
每个文件算 sha256，按目录拼成树；被 .gitignore 忽略的与按名字默认跳过的目录不算；大小、修改时间、inode 都没变的文件不重算。
存的东西超过保留上限时，从最旧的调用清起：结果正文、参数、标记清掉，代码留着。

**一段脚本**（`impl/CodeSurfaceSession.ts`）：查体量 → typecheck（不过就**一行都不执行**）→ 隔离里跑（`import` 改写成 `__velar(...)` 与 `await __import(...)`，库里的脚本每个只跑一次）
→ 脚本发的每次调用转给宿主的能力端口（调用期间停表：命令、等用户点头都不算脚本的时间）→ 收集 `notices`（系统插手过的地方）
→ 脚本停下时叫停还没落定的调用、记进 `unsettled` → 编成结果，再写成模型读的文字（字符串原样、别的按 JSON、具名导出按名字分段）。

**脚本是一个 ES 模块**：`import { run } from 'velar:shell'` 拿能力、`import { parse } from './lib/x.js'` 拿库里的脚本、顶层 `await` 直接用、
用 `export` 交出要看的东西（`export default` 或具名导出）。写的是真 JavaScript，不是方言——那是代码面唯一的依仗。

**我们发明的东西要导入，语言自带的不动**：`input`、`blobs` 与 `template` 走恒常可用的 `velar:program`
（隐形全局是只有提示词告诉过模型才知道的暗知识），`console` 是 JavaScript 自带的，不动。
**代码模版不常驻**：它们随能力的模型面发布、跟着脚本送进隔离进程，脚本 `template('velar:x')` 读到、导出了才进上下文。

**改已有的代码不必整份重写**：`edits` 按 `oldText` 定位（一字不差、在底稿里唯一、一组全成或全不成、各处不许重叠），
**不用行号也不用字符位置**——模型看不见自己写过的代码的行号与偏移，让它数是在让它做最不擅长的事。
同理，诊断一律带**代码帧**：出错那一行连同一个插字符摆出来，它一眼知道改哪儿。

文件内容这类大字符串走 `blobs` 不进源码：进了就要过三层转义（JSON → 字符串字面量 → 内容本身），
反引号、`${`、反斜杠、引号全是雷。走 `blobs` 只有一层。

**回给模型的东西总量有上限**，每条通道都算（导出的值、日志、插手记录、失败说明、执行账、诊断），
整份结果再过一道 `resultChars` 硬闸。能力读回来的正文落在脚本的变量里，模型看不到——
除非脚本自己交出来，而交出来的也不超过这个数。

## 依赖什么

`typescript`（检查与手滑那条路的剥类型）、`@velaros-ai/core`、`@velaros-ai/path-rules`（打标记时按 .gitignore 与默认跳过的目录名判哪些不算）；
门的工具用 `@velaros-ai/tool-contract`（定义工具、渲染说明、挂进内核）、`@velaros-ai/kernel`（内核模块与能力令牌）与 `zod`（入参 schema）。
能力端口、门、空间、时间线的位置与事件槽由宿主注入。

## 状态归谁

一段脚本一个隔离进程，跑完即销毁。门里有两样状态：每个会话导入过的模块、退租过的模块（按会话记、有总数上限，会话结束由宿主调 `forget` 清掉）；
开着的时间线（按目录记、有总数上限，丢了下次从磁盘读）。**时间线属于空间**：落在宿主给的目录里，跨会话、跨重启都在，
脚本库、每一步的记录与工作区标记都在里面；同一条时间线上的 exec 排队做。

## 生命周期

`exec` 是一次性的：进去几步，出来一份回执与每一步的结果；中止靠传进来的 `signal`，每段脚本的超时由 `timeoutMs` 兜底。
脚本被中止或失败时，已经做完的步骤照样记着，这一步跑过的副作用照样扫进标记。

## 失败语义

错误码见 `contract/constants.ts`：`PROGRAM_ERROR`、`TIMEOUT`、`ABORTED`、`RUNNER_CRASHED`、
`UNKNOWN_OPERATION`、`TOO_LARGE`、`EDIT_FAILED`、`OPERATION_FAILED`、`CHECK_FAILED`、`MODULES_NEEDED`、`REF_NOT_FOUND`、`INVALID_STEP`、`REPLAY_MISMATCH`。
exec 里某一步没成时回执说清楚是哪一步、为什么，后面的步骤不做。typecheck 没过时回的是诊断而不是结果——代码一行都没有执行。
能力端口报的错在脚本里是一个**能 try/catch 的异常**，不是静默的空回执。

## 不变量

共 34 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 33 条、门禁 1 条。未验证 0 条。

## 非目标

- **不判断某次调用危不危险**：那是能力端口的事，门必须下沉到那里——代码块里几十条语句不是一个可审查单元。
- **不存工作区文件的内容，也不替模型回退工作区**：时间线只有哈希，写不回旧内容。它告诉模型每一步改了哪些文件、
  改前是什么哈希，撤回靠已有的手段（`velar:project` 的 undo、git、模型照原脚本写反向改动），撤完用 `script:diff` 核对到没到。
  重放是把脚本再跑一遍，脚本里的外部动作（命令、网络）也会再做一遍。
- **系统空间不打标记**：整个磁盘扫不了，那里只记操作（每一步的代码、参数、结果与调过的能力），不记文件改动，重放也不核对文件。
- **`nodeSubprocessCodeRunner` 不是可发版的隔离**：它挡得住读写文件与起子进程（实测 `ERR_ACCESS_DENIED`），
  **挡不住网络**，Node 的权限模型不覆盖 socket。正式版换 WASM 里的 QuickJS。`NodeSubprocessRunnerIsReleaseReady` 恒为 `false`，宿主装配时据此拦下。
- **不生成能力声明**：声明由能力包那一侧从源码生成，本包只负责按给定的声明检查与执行。

## 结构

```
src/
  contract/   constants.ts 错误码、工具名、步骤种类与对外上限；provides.ts 交出去的接口；requires.ts 宿主注入的能力端口、时间线的位置与事件槽
  types/      code-surface.ts 可移植数据（脚本、诊断、结果、一步改了的文件）；module-form.ts 改写的切片；
              editing.ts 编辑落到原文后的形状与逐行比较的编辑脚本；runner.ts 隔离运行器的形状；gate.ts 四个工具与门的入参、回执与会话状态；
              timeline.ts 时间线日志、脚本版本、引用与标记的形状
  impl/       CodeSurfaceTools.ts 门在模型面上的四个工具与内核模块（工具文件）；CodeProgramGate 模型写脚本的那扇门；
              ScriptExecution 办一次 exec；ScriptTimelineViews 读时间线（history、show、diff）；CodeSurfaceSession 办一段脚本；
              ScriptTimeline 一个空间的时间线；CodeProgramChecker 执行前的检查；NodeSubprocessCodeRunner 开发期隔离；WorkspaceMarkers 工作区标记；
              CapabilityOperationPort 操作表接成能力端口；TimelineStorage 时间线落盘
  utils/      compiler.ts 编译器那一侧的活；module-form.ts 挖 import 与租约、改写成隔离能跑的形状；
              edit.ts 在底稿上改；diagnostics.ts 带代码帧的诊断；gate.ts 门给模型的说明与回执、写成工具结果；tool.ts 定义门的工具；
              result.ts 判体量与编结果；budget.ts 预算裁剪；program.ts 包装；node-executable.ts 找一个真的 node；
              refs.ts 时间线上的引用与脚本路径；calls.ts 调用账；markers.ts 哈希与目录树；line-diff.ts 逐行差量；replay.ts 重放核对；
              timeline.ts 时间线记录的判断与挑拣；timeline-text.ts 时间线写成文字；fs.ts 原子写入；tuning.ts 可调参数
bin/          code-surface-child.mjs 隔离进程侧引导，自身不引任何模块
```
