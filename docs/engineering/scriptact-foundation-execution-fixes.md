# ScriptAct 根基修复：执行合同差量

日期：2026-09-30。范围：审核 F01、F05 通用生命周期、F10 Kernel 模式一致性；另为 F12 提供真实调用阶段证据。证据目录：`.velaros-workspace/bench/foundation-fixes-53/execution/`。保留开始前的全部 WIP；没有模型请求、外部能力调用、提交或推送。

## 结果

| 审核项 | 交付行为 | 状态 |
| --- | --- | --- |
| F01 | QuickJS 原生链接 ES 模块，保留 live binding、静态依赖顺序、循环链接、TLA 与模块单次初始化 | 已实现，原红例与新增跨形状用例通过 |
| F05 | 调用方取消与真实任务收束分离；关闭有界报告 pending，后台保留资源及真实回执；完整 Runtime 关闭覆盖会话阶段 | 已实现，挂起、迟到提交、锁、持久化失败反例通过 |
| F10 | allowedModes 与生成合同按有效集合核对；装配拒绝非法集合 | 已实现，分歧及等价集合用例通过 |
| F12 证据支持 | 最终 InvocationReceipt.lifecycle 记录 Kernel 进入及回执生成事实 | 已实现，由测量主线消费 |

## F01：直接使用原生模块系统

`CodeSurfaceSession` 将 JavaScript 作为原生 ES 模块交给运行器：已经识别为 TypeScript 语法的源码先剥类型，namespace 重导出通过下文的独立桥模块兼容 QuickJS。`ScriptWorker` 使用 QuickJS `setModuleLoader` 与 `evalCode(...,{type:'module'})` 装载本次提供的主程序、附属模块及授权能力的合成模块。规范化路径形成缓存身份，相对路径从主程序 path 或当前附属模块解析。

能力合成模块继续使用既有 RPC 能力表。loader 只接受本次提供的附属模块、已授权模块及实际配置的虚拟包。主程序和附属模块没有 import/export 文本重写，原始模块文件名与源码行号直接用于诊断。

内部入口模块只把主程序 namespace 放进一个普通导出字段，再等待其模块求值。这样同步和顶层 await 程序导出的 `then` 都不会被宿主 Promise 桥误当成 thenable；这是一处在真实 QuickJS API 上额外复现并修复的边界。

返回合同保持原有形状：仅 default 则返回该值；具名导出返回导出对象；无导出则无值；显式 output 继续使用既有输出通道。模块 namespace 采用标准只读绑定和不可扩展语义，程序 input/blobs 仍递归冻结。

合同影响：

- `CodeRunRequest.source/modules` 现在传递原生 ES 模块，新增可选 `path`。使用自定义 CodeRunner 的宿主需要遵守此合同；默认 Node/QuickJS 路径已迁移。
- INV-27 的 namespace 断言改为验证 `!Object.isExtensible(namespace)`、`Reflect.set` 拒绝赋值和数据深冻结。原生 module namespace 的 `Object.isFrozen` 不是只读绑定的等价判据。
- 删除仅服务于旧实现的 `rewriteModuleForIsolate` 与内部 `ProgramRewrite` 类型；原先断言重写文本的 5 个测试由 8 个端到端语言语义测试及静态依赖读取测试覆盖。

验证包括具名与 namespace/re-export live binding、静态 import 提前求值、循环依赖、附属 TLA、模块只初始化一次、主程序自定义路径、default 函数名字，以及同步/TLA 的 then 导出。既有权限边界、隔离、CPU/墙钟、TS 容错、源码行号和进程回收验收仍通过。

## F05：取消观察者，真实执行继续受监管

`OperationRuntime.invoke` 维护两条 Promise：真实 dispatch 与调用方的观察等待。signal 取消会结束观察者；真实 dispatch 仍保留在途身份、阶段、资源与日志。prepare 获得兼容原单参实现的第二参数 `{signal}`，prepare 与 beforeDispatch 实际返回后都会复查取消，因此迟到准备结果不能继续进入 handler。

挂起的 prepare/beforeDispatch 保持 reserved；进入处理器后的挂起保持 prepared。它们不会因为调用方取消而提前写入 settled/cancelled/none。真实处理器返回后才保存实际 effect，迟到 committed/partial 仍保留；同步准备/授权抛错才保存确定的 none。领域 reconcile 同样保留真实未收束 Promise，避免取消观察后提前回收其模块资源。

