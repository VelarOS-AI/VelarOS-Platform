# 模型工具接入图谱

## 当前约束

主线可以派发业务子 Agent，也可以调用单一职责模型工具。业务子 Agent 可以调用模型工具。搜索和上下文整理是叶子模型工具，只获得完成本职工作所需的确定性能力。能力集合决定发现卡片、模板、脚本声明和执行绑定；子 Agent 的集合中没有派发模块。树的结构最多是主线、业务子 Agent、模型工具三层。

所有会话继续使用 RuntimeSession、ActLoop、ScriptAct、Kernel、ContextStorage 和 ProviderRequestCompiler。主线保留大的任务总额度，模型窗口与任务总成本分别计算；支线的实际消耗同时记入各级祖先总账。

## 接入点和复用

| 接入点 | 已有职责 | 本次接入 |
| --- | --- | --- |
| `act/runtime/impl/ComposedRuntime.ts` | 根、业务子会话和搜索的统一装配 | 按角色构造能力集合，注入共用模型工具管理器 |
| `act/runtime/impl/ModelToolRuntime.ts` | 本次新增 | 持久归属、活动权、固定层级、祖先总账、实际模型请求并发 |
| `act/runtime/impl/BudgetedModelDriver.ts` | 子调用预留和取消时退款 | 接入祖先预算端口，继续使用同一驱动 |
| `act/search/impl/AdvancedSearch.ts` | 检查点、搜索会话、报告发布和清理 | 共用活动权、模型请求队列和祖先总账；保留证据发布规则 |
| `act/search/impl/SearchActivation.ts` | 证据访问、搜索档位和软收尾 | 保持单一职责叶子，委托共用 ModelToolActivation 处理模型预算与最后交付轮 |
| `agent/src/impl/AgentSupervisor.ts` | 业务任务句柄、等待、取消和写入范围 | 继续作为主线派发业务任务的服务 |
| `script/src/impl/ScriptPackageCompiler.ts` | 授权模块到类型和可执行包的投影 | 复用其授权投影；缺少的能力不进入脚本包 |
| `act/system/impl/SystemCatalog.ts` | 模型可见包目录和成员模板 | 复用同一会话能力集合过滤发现 |
| `act/system/impl/ContextMaintenanceState.ts` | 本次新增 | 固定材料快照，校验并原子发布结构化上下文补丁 |
| `act/runtime/impl/ContextMaintenance.ts` | 本次新增 | 独立 ScriptAct 整理会话、有限读预算、补丁交付、取消与结果回执 |
| `act/runtime/impl/ModelToolActivation.ts` | 本次新增 | 搜索与整理共用的模型预算、软收尾和硬截止 |
| `act/system/impl/ContextModule.ts` | 本次新增 | context.request/status/reset 与专用材料 list/read 的 schema、模板、派发 |
| `act/runtime/impl/ContextPatchStore.ts` | 本次新增 | 暂存元数据变更；调用既有操作验证后一次 CAS 发布 |
| `act/runtime/impl/ContextMemory.ts` | 五分区组装、正文配额和变化报告 | 读取持续呈现策略，对新 observe 结果继续限额，携带整理回执 |
| `agent/src/impl/ActLoop.ts` | 压力检测、编译请求和恢复 | 轮边界 maintain 端口，预警与 Provider 超窗时委托整理并重新编译 |

## 上下文补丁

补丁的 `notes`、`inputs`、`history`、`releaseResults` 分别调用现有 ContextMemory.update、SessionContext.summarizeInput、RecentContext.checkpoint、ProgramContext.release。暂存期间任何一项验证失败，全部元数据不发布。原始正文仍保存在原 ContextStorage；这是上下文元数据的原子提交，不包含任何世界操作。

材料版本包含用户输入、笔记、源码、结果、当前目标、任务版本和未决操作。预算结算和续租心跳不使整理快照失效；新用户输入、业务结果或任务变化使旧补丁失效。

呈现策略绑定观察源码版本。后续每轮生成新的观察结果和新的原文引用，只调整展示量；不把旧摘要当作新结果。

## 交付核对

- [x] 搜索与业务子任务接入共用活动权和祖先预算。
- [x] 子 Agent 的目录与脚本声明不包含派发能力，宿主配置中的该成员在装配时排除。
- [x] 单一职责工具的活动权禁止发起后代调用。
- [x] 一个模型并发槽下，主线、业务子 Agent、搜索可以依次推进。
- [x] 主线大总额度与独立业务支线默认额度。
- [x] 固定快照、材料分页、版本前提和原子上下文补丁。
- [x] 持续观察的呈现策略和整理变化回执。
- [x] 独立上下文整理模型工具及实际 ScriptAct 会话。
- [x] ActLoop 压力与 Provider 超窗恢复接到整理支线。
- [x] 系统空间的整理请求、状态和呈现策略复位入口及模板。
- [x] 叶子工具的确定性引用降级和最终报告策略。
- [x] 整理软收尾、预算预留、取消、失败和并发输入的集成验收。
- [x] 完整回归、合同生成、门禁和用户交付报告。

## 验证入口

新增 `act/runtime/test/model-tools.test.mjs`、`act/runtime/test/context-maintenance.test.mjs`，已经纳入 velaros 的 test 脚本。原 search、children、context-memory、context-management、协议、图片与租约回归保持运行。用测试驱动验证确定性链路；真实模型的语义整理质量需要在最终报告中单独标明证据。

实际验证范围与测试结果见 [交付报告](model-tools-report.md)。
