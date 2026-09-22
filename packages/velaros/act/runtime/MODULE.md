# Act 共享运行时

## 这是什么

把 Agent Loop、ScriptAct、Kernel、ContextStorage 和 ModelDriver 组合成同一执行链。模型自管理操作集中在 system；Runtime 负责会话机制，search 和 agents 提供按需配置的任务能力。

## 提供什么

`createProjectCapabilityModule` / `ProjectCapabilityModuleOptions`：项目能力与真实资源版本的统一装配。

- `ContextMaintenanceOptions`：独立整理模型和可配置档位。

系统模块装配：`modulesModule`、`ModulesHost`、`ModulesModuleApi`。记忆装配接口从 `./act/system` 提供。

入口 `.` 提供宿主会话装配，`./contracts` 提供数据合同，`./renderer` 提供浏览器安全事件投影。

导出的值：`createEventDelivery`, `createRuntime`, `createCapabilityModule`, `createShellCapabilityModule`, `createMcpModule`, `createMcpClientConnection`, `createActEventProjector`, `McpLimits`, `ScriptLeaseLimits`, `VelarosRunLimits`, `VelarosRuntimeContract`。

产品及注入接口：`EventDeliveryApi`, `EventDeliveryOptions`, `CapabilityContext`, `CapabilityModuleOptions`, `VelarosContextOptions`, `VelarosRuntimeOptions`, `RuntimeModelConfiguration`, `ShellCapabilityModuleOptions`, `VelarosSearchOptions`, `McpAuthorizationProvider`, `McpConnectionSpec`, `McpConnectionOptions`, `AgentProfile`, `VelarosAgentsOptions`, `McpModuleOptions`, `VelarosRuntime`, `VelarosSession`, `McpClientConnectionApi`, `ActEventProjectorApi`。

`VelarosSession.listNotes/readNote/setNoteResident` 提供同一工作笔记的宿主目录、分页正文和版本化驻留控制。数据合同为 `WorkspaceEntry`、`RuntimeNoteRead`、`RuntimeNoteRetention`、`RuntimeNoteContent`。

`VelarosSession.getGoal/updateGoal/controlGoal` 维护跨执行的会话目标，数据为 `GoalState`、`GoalStatus`、`GoalUpdate`、`GoalControl`。目标通过共享存储 CAS 追加历史；完成回复不能自动完成目标，活动目标需显式结算。

## 骨干链路

ComposedRuntime 注入端口 → SystemModules 装配自身管理能力，StandardModules 合并任务服务 → Kernel 注册。
RuntimeSession 接受模型响应 → ScriptTurnDecoder 解析 → ProgramContext 保存与检查 → 共享 Script 执行器调用 Kernel → 回执和租约 → ContextMemory 组装 task/workspace/observation/recent/runtime 五分区 → ModelDriver。
search 单元的 AdvancedSearch 复用同一 RuntimeSession；SearchActivation 负责搜索预算、证据校验与软收尾。

## 依赖什么

Agent 的循环与子任务调度、Script 的校验与隔离执行、Kernel 的注册和权限、Context 的可靠存储与证据访问、Model 的 ProviderRequestCompiler。配置统一从 contract/requires.ts 注入。

## 状态归谁

运行状态、源码版本、笔记、结果租约与原始材料保存在现有 ContextStorage。Kernel journal 记录调用事实。每个 RuntimeSession 持有自己的分区投影与进度。

## 生命周期

await createRuntime → openSession → submit/script → close。搜索和子任务结算后释放父预算；关闭会话取消在途调用，再释放绑定与存储。

## 失败语义

完整响应预检失败不派发；正式工作回合缺少控制决策时有界修复，需要用户回答走交互请求，在途后台任务可等待；驱动确认的瞬时模型连接故障在接受响应前有界重试，每次尝试单独归档和计费。未决效果通过 reconcile 核对；取消和恢复沿持久回执收束。超窗进行有界整理，无法满足基础预算时明确反馈。

## 不变量

共 48 条，未验证 0 条。这里统计确定性验收映射；真实任务结果另见交付报告。登记表保留原有行为承诺，并指向实际执行它们的测试文件。

## 非目标

运行时的能力边界由具体模块端口、隔离执行器和 Kernel 的当前授权决定。

## 结构