`pending()` 返回冻结快照，只有调用身份、模块/操作、阶段与 cancelRequested，不包含输入、模型内容或完整请求。阶段覆盖 start、journal、prepare、beforeDispatch、handler、settle、reconcile。读取原始待核对记录期间，reconcile 的 executionId/moduleId 尚未知时为空串。

关闭合同：

- `OperationRuntime.dispose({timeoutMs?})` 与 `VelarosRuntime.close({timeoutMs?})` 默认等待 5000 ms，可设非负有限观察期限。
- 等待到期抛出 `AppError('TIMEOUT')`，携带只读 pending；Runtime 还携带 openings/sessions/modules/storage 阶段。
- 关闭开始后持续拒绝新调用/会话。默认关闭的观察超时不会释放仍在使用的模块或存储，后台会在真实收束后清理。
- Kernel 的 `drain()` 明确表示等待真实关闭，不承诺有界；Runtime 后台关闭链使用它，以保证模块/回执收束后才关闭存储。再次调用 close 可观察最终收束结果。
- Runtime 对现有会话同时发起关闭，整体观察期限覆盖尚未完成的 opening、会话关闭以及后续 Kernel/存储阶段。
- journal.settle 失败会保留原 prepared/reserved 意图，向调用方传播错误；即使调用方已经取消，关闭仍报告持久化失败，不宣称回执已保存。处理器确已结束后可以回收资源，由持久意图支持后续恢复核对。

既有 `withEffectGate` 与 `EffectScheduler` 的真实处理器 finally 释放规则保留。集成测试证明：第一个写操作忽略取消、仍持有锁时，第二个冲突写入无法进入；第一个真正返回后第二个才能执行。没有在 handler Promise 外做超时 race 后释放锁。

边界：这套合同不物理终止宿主进程内任意 Promise，也不抢占堵塞 JavaScript 事件循环的同步代码。无取消信号的单次能力仍由领域/宿主设置截止时间；可以使用带期限的 AbortSignal。永久不合作的适配器会永久保留冲突资源，关闭明确报告该事实；需要物理终止的能力必须由宿主提供可终止的执行单元。这里不自动重放可能已提交的操作。

## F10：模式与同源合同一致

Kernel 对生成 surface 和实际挂载 operation 的 input/output/effects/allowedModes 一起核验。allowedModes 省略等价于 `{execute,observe}`，不同排列但相同集合等价；空、重复或非法模式集合在装配期拒绝。生成 execute-only 合同却挂载全模式或 observe-only 的情况会报 INVARIANT。

这不会改变 ComposedRuntime 正常从生成 descriptor 扩展处理器的路径；它封住公开手工 OperationModuleDefinition 可能出现的权限漂移。

## F12：真实执行证据

最终 `InvocationReceipt` 可带可选 `lifecycle`：

| 字段 | 含义 |
| --- | --- |
| reservedAt | 当前调用取得持久化意图后的时刻 |
| preparedAt | 准备参数持久化完成的时刻；未完成则省略 |
| startedAt | 通用 Kernel 调用适配器进入 run/observe 的时刻；包含 Runtime 效果门排队，不是领域物理副作用起点 |
| settledAt | 真实处理器/准备失败收束后，最终回执生成的时刻；只有 journal.settle 成功才作为已保存回执返回 |

字段均为 ISO 时间，身份使用原有 `receipt.invocation.id/sessionId/executionId`。成功、处理器抛错、输出校验失败和确定的准备失败均保存相应证据。旧记录没有 lifecycle 时，消费端应表达 unknown，不能由 pending/脚本最终状态推断 handler 已执行。settledAt 不测量持久化写入的耗时。

## 验证与证据

| 核验 | 结果 | 日志 |
| --- | --- | --- |
| 首批 6 组 ESM 旧行为 | 2 通过 / 4 失败，保留原红例 | `esm-red.log` |
| Kernel 原生命周期与模式反例 | 原测试失败，保留红例 | `kernel-red.log` |
| 完整 Runtime 原关闭 | 两例均超过看门狗，未给出 TIMEOUT | `runtime-red.log` |
| 原生模块专项 | 8 通过 | `esm-green.log` |
| script 验收、utils、进程与模块语义 | 79 通过 / 0 失败 | `script-green.log` |
| kernel 验收、诊断与生命周期 | 25 通过 / 0 失败 | `kernel-green.log` |
| agent 既有验收 | 28 通过 / 0 失败 | `agent-green.log` |
| runtime 生命周期、效果调度、子任务 | 23 通过 / 0 失败 | `runtime-green.log` |
| kernel/script 本包 typecheck | 通过 | `kernel-typecheck.log`、`script-typecheck.log` |
| script 本包 build、kernel TS 构建 | 通过 | `script-build.log`、`kernel-build.log` |

