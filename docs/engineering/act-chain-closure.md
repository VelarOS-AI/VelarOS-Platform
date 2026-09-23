# Act 全链路闭合与契约差量

本轮交付使用同一套 Agent Loop、ScriptAct、Kernel、ContextStorage 和 ProviderRequestCompiler，完成从观察、决策、写入、结果租约、整理、支线交付到完成及核对恢复的接入。真实 Provider 评测按用户安排在后续轮次执行。

## 实施与验收矩阵

| 项 | 实际接入 | 验收证据 | 状态 |
| --- | --- | --- | --- |
| 观察依据 | Kernel 签发读取版本，实际投递帧固定决策依据，外部写门及完成再次检查；Project 装配提供真实文件和查询版本 | `decision-basis.test.mjs`：外界变更阻止写入、伪造/撤权/换代、同脚本有序写、真实 Project 文件修改 | 已实现 |
| 最低上下文 | `output(...,{key,required:true})`；整理候选先组装、编译预检再 CAS | `decision-basis`、`output-context`、`context-maintenance`：必需观察/租约结果、输入约束、取消与原子拒绝 | 已实现 |
| 任务边界 | session 保管归档，taskId 固定逻辑任务及总账，runId 标记一次推进；continue/new 明确区分 | `task-lifecycle`、`model-tools`：继承、切换、配额与未知效果 | 已实现 |
| 观察恢复 | 健康状态持久化、部分结果、成功引用、连续失败暂停、源码修复恢复；防护范围和操作收束独立 | `task-lifecycle`、原有 shell 与输出测试：普通失败、重启、未知效果不重跑 | 已实现 |
| 完成恢复 | repair/refresh/reconcile/input/capacity；拒绝原因进入下一轮，修复有界；子任务未知效果向主线传播 | `completion-recovery`、`act-children`：拒绝后继续、重复失败停止、主子任务核对恢复与孤立占位 | 已实现 |
| 支线交付 | 搜索、子任务、整理共用 ModelToolDelivery；报告、证据、源码及继续入口按引用交付 | `advanced-search`、`model-tools`、`context-maintenance`：可读清单、来源指纹、调用者权限、叶子能力隐藏 | 已实现 |
| 长期持久化 | SQLite 记录索引与分页、任务归档、孤立对象回收保护；子结果只内嵌有界事件尾部 | `storage-index.test.mjs`、Agent acceptance：旧库迁移、跨连接 CAS、1200 条记录、日志读取、1000 个子事件 | 已实现 |
| 评测接入 | 正式 Runtime 的受控驱动闭环、完整追踪与独立文件判据；保留现有真实 Provider CLI | `scripts/agent/act-eval.test.mjs`；40 轮业务压力及完整机制回归 | 确定性验证已接入；真实模型评测安排在下一轮 |

测试文件除显式路径外位于 `packages/velaros/act/runtime/test/`。最终运行结果见文末。

## 当前执行链

1. `RuntimeSession.submit` 归档用户输入，`ActRunService` / `ContextViewSession.begin` 固定任务身份和运行租约。continue 沿用目标、笔记与任务总预算；new 归档上一任务并切换观察、笔记、结果及子任务配额。活动或效果待核对的子任务阻止切换。
2. 正常业务轮刷新当前 observe。Script 先验证源码，再通过隔离运行器调用 Kernel；Kernel 留下真实回执、附件、资源版本及观察收束信息。每次实际执行另有持久执行身份，便于任务边界和中断核对。
3. `ProgramContext` 组装当前观察与仍有效的结果租约，`RecentContext` 编排近期历史，`ContextMemory` 组装 task/workspace/observation/recent/runtime。历史和结果只传一份正文；引用保留召回位置。`runtime.decision` 只纳入这次请求实际携带正文或附件的材料依据。
4. 若需要整理，独立上下文模型返回结构化补丁。`ContextMaintenanceState` 在原存储的暂存视图内同时修改笔记、输入摘要、历史检查点、结果租约和源码展示声明，生成候选五分区，检查必需材料与已确认约束，再调用父模型编译器做窗口预检，最后一次 CAS 发布。期间不运行观察或业务脚本。
5. `ActLoop` 给最终请求加入协议、阶段、完成拒绝原因和 contextStatus，再由 ProviderRequestCompiler 计量。最终请求超窗时不能派发。主模型返回的完整协议经过统一预检后进入 ScriptAct；执行身份固定，取消或重试不自动重放已派发操作。
6. 外部写入在共享效果队列内检查任务状态、委托写范围、子任务未知效果及当前决策资源版本。当前脚本自己的权威读写回执可推进自身前提。没有版本适配的能力明确列入 unverified。
7. 搜索、子任务、整理复用相同执行链和存储，各自有能力集合及预算。主线可以派发子任务，子任务可调用已注入的模型工具，叶子工具不发现派发或其他模型工具能力。成本计入每级祖先一次。
8. done 触发实际完成检查。需要补读或修复时把原因返回下一轮；效果未知进入 needs_reconcile，宿主用 `session.reconcile()` 核对本任务及其子任务的原始调用日志。核对调用领域 reconciler，保留原脚本失败事实，不重跑源码。没有领域核对结论时继续保持阻塞。