```text
runtime/
  contract/ provides.ts、requires.ts、constants.ts
  types/ 运行、协议、分区投影与追踪数据
  impl/ 会话装配、协议解析、分区和执行协调
  utils/ 纯计算、schema 共用构造与调节参数
  invariants.md
  test/ 主干集成验收、Provider 与 MCP
  index.ts
  contracts.ts
  renderer.ts
```

## 长期记忆装配

`VelarosRuntimeOptions.memory(sessionId)` 为主会话返回 `createMemoryStore({root}).scope(scope)`。Runtime 打开主会话时固定端口，将 recall/save/remove 合入 `velaros:system.memory` 的实际合同。搜索、整理和业务子任务使用其角色对应的合同；需要的记忆正文可由主线召回为材料后显式分享。长期记忆的文件、索引和生命周期归已有 memory 单元，工作笔记、结果租约与整理仍由当前会话链管理。

## 多空间共享与通知

ContextStorage.stores 支持持久空间。主线默认在 session:<id> 的宿主边界内创建和使用自己的 store；VelarosRuntimeOptions.stores(sessionId) 可以配置 scope、create 和 grants，返回 undefined 关闭能力。跨主线共享由宿主提供相同 scope 及具体授权。主线通过 agents.start 的 stores 数组显式向子任务共享 StoreGrant，AgentProfile.stores=false 可关闭此能力。子任务没有创建权限，续跑重新检查父授权。搜索和整理保持专项合同。

runtime.stores 提供目录第一页和各空间的有界变化，所有空间共用每帧额度并轮换交付。响应被接受后确认对应的各空间序号。活动运行等待后台执行或子任务时也等待相关变化，先到者推进下一轮；关闭与取消释放其余监听。已结束运行由宿主再次 submit。

## 开箱配置

`await createRuntime({workspace, dataDir, model})` 内部装配现有 Project、ContextStorage、Script 执行器和 Provider 驱动。workspace 为已有绝对目录，dataDir 为工作区之外的状态目录。model 既可传现有 ModelDriver，也可传 `{provider, model, baseURL, apiKey, reasoningLevel?, limits?}`。输入、输出与总窗口是宿主采用的运行预算，需按实际服务配置。

首次 openSession 通过 ContextStorage 原子绑定会话 ID 与工作区真实路径；重开及并发打开必须匹配，未指定工作区也形成固定绑定。`project:false` 保留绑定，只关闭默认项目能力与项目证据源；宿主显式注入模块的范围仍由宿主负责。已有 dataDir/workspace.json 会先核对再迁入会话存储，损坏或不匹配拒绝激活；没有历史绑定的会话按首次打开时的 workspace 建立绑定。

工作区预设默认提供 `worker` 子任务、`standard` 搜索档位和按工作区绑定的长期记忆；可用 agents/search/memory=false 关闭。已注入 storage/runner/modules/model 的专用装配仅开启显式配置的模型工具。主模型和支线共用原有 ProviderRequestCompiler、权限检查与可靠存储。

调用 createRuntime 成功后，Runtime 接管存储连接，在 runtime.close 时释放；初始化失败时仅关闭框架新建的连接。session.close 只关闭该会话并撤回缓存，之后 openSession 相同 ID 恢复持久数据。直接调用宿主 script/execute 时先登记用户目标；通常 session.submit 会完成目标归档。


## 持久追踪

`runtime.trace(rootSessionId, {sessionId?,after?,limit?,maxChars?})` 查询原始上下文、回复、脚本和调用回执，并返回根当前任务的 branches 目录。支线由同一根的持久归属记录验证，关闭后仍可查看；读取不会发起模型调用。after 是模型请求记录序号，nextAfter 非空时继续分页；正文按本页共用的 maxChars 截断。运行中的回合应重读，以取得后来发生的响应与效果。精确到某一请求仍可使用 session.trace(turnId)。

## 宿主展示投影

`createActEventProjector` 的 apply 消费持久 ActEvent 并按游标去重；applyLive 消费有序实时 ActRunEvent，文本增量只改变预览，不推进持久游标；正式正文按 turnId 去重。finish 在交付结束时清除未接纳预览并封闭当前实时投影，重新消费时创建新投影器。Desktop 等宿主只映射产品消息身份和 UI，不维护正文接纳规则。

## 宿主可靠交付

createEventDelivery 接收宿主持久化与传输端口，冻结输入并允许持久化合批，交付严格保持 append 顺序。flush 等待调用前的全部事件，close 同时封口。持久化或传输失败后，已在途写入仍被排空，后续回执不再交付；原始错误经 append/flush/close 保留。宿主负责持久日志的序号、回放与权威快照确认后的裁剪；传输成功不等于用户已读或产品快照已保存。


