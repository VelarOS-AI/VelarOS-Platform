# 分区工作内存实现差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

## 本轮交付

正式 `RuntimeSession → ContextMemory → ProviderRequestCompiler → ModelDriver` 链路按 task、workspace、observation、recent、runtime 五区组装请求。主任务、搜索和业务子 Agent 共用同一个组装器，以份额和近期窗口表达差异。模型可在 execute 中维护稳定键笔记，跨回合、跨运行和重启保留；驻留、预算裁剪和归档引用分别管理。

本轮沿用现有 ContextStorage、Kernel 权限、ScriptAct 解析和隔离执行、结果租约、ProviderRequestCompiler 及搜索生命周期。仓库原有的大量未提交改造继续保留；本报告只记录本轮增量。

## 文件与责任

| 文件 | 本轮变化 |
| --- | --- |
| `packages/velaros/src/contract/memory.ts` | 可移植的分区配置、笔记更新、不可变版本和目录数据 |
| `packages/velaros/src/impl/ContextMemory.ts` | 笔记 CAS、作用域校验、驻留组装、五区快照、投递变化基线 |
| `packages/velaros/src/utils/context-memory.ts` | 配置校验、目录卡片、唯一最终文本渲染器 |
| `packages/velaros/src/impl/RecentContext.ts` | 从 SearchContext 收拢为所有会话共用的近期材料组件；窗口、检查点、正文去重与引用退让 |
| `packages/velaros/src/impl/ProgramContext.ts` | 继续管理源码、观察和结果租约，提供内部结构化材料；结果卡片数量随预算缩小，新结果代次区分预算省略和晚到结果 |
| `packages/velaros/src/impl/RuntimeSession.ts` | 固定五区组装入口、正常投递确认、结果模式归档及模型说明 |
| `packages/velaros/src/impl/ComposedRuntime.ts` | 分区配置装配、子 Agent 工作区、维护轮本地状态权限 |
| `packages/velaros/src/impl/AdvancedSearch.ts`、`SearchActivation.ts` | 工作笔记接入搜索能力范围，验证来源引用，说明笔记和证据的区别 |
| `packages/velaros/src/impl/StandardModules.ts` | workspace 工具与通用 history 工具的唯一合同 |
| `packages/agent/src/impl/ActLoop.ts` | 所有分区使用一致的容量维护流程和建议 |
| `packages/velaros/src/impl/RuntimeTrace.ts`、`scripts/agent/act-eval.mjs` | 读取新帧结构；Trace 同时支持已有归档 |

## 工具合同逐项变化

`StandardModules.schemaRevision` 从 8 升为 9。

| 操作 | 理由与影响 |
| --- | --- |
| `workspace.update` | 新建或按 baseRevision 修改稳定键笔记；返回 key/revision/title/ref/resident/chars。新建 baseRevision 为 0；更新必须匹配当前版本。仅 execute 可调用，resident:false 只移出自动投影 |
| `workspace.list` | 分页发现当前授权代次的笔记，包含移出的笔记；默认 32、最多 64 条，after 为稳定键 |
| `workspace.read` | 读取当前会话内某个不可变笔记版本，支持分页；读取不改变版本和驻留 |
| `history.list` | 所有会话均可发现自己的有序响应/结果记录；搜索仍受当前授权代次限制 |
| `history.read` | 所有会话均可召回自己的原文；现有来源范围和会话边界继续校验 |
| `history.checkpoint` | 所有会话均可整理旧区间，保留最近响应、原文引用、未解事项和否定尝试 |

笔记修改和 task.update 属于本地工作状态，容量维护轮可用；外部世界能力继续由阶段门、Kernel 和宿主授权约束。没有业务模块的子 Agent 也拥有自己的 workspace。observe 不能通过别名调用绕过笔记写入限制。

## 对外接口与迁移

Velaros `interface/requires.ts` 新增 `VelarosContextOptions.memory`、`VelarosSearchOptions.memory`，子任务 `AgentProfile.contextMode` 替换为 `AgentProfile.memory`。三个入口均使用 `ContextMemoryPolicy`：recentRecords、workspaceShare、recentShare。该类型从 `index.ts` 和 `contracts.ts` 导出。Velaros `interface/provides.ts` 的会话方法保持现有签名。

迁移配置时用 `memory:{recentRecords:0}` 表达不自动投递近期响应，执行结果租约仍有效；需要更多历史时提高 recentRecords 和 recentShare。默认主任务为 8 / 0.2 / 0.2，搜索为 64 / 0.2 / 0.4。份额控制可裁剪正文，最终请求预算仍以编译器估算为准。

新 runtime-view 材料使用 `schemaVersion/id/frameId/partitions/memoryStatus`。宿主若直接解析审计材料，需把 observation 改读 partitions.observation、results 改读 partitions.recent.results，jobs/mandatory/progress/programFrame 改读 partitions.runtime。history 正文在原有消息通道发送，避免当前 prompt 再次内联。ProgramContext 的平面材料仅是组装器内部输入。