Runtime 的聚焦集成阶段只将本次 ComposedRuntime 源码转译到其 ignored dist 文件，避免与其他并行工作的全包构建争用；全拓扑构建、统一生成、格式和所有权门禁由主线程在合并状态上执行。测试没有发出模型请求、真实桌面输入或外网能力调用。

新增公开类型 `PendingInvocation`、`OperationRuntimeCloseOptions` 经 kernel 根入口/contracts 及 runtime 入口导出；没有新增 impl 文件或 layers 登记。新增测试已登记本包测试命令或 runtime 通配测试目录。更新 kernel/script/runtime 的不变量。Agent 与 EffectScheduler 的实现沿用既有职责，相关验收用于证明共同主干没有分叉。

## 领域交叉复核后的文件取消边界

进一步复核证明：本机文件端口原来的调用前取消检查不足以覆盖临时文件写入、fsync 与最终字节核对之间的异步准备。取消在这些阶段发生时，目标文件尚未变化，底层仍可能继续 rename 或 unlink。隔离 Node 子进程的反例钩住真实临时文件句柄的 fsync，以及删除前字节核对句柄的 close；修复前两例失败，rename 完成后取消仍成功的反例通过。

`TextFileIoApi.writeBytes` 和 `writeText` 的 options 增加可选 `signal?: AbortSignal`，经原有 `@velaros-ai/core/text-files` 入口及 `contract/provides.ts` 登记的接口可达，不新增导出类型或子路径，旧调用兼容。底层在开始、异步字节准备完成后和所有准备完成的最终 rename 前核对信号，失败按既有 finally 清理临时文件。files 的 `writeFileAtomically` / `removeFileChecked` 内部函数增加可选 signal 参数，由 `LocalFilePort.commit` 继续转交宿主信号；删除在 awaited 字节核对完成后、真正 unlink 前再查取消。

取消发生在 rename 完成之后，写入仍返回成功，端口记录实际 applied；不把已发生的提交改写成无效果取消。这里保证的是发出文件系统提交请求前的取消检查，不能撤回已经交给操作系统的 rename/unlink。新增 core/text-files INV-8 登记该合同。已有 files 端口的可选 signal 合同与实际底层提交边界保持一致。

新增 `files/test/atomic-cancel.test.ts` 与 `atomic-cancel.fixture.mjs` 在独立 Node 进程执行三种实际文件系统边界，不改变生产实现、全局测试进程或模块分发；core 的实现测试另覆盖 writeBytes/writeText 信号转交和异步准备期间取消。测试同时核对目标字节、已提交列表及临时文件清理。

- `files-atomic-red.log`：2 失败 / 1 通过。
- `files-atomic-green.log`：core/text-files 验收和实现测试、files 基础安全测试与原子取消测试全部通过，83 通过 / 0 失败。
- `core-typecheck.log`：通过。
- `style-final.log`：本轮 Kernel/Script 和新增 core/files 范围零 baseline 代码规范检查通过。Kernel 诊断对象保持 truncated 键缺席语义；输出存档注释改成中文，不改变执行行为。

本次聚焦验证把四个新增改动的 core/files 源文件转译到 ignored dist，以测试实际 Node ESM 导入链；全拓扑构建及最终发布声明由主线程统一重建。新增 API 使用内联 options 与标准 AbortSignal，没有增加公共类型漏导出或 impl 分层登记。

## 集成验收对齐

Context 的持久化故障测试曾在注入 journal.settle 失败后把 `dispose()` 成功作为默认预期，与 F05 关闭时必须报告持久化失败的合同不一致。测试现明确核对 AggregateError 包含同一个注入错误；关闭后持久意图仍是 prepared 且没有 receipt，另一 Runtime 拒绝自动重放同一身份，写入次数保持不变，意图记录也保持原样。没有吞掉关闭错误或改变生产关闭逻辑。`context-integration-final.log`：3 通过 / 0 失败。

core/text-files INV-8 的两个测试标题补齐不变量编号；core package.json 对该测试增加显式路径登记，同时保留原测试目录发现。严格所有权门禁仍逐文件核对执行登记与编号，不修改门禁规则。`core-invariant-final.log`：26 通过 / 0 失败，目录与显式文件并存没有重复执行用例。

`ownership-final.log`：整仓 `check:module-ownership` 通过，包含 core/text-files INV-8。

## 持久记忆的读取结果与写入输入

