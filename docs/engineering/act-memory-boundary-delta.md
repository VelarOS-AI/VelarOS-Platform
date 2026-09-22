# Act 工作记忆与整理职责收敛差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

本轮已接入正式 Platform 主链。模型通过 `velaros:system` 的 `modules`、`memory` 工作；主模型拥有笔记、计划和工作意图，整理支线拥有派生展示任务，Runtime 负责生效、版本、预算与生命周期。

当前合同和原始调用示例见 [系统空间](../architecture/act-system-space.md)；每个分区的处理见 [上下文管理](../architecture/context-management.md)；准确操作表从 [Act 清单](../../packages/velaros/act/README.md) 生成。

## 实际实现

- `system/impl/MemoryModule.ts`：统一 list/read/update/retain/release/organize 的 schema、模式和派发。主线共 9 个系统操作，本地记忆会话共 8 个。所有操作复用 Kernel 的校验、授权和回执。
- `system/impl/SystemModules.ts`、`SystemCatalog.ts`、`contract/constants.ts`：同一个系统包，主线与本地合同由相同实现生成。发现、声明、模板和实际派发使用同一范围。业务模块不能占用系统身份。
- `runtime/impl/ContextMemory.ts`：统一原文发现和分页读取，笔记/结果驻留，自动整理反馈。派生笔记摘要按不可变 ref 匹配；主笔记更新后失效，原始笔记仍可回读。
- `runtime/utils/context-memory.ts`：统一当前任务和搜索授权代次的引用判定。用户在新任务明确重新附上的材料可重新读取；无关旧任务材料仍保持隔离。
- `runtime/impl/ContextMaintenance.ts`：focus/preserve 请求、持久 requestId、同边界 CAS 合并与认领、任务范围、自动压力入口、结果回执。请求本身不改变当前已发出的上下文。
- `system/impl/ContextMaintenanceState.ts`：notes 补丁为 `{ref,summary?,resident?}`；检查当前版本、保护引用、已确认用户约束和必需输出，在父 ProviderRequestCompiler 检查后一次 CAS 发布。
- `runtime/impl/ComposedRuntime.ts`：整理会话只获得 context-materials.list/read；这些操作的真实声明和模板由宿主直接注入。搜索获得本地记忆合同；业务子任务按宿主配置拥有整理，委派深度和祖先预算保持原链路。
- `runtime/impl/RuntimeSession.ts`：默认主线提示词反映当前系统面，完成前检查待处理整理请求；同响应内 organize + done 必须先补投递新帧。低层会话装配端口同步收敛。
- `context/src/impl/SessionContext.ts` 与 ProgramContext、RecentContext、material renderer：输入、源码、结果、历史的召回提示统一到 memory.read/list。分块原文仍由现有 readInput 读取。

模型发出 `memory.organize({focus,preserve})` 后得到 scheduled/requestId；下一帧 memoryStatus.maintenance.lastAttempt 返回请求身份、applied/failed、变更、保留引用、未解事项、错误及详细报告引用。自动压力整理复用同一管线。失败不会把候选笔记展示、观察展示或用户摘要部分发布。

## 提供面与注入面变化

`system/contract/provides.ts` 现在登记 MemoryModuleApi、ModulesModuleApi、SystemModulesApi；`requires.ts` 用 MemoryHost/MemorySession/MemoryStore、ModulesHost、SystemHost、ContextMaintenanceHost、ContextCandidateValidator 描述实际依赖。MemoryQuery、MemoryPage、MemoryOrganizeIntent 由公开签名使用。HistoryCheckpoint/List/Page 作为内部机制数据使用。

系统合同 schemaRevision 为 13；Runtime 合同 schemaRevision 为 12。存储仍是现有 ContextStorage、Kernel journal、ProgramContext 和 RecentContext，ProviderRequestCompiler 继续检查完整请求与原生图片。

## 操作迁移及原因