Agent 的 `ActContextPort.mode` 和 Kernel 的 `ModelContextStatus.mode` 增加 partitioned；当前 Velaros 固定返回该值。已有其他 mode 字面量保留供外部自定义适配器使用。持久记录的旧标题和 Trace 的旧帧读取保持归档兼容。新执行结果归档带 mode，近期自动投影会排除 observe 结果；已有不带 mode 的历史结果按原记录处理。

包版本：Velaros 0.3.0 → 0.4.0，Agent 4.0.0 → 4.1.0，Kernel 0.5.0 → 0.6.0；bun.lock 对应工作区版本同步。Agent API 基线按 additive 刷新，差量为 0 新增、1 修改、0 删除声明，修改项为 mode 联合类型。

## 测试变化及验证

新增 `context-memory.test.mjs` 15 项，覆盖真实请求五区、CAS 冲突、重启与旧版本读取、移出/重新驻留、observe 别名写入拒绝、大正文引用、授权代次、历史去重、零近期窗口、无效配置、维护轮无业务重放、子 Agent 工作区、卡片分页、大检查点退让、预算省略后的正常完成和晚到结果补投递。

最后复核先用 40 条有效结果复现了完成检查把容量省略误判为新结果、反复刷新直至回合上限的问题。ProgramLeaseState 与 programFrame 新增 resultsRevision，只有新引用进入租约集合才推进代次。完成检查比较代次，容量省略不会形成空转；已有结果续租仍只影响 leaseId 和曝光次数。两项新增回归与原有运行中续租验收共同验证这些区别。

现有验收的结构读取迁移到测试辅助函数 runtimeFrame；正文断言同时检查 compiledPrompt 和 request.history，因为真实正文投递位置发生变化。生产数据只使用五区格式。原来主任务 history 拒绝断言改为成功，是此次通用近期分区的新合同；长任务的空历史断言改为有界近期窗口。RecentContext 的 64 条测试增加预算以覆盖完整窗口，较小预算的引用退让由独立测试验证。失败增量编辑的完整候选源码断言保留，并据此修复去重时误删源码的问题。

最终验证结果：

- 218 项相关 Node 测试通过，0 失败、0 跳过；包含 14 组 Velaros 链路、2 组 Context 与 Act 评测适配器。
- 18 项 Provider/AI SDK 实际编码测试通过，含原生图片、普通文本传输、截断和非法响应、取消；使用受控 fetch。
- 40 个业务轮的正式 Runtime 回归产生 41 次模型请求、81 次实际脚本运行和 1228 条持久记录；结构化帧最大 11089 字符，最终 9411 字符，剩余 1 条租约。该字符数不等于完整 Provider 请求 token 数。
- Kernel、Agent、Velaros build，以及 Agent、Velaros typecheck 通过。
- module-ownership、agent-public-api、agent-schemas、conversation-semantics、agent-arch 和 lockfile 工作区版本检查通过。
- ContextMemory、RecentContext、context-memory 工具函数和新增测试的显式 ESLint 通过；git diff --check 通过。

本轮未运行根目录完整 check、全部领域能力测试和产品验收；未调用真实 Provider。受控模型验证的是正式执行链路和契约，模型整理笔记、摘要和长期任务的实际效果仍需真实模型评测。

## 可查看的实际请求

受控驱动通过正式 Runtime、SQLite、隔离脚本和编译器运行了两轮：稳定观察输出 auth 状态，第一轮 execute 写入带观察来源引用的 auth-investigation 笔记，第二轮收到笔记和新观察后 done。结果 completed，2 次受控模型请求，0 次真实 Provider 调用。

文件目录：`<local-artifact>`。同级 `capture-partitioned.mjs` 可重新采集独立目录。

- `frame-2.json`：第二轮真实五区帧，6447 字符。
- `requests.json`：受控 ModelDriver 实际收到的请求。
- `provider-request-snapshots.json`：正式编译器封存的请求审计快照。
- `events.json`、`context.sqlite`、`summary.json`：事件、持久状态与结果。

## 当前边界

笔记标记为 model-note。来源版本戳与当前 readSet 出现冲突时标为 changed；没有当前核验依据时为 unverified。它不代表语义结论已验证，也不自动检查正文中任意文件名。

工作区当前授权代次最多 256 个键，单正文 60000 UTF-16 字符，来源最多 64 个；驻留卡片最多 64，恢复窗口更小时继续收缩。旧版本保留在现有对象存储，模型可复用键。存储分段、索引和垃圾回收未在本轮改造，超长会话性能仍需单独验证。

强制回执和未知效果继续保留在 runtime 分区；分区裁剪不能绕过最终请求预算，必要内容放不下时明确 context_blocked。笔记引用不跨会话，搜索权限收缩后不能重新读取旧授权代次笔记。

修改前备份：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/partition-context-before-s3z7mv4b/source.tgz`。本轮未提交或推送。