集成验收暴露旧示例把 recall 返回值展开回 save：新增 revision 连同 updatedAt 都是输出元数据，不属于 MemorySaveInput，严格输入 schema 因而拒绝。SystemMemoryOperations 原本已经共用领域 MemorySaveInput、MemorySaved、MemoryIdInput，当前生成合同也包含版本字段；问题发生在示例/测试的输入映射。

领域 MemoryOperations 的 AgentView、memory/template.js，以及 system 持久记忆的 AgentView/模板现在明确先剔除 revision、updatedAt，再把 revision 作为 expectedRevision。主线保存/删除模板使用读到的版本；null 要求目标不存在。没有让 schema 接受输出元数据。公共类型和入口保持不变。

两种主线装配（有整理模型、无整理模型）的新增公开回归覆盖 null 新建、版本返回、条件更新、重复新建与过期 save/remove 拒绝、目标正文保持、按当前版本删除、已不存在时的条件删除，并核对原始调用日志。它们还发现 MemoryModule 对领域新增 CONFLICT 未作写前失败分类：红例均在 journal effect 应为 none 的断言失败，证据 `memory-cas-red.log`。新增分类以领域写锁/版本核对在提交前拒绝的合同为依据，保留实际错误码和严格输入校验；后续生成构建与绿色验收由统一集成结果补齐。

## 声明生成器保留注释和全部操作

最终全量 Runtime 验证中，新增两种持久记忆 CAS 用例均通过；剩余两个失败来自模板类型检查。调用示例中的 `save(...)` 暴露了生成器 `renderMethod` 的通用缺陷：原先按方法名字串切分源码来取注释，注释先出现同名调用时会截断 JSDoc，后面的函数声明被吞进注释；另一个 JSDoc 的结束标记可使整体仍语法合法，单纯编译生成声明无法发现漏导出。

`scripts/script/generate-declarations.mjs` 现在复用根据 AST 节点前导区间提取的 docComment，完整保留示例；生成每个能力声明后再解析其 AST，将实际函数导出名及重复数量与源接口收集的操作集合核对。两者不一致直接生成失败，不允许静默发布缺少操作的声明。

新增 `scripts/script/generate-declarations.test.mjs` 构造独立临时仓库，执行真实生成器 CLI；源接口包含单行/多行同名调用示例和换行的方法签名。旧生成器只导出 describe，丢失 save/remove（`generator-comments-red.log`）；修复后全部导出与源接口一致，注释示例也保留（`generator-comments-green.log`）。该回归已加入根 check:script，未手改生成物或放宽模板类型检查。scoped ESLint 通过，统一生成/构建和最终 Runtime 复验由主线程执行。

## 集成追加：QuickJS namespace 重导出

真实系统包测试发现当前 QuickJS 对 `export * as name from ...` 的 namespace 别名允许赋值。裸引擎两形式对照复现：普通 import/export 的别名只读，namespace 重导出却可被替换。Script 按 AST 把用户模块的该节点替换为 `export { default as name } from './桥路径.js'`；独立虚拟桥模块用 `import * as value from 原目标; export { value as default }` 转交同一个 namespace。用户词法域不增加局部变量，direct eval 的可见绑定保持原样。

桥路径避开主程序、用户附属模块和已分配桥路径；原相对目标通过既有 resolveLibraryImport 解析为库内身份，桥从库根引用它，用户模块按自身目录重导出桥。桥只转交原语句目标，授权预检与 Worker 加载表继续约束可访问模块。循环、live binding、TLA 与单次初始化仍由引擎处理；替换保留后续源码行号。合成能力包本身继续生成原生 namespace import 加具名 export。

原 11 个 namespace/模块用例全部保留，并新增主/附属模块 direct eval 不可见、桥路径碰撞与深层相对路径、桥与循环/TLA/namespace identity，以及授权能力只初始化原目标且未授权重导出仍被预检拒绝。桥修复前 13 通过 / 2 失败，失败为新增词法绑定被 eval 观察；修复后 16 通过 / 0 失败。ESM namespace 的承诺是只读绑定与不可扩展，不用 `Object.isFrozen` 判断；内部普通数据对象仍遵循自身冻结合同。

证据：`execution/namespace-reexport-red.log`、`execution/namespace-reexport-green.log`、`context/namespace-probe.jsonl`、`execution/namespace-bridge-red.log`、`execution/namespace-bridge-green.log`。桥实现的源码测试、script typecheck、scoped ESLint、37 项零 baseline 规范检查均通过；本轮未构建或写入 dist，主线程统一进行增量构建及完整 Script/Runtime 验证。