## 文件与契约变化

| 包/模块 | 文件 | 契约及原因 |
| --- | --- | --- |
| Kernel | `src/types/operations.ts`、`src/contract/requires.ts`、`src/contract/provides.ts`、`src/impl/runtime/OperationRuntime.ts` | 新增 OperationResourceVersion/OperationReadStamp/OperationReadValidation、OperationReadContract、validateReads、beforeReadValidation；读取戳验证原始回执、绑定代次、授权和当前版本。InvocationReceipt.observation 与 OperationContext.recordObservation 记录真实观察收束和防护范围。只读版本验证及效果核对服从取消。 |
| Script | `src/types/output.ts`、`src/utils/output-capture.ts`、`output-render.ts`、`standard.ts` | 新增 required，显式稳定 key 必填；优先分配完整必需块。原值采集、预览及原生图像保持同一通路。 |
| Context | `src/types/context.ts`、`src/contract/provides.ts`、`requires.ts`、`src/impl/ContextViewSession.ts` | ContextTaskState.id/startedSequence、begin 的 continue/new、preview、完成 recovery；原始任务归档和任务总账共用存储。 |
| Context Storage | `src/impl/LocalContextStorage.ts`、`ContextInvocationJournal.ts`、`SessionContext.ts` | records/collect 可选适配契约；SQLite 元数据与记录目录分表，索引分页；日志按 executionId 查询；CAS 防止引用不存在的对象。 |
| Agent | `src/types/act.ts`、`delegation.ts`、`src/contract/requires.ts`、`ActLoop.ts`、`ActRunService.ts`、`AgentSupervisor.ts` | ActInput.task、needs_reconcile、完成 recovery、ModelToolDelivery、AgentJob.parentTaskId/delivery、宿主交付回调。子交付最多 64 个内嵌事件、128000 字符，omittedEvents/eventSource 指向完整子历史。 |
| Runtime | `impl/RuntimeSession.ts`、`ProgramContext.ts`、`ContextMemory.ts`、`RecentContext.ts`、`ComposedRuntime.ts` | 决策依据、必需输出、任务边界、健康状态、共享效果闸门与父子核对。 |
| 领域装配 | `impl/StandardModules.ts`、`contract/requires.ts`、`index.ts` | createProjectCapabilityModule / ProjectCapabilityModuleOptions 复用 ProjectSpacePort 和现有文件能力。文件版本来自 kernel.stat/真实 read/edit 回执；列表/查询对真实结果重新核验，排除生成句柄随机性。CapabilityModuleOptions.reads 用于宿主注入权威版本适配。 |
| 整理 | `system/impl/ContextMaintenanceState.ts`、`system/contract/requires.ts`、`runtime/impl/ContextMaintenance.ts` | ContextCandidateValidator；候选发布前验证，保留既有用户约束。自动压力上限在当前业务轮后过期，显式边界策略在任务内保持。源码中的展示修改始终有可见版本。 |
| 支线交付 | `runtime/impl/ModelToolRuntime.ts`、`search/impl/AdvancedSearch.ts`、`search/impl/EvidenceOperations.ts`、`system/impl/ContextMaterialsOperations.ts` | 搜索/子任务/整理报告均有统一清单；搜索报告经 `velaros:evidence` 的 `report`、整理补丁经 `velaros:context-materials` 的 `submit` 交付，都是生成合同里的普通操作。证据和最多 16 份源码作为快照复制到父会话，并附来源及对象指纹；较早源码数量明确报告。共享源码需调用者读取、提交并通过自身校验。 |
| Shell | `shell/impl/ShellOperations.ts`、Runtime 标准装配 | 清理未收束时报告 OBSERVATION_UNSETTLED；已完成的部分防护观察仍报告 protection，未知效果不能由“只读命令”名称推断为无副作用。 |
| 验证入口 | `scripts/agent/act-eval.mjs`、包测试脚本、MODULE.md/invariants.md | 正式评测装配使用权威 Project 版本；新测试注册进入正常包测试入口。 |

## 模型面变化

- `output(value,{key,required:true})` 声明必须完整看到的值，observe 和有效租约结果都适用。引用或摘要不能代替必需正文。缺失时 `CONTEXT_REQUIRED` 阻止外部写入和完成；修改源码、释放租约、整理等系统操作仍可用于修复。
- `programs.read` 的操作不变，模板补充 required 和观察健康状态用法。源码、采集版本和展示版本继续分别报告。
- `agents.start/resume/status/wait/cancel` 的返回合同增加任务归属、统一交付和 needs_reconcile；`resume` 不能跨父逻辑任务隐式恢复。继续入口给出实际 operation/input，输入仍走原 schema。
- `search` 的领域报告保留 findings/gaps/evidence 等内容，并附 delivery。父会话可读取共享快照；需要当前事实时使用原 search.read 的 current 模式重新授权和读取。
- `memory.organize({focus,preserve})` 是整理入口；处理结果与请求身份自动进入下一帧，原始报告和 delivery 保存在 context-maintenance:outcome。发生结算错误仍如实报告。
- 外层 observe/execute/blobs/done 协议、图片附件和 ordered/async 执行规则沿用原链路。标准模块 schemaRevision 更新为 11，避免缓存继续使用旧返回 schema。