## 效果调度与诊断

`effectResources(invocation)` 由宿主声明操作完整的冲突资源身份，包括读写依赖和别名。默认返回 undefined，与所有效果操作互斥；非空集合仅在与先前操作无交集时并行。跨模块共享同一真实资源必须使用相同身份；未知范围是全局屏障。调度不替代权限、决策版本检查或领域跨进程锁；正在执行的处理器实际结束后才释放。

`onMetric` 接收 RuntimeMetric：ContextStorage 方法、效果等待和效果运行的单调时钟耗时，包含会话/执行身份，不包含正文、参数或路径。回调应快速返回；异常和异步拒绝不改变业务结果。StoreStorage 内部操作不单独采样。阶段可以嵌套，聚合总和不是任务墙钟时间。

ActTurnTrace.timing 返回本业务轮的 observationMs/contextMs 和本次请求的 modelMs/firstTextMs；准备耗时只出现在 repair=0 的尝试。模型耗时包含流消费方处理与背压；首文本耗时在收到第一段非空文本时记录。旧记录缺失计量时为 null。脚本结果的 timing.durationMs 覆盖执行器和工具报告，结束后的归档不包含在内。trace 单页复用状态快照，调用日志按关联 executionId 查询；调用回执仍可能继续结算，读取不会暂停执行。

## 主会话产品指令

VelarosRuntimeOptions.instructions 接受宿主可信的产品规则，例如身份、用户界面语言和当前产品模式。指令追加到主会话运行说明，与协议、实际材料一起估算预算并归档；不能作为模块授权。专项模型工具使用自己的职责说明，不继承该产品指令。重建运行时可应用新的设置，历史请求保留原值；应由宿主构造，用户输入及文件正文仍走输入材料。

## 运行展示状态

ActPresentation.runs 的 ActRunPresentation 包含唯一回合计数、运行状态、error 失败原因以及 queuedInputIds/retainedInputIds。输入消费按归档引用区分，宿主关联身份仅在展示时去重；主输入只在明确保留后进入待处理列表。终态与交付结束不能推断输入已被消费或保留。Desktop 等消费者直接映射此快照；交互回答、确认权限仍由实际 Runtime 校验。

## 执行记录展示

`ActInvocationSummary` 随 `ActTurnTrace.invocations[].summary` 返回模块、操作、原始回执状态及独立的效果状态。参数最多 2000 字符、结果最多 6000 字符，均计入单次和分页追踪的 maxChars 总正文预算；截断明确标记。缺少回执时保持 pending，核对事实不会改写原始回执。宿主按调用身份更新展示，历史仍来自持久调用记录。

程序状态、版本和控制回执优先通过 ContextStorage.selectSnapshot 读取同一版本的元数据与相关目录；程序多记录发布与租约采用增量 CAS。笔记目录、更新和帧确认使用指定记录；多次查询的授权资料必须匹配同一版本。扩展不足时使用完整快照/CAS。混合材料目录保持完整快照路径。笔记目录在数据库中按标题取最新，旧版本读取按引用补选；脚本投影目录按结果后缀收窄。历史检查点选择旧检查点、重置、最近两次响应、目标序号和证据，再以同一版本增量提交；适配器缺少组合能力时继续完整 CAS。程序帧将租约、重置、摘要、图像和子任务记录合并为一次一致读取；笔记帧选择笔记、策略、交付与脚本目录；历史帧选择响应、脚本、检查点、重置及最后记录，保持原有授权与来源排序。

## 封存请求展示

`ActRequestSummary` 随 `ActTurnTrace.requestSummary` 返回模型身份、完整请求指纹、输入计量与输出预算，以及有界系统指令和消息文本。历史缺少封存请求时返回 null；封存不等于供应商已接收。媒体以占位代替，系统指令和消息分别最多 8000/24000 字符，并计入 trace 的 maxChars 总正文预算。

RecentContext 按不可变 objectId 缓存是否为观察输出，最多 4096 项，仅保存身份和布尔分类。每次投影重新读取授权边界；重置换代清空分类，缺失正文不缓存，容量用尽后新条目直接读取。关闭历史窗口时跳过结果分类；历史目录发现仍包含全部可召回结果，实际历史正文继续省略观察输出。