| 原操作 | 当前归属 | 原因与影响 |
| --- | --- | --- |
| task.update | memory.update({plan}) | 主模型自己的计划统一在记忆入口修改 |
| task.inspect | 每帧 runtime/workspace 状态；宿主 inspect | 运行状态自动投递，宿主保留完整控制面 |
| workspace.list/read/update | memory.list({kind:'notes'}) / read / update | 笔记与其他材料共用发现和召回；目录按记录序号分页 |
| history.list/read | memory.list({kind:'history'}) / read | 动作和结果使用同一归档索引 |
| history.checkpoint | 整理服务的补丁发布阶段 | 区间检查点由整理流程维护，Runtime 校验 |
| inputs.read | memory.read | 用户原文、附件与其他引用使用一个入口 |
| inputs.summarize | 整理输入摘要补丁 | 约束和版本检查集中在发布边界 |
| artifacts.put/read | memory.update 保存工作材料；memory.read 回读已有 artifact | 工作材料带稳定键和版本，原始任务 artifact 权限继续由 readArtifact 检查 |
| programs.read | memory.read | 读取不可变源码不执行程序；增量编辑仍由外层 ScriptAct 提交 |
| results.read/retain/release | memory.read/retain/release | 沿用成功业务曝光次数和 task 租约，不重跑脚本 |
| execution.inspect | 每帧 mandatory/运行反馈与宿主 journal/trace | 诊断和恢复归宿主，模型接收执行所需反馈 |
| modules.list/search/describe | 原操作保留，返回当前两个系统成员的真实投影 | 减少模型需要理解的系统面 |
| modules.release | 宿主 Kernel 生命周期 | 绑定回收由系统执行 |
| context.request/status/reset | memory.organize + 下一帧自动结果 | 模型表达工作意图，预算与生效由 Runtime 决定 |
| context-materials.list/read | 整理支线唯一读取能力 | 固定父快照，无业务写入或递归委派能力 |

相应八个旧操作 Module 实现、九个旧成员模板和 LegacySystemPackage 映射已移除。保存的旧源码需要按新合同显式编辑；原文和历史回执仍在原存储中，不自动重写或重跑。现有业务文件、浏览器、Shell、搜索、子任务协议与外层 ScriptAct 声明保持原职责。

明确未写入的笔记/意图校验失败现在记录 effect:none，避免把拒绝请求误报为外部未知效果。已发出的不确定世界操作仍按原机制核对。

## 验收承诺的调整

INV-1 的模板与声明一致性现在覆盖实际 modules、主线 memory 和本地 memory 合同。INV-3 的目录期望从十成员转为两个成员，仍校验真实 binding、类型检查与运行。INV-6 保留源码/结果召回不重放承诺，改用统一入口。

INV-20 原先允许整理模型直接创建或改写父笔记，与本轮确认的所有权边界冲突；现在验证原笔记不变、派生摘要生效、原笔记新版本使摘要失效。取消、迟到结果、并发冲突、整组回滚、必需观察和父预算验证的测试继续保留。输入压缩测试经真实整理入口完成，不从主模型暴露低层 summarize 操作。

新增验证包括：同响应 organize + done 的反馈屏障、失败回执自动进入下一帧、保留引用/意图合并、跨任务请求隔离、统一目录分类与分页召回、笔记驻留幂等和陈旧版本拒绝、校验失败无效果、用户重新附加旧文件的授权恢复，以及叶子合同真正不具备整理与委派能力。

## 验证结果

- Act Runtime、system/search/agents 验收及正式确定性评测：283 通过，0 失败。
- 最后补充的整理支线合同注入：22 项相关测试复核通过（属于上述覆盖范围，不重复计数）。
- Context Node 验收：29 通过；Bun 状态源验收：8 通过。合计 320 项独立用例通过。
- Context、Velaros 构建通过；Velaros 与 AgentLab 类型检查通过。
- module ownership、Agent schema/public API/架构、Capabilities 架构、会话语义、平台代次、Act 目录漂移检查通过。
- 相关路径 diff whitespace 检查通过。

真实 Provider 模型评测按用户安排留到后续。这轮验证的是正式执行链、授权、持久化、预算与失败反馈；摘要质量和真实模型使用这些接口的效果仍需真实任务评估。