## 兼容与验收调整

Agent 公共状态枚举扩展会影响穷尽分支检查；默认 continue 的任务预算与子配额跨 run 累计。包版本由 4.2.0 更新为 5.0.0，公开 API 基线与 workspace lock 同步。宿主遇到独立用户目标时显式传 task:new；每次模型继续不重置预算。

`program-context.test.mjs` 对未知操作完成结果的断言改为 needs_reconcile。原来的 context_blocked 表示窗口容量问题，不适用于已派发但结果未知的操作；新验收要求先核对，不能借压缩或重试处理世界效果。

已确认的输入摘要约束不能被整理补丁移除；新的用户指令经正常输入通道处理。required 声明由主线源码维护，整理工具只能调整展示。

## 运行边界

- 版本检查仅覆盖提供权威适配的能力；shell、MCP 或其他未提供版本的模块保持可用并显式 unverified。写前检查与外界写入之间仍可能竞争，原子保障由领域 conditional write/fileRef 前提提供，不能扩大为全局事务。
- 候选窗口检查使用父模型编译器、协议、历史和原生图像；最终请求还会加入当前阶段、恢复说明及 contextStatus，最终发送门再次校验。预检通过不是远端一定接受请求的承诺。
- 必需块的完整可见性可由程序检查；模型选择了正确的必需块、摘要是否完整理解意图、模型是否作出了正确决策，仍须任务评测检验。
- 观察暂停保留最后结果及成功引用，不把旧观察当作当前事实。源码实质更新可以恢复采集，未知世界效果仍须先核对。
- 共享证据是发布时快照，复制和指纹不证明当前资源未变化；来源授权和版本由真实读取能力处理。
- LocalContextStorage 的兼容 load 仍返回完整记录目录，部分投影和 CAS 仍扫描目录；索引减少定点读取与磁盘元数据重写，但不是无限历史的常数成本。归档保留由宿主策略决定，collect 默认预演，仅回收超过一小时宽限期且未被记录引用的孤立对象，检查会话版本。
- 子交付 eventSource 是宿主事件分页位置；模型可通过同一子任务续跑请求进一步材料。读取共享源码不会自动执行或转移权限。

## 验证结果

合计 **689 项通过，0 失败，6 项 Windows 专属测试在 macOS 上跳过**。按独立入口计数：

| 验证入口 | 结果 |
| --- | --- |
| Node：Act Runtime 全部 test、system/search/agents spec、正式评测适配器 | 283 通过 |
| Kernel：test、spec/acceptance | 176 通过 |
| Agent：test、spec/acceptance | 14 通过 |
| Context：context/views/storage-index、turnContextStateSource | 29 + 8 通过 |
| Script：acceptance、script、output | 73 通过 |
| Velaros：Shell acceptance/test、Provider、MCP client | 106 通过，6 跳过 |

Kernel、Context、Agent、Script、Velaros 构建通过；Agent/Velaros/Agent Lab 类型检查通过。module-ownership、agent-arch、agent-schemas、agent-public-api、agent-browser、conversation-semantics、lockfile-consistency、act-catalog、platform-generation 及本轮文件 diff --check 通过。仓库完整 UI/产品/发布门未执行。

40 个业务执行轮次后完成：41 次确定性模型请求、81 次实际隔离脚本执行、1350 条记录，稳定阶段最大模型材料正文 12731 UTF-16 字符，最终 10894 字符，结束时保留 1 个有限租约。该回归与其他文件并行时耗时约 42.8 秒，不能当成单任务基准或真实 Provider 延时。

另保存一份可直接检查的正式 Runtime 追踪：读取 one → 修改一次为 two → 新观察读到 two → 完成。3 次请求材料分别为 2663、6511、11258 字符，关闭后 SQLite 为 307200 字节，独立文件判据通过。确定性驱动没有报告 Provider 用量，token 与费用为 null。原始请求、响应、回执、事件、数据文件、测试日志和 summary 位于：

`<local-artifact>`

其中 `traces.json` 是逐轮原始链路，`verification.json` 是本轮验证汇总，`checks/` 保存日志；`controlled-driver.mjs` 只注入受控响应并调用现有正式评测入口。

本轮对照开始前快照检查差量，保留工作树原有修改。没有提交或推送，也没有运行真实 Provider。后续评测应覆盖任务成功率、搜索召回、整理遗漏、跨模型稳定性、真实多模态、调用成本与端到端延时；当前确定性结果只证明已覆盖机制成立。
