# 上下文、协议分离与搜索实现差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

本轮在正式 Platform 内实现，设计入口为 `docs/architecture/context-management.md` 与 `advanced-search.md`。

## 接入与公开接口

- Agent：FoundationActionPort 保留解码、执行、后台作业；FoundationContextPort 承接准备/投影/确认/阶段/截止。FoundationAgentOptions 新增 frames；FoundationInput 新增文件引用。FoundationContextPolicy 提供模式相关的容量阈值与恢复上限。接口发生破坏性分离，Agent 更新为 3.0.0，并更新对应 API 基线与锁文件。
- Kernel：OperationDescriptor 增加 allowedModes；ModelTurnRequest 增加 history/contextStatus；ModelHistoryMessage 支持真实 user/assistant 序列。编码、估算、审计、发送保持同一入口，历史图片参与总容量校验。
- Context：ContextRuntime 增加 ingest/readInput/summarizeInput/projectInput；输入分块与摘要使用同一 ContextStorage。ContextViewApi 增加未使用模型预留的释放。EvidenceAccess 复用来源授权和真实读取，精确视图与高级搜索共同使用。
- Velaros：VelarosRuntimeOptions 增加 search 配置；VelarosContextOptions 和 VelarosSearchOptions 分别配置上下文策略。ScriptRetention 支持 task；协议配置支持 allowed/defaultRetain。RuntimeSession 复用给搜索，SearchContext 仅负责其历史策略。

## 工具逐项变更

全部定义位于 `packages/velaros/src/impl/StandardModules.ts`。

- modules.list/search：返回准确的模块分页 schema，搜索作用域过滤发现范围；describe 同步校验范围。
- results.retain：期限扩展为有限次数或 task；release 新增，停止可见性且保留原文。
- inputs.read：分页召回用户原始文本或已归档输入文件；summarize：按版本保存意图、约束和未解点，摘要标为模型解释。
- history.read：搜索作用域归档读取；checkpoint：有界整理旧历史，保留近期响应和因果关联，CAS 发布。
- search.search：execute-only 的新建/续查；read：snapshot 召回或 current 刷新已选目标，不调用模型。
- evidence.query/read：搜索作用域的真实来源访问，按调用数、候选数及并行占用字节计费，收尾阶段关闭。

## 状态与恢复

Runtime 材料卡片包含大小、原始引用、字段位置、正文是否发送以及读取方式；引用化只影响发送投影。ContextStatus 每轮报告实际模式、阶段、估计口径、额度和管理建议，materialStatus/historyState 报告材料变化与检查点。

有限租约只消费成功业务正文曝光；维护与修复不重复消费，task 期限跨搜索暂停/续查。主任务完成/取消结束 task 期限。Provider 容量拒绝只重编译有界请求，既有脚本不重跑。

搜索共享父任务模型总账并提前预留收尾机会。来源读取、模型调用及整体激活有界；未知 token 用量不报为零。报告与恢复状态持久化，检查点按 CAS 占位。

## 验收迁移

BoundedContextPlanner 的独立 JSON 模型循环迁移到共享 ScriptAct 搜索。dual-core.test 中两项旧助手装配测试迁移为 advanced-search.test 的真实模块调用、共享计费和只读范围验收；原有精确证据、效果屏障、项目范围和恢复测试保留。runtime.test 的固定模块目录加入 inputs，搜索未配置时不挂载 history；变化来自本轮新增输入管理能力。上下文包的低层候选物化合同仍用于既有精确/来源适配测试。

新增 advanced-search.test 与 context-management.test 并登记到正式包测试命令。测试采用可控模型驱动和真实运行时、SQLite、隔离 JS 执行器。

## 本轮交付阶段

1. 已完成原始输入归档、文件引用、分块召回、版本化意图摘要，以及主运行时的材料引用与租约管理。
2. 已完成执行协议与上下文策略接口分离，主运行时与搜索分别配置上下文政策；真实多模态请求继续使用共享编译链。
3. 已完成高级搜索的正式模块、共享执行循环、增量历史、检查点整理、软收尾和硬上限、父任务计费、权限复核及重启续查。
4. 已完成可控模型下的集成与故障验证。真实模型摘要/检索质量、实际费用和长任务表现仍需宿主 Provider 配置后评估；本轮没有进行真实模型调用或产品仓接入。

## 验证记录

- `node --test packages/velaros/test/*.test.mjs packages/context/test/*.test.mjs`：160/160 通过。覆盖执行、协议、增量编辑、视图、租约、恢复和本轮主要功能。
- 收尾补充重启续查、宿主缺项预算、续查授权超时 3 项回归。最终 `node --test packages/velaros/test/advanced-search.test.mjs`：16/16 通过；`context-management.test.mjs`：7/7 通过。与上一行有重合，Node 去重计 163 项。
- `bun test packages/velaros/test/provider.test.ts`：18/18 通过。使用真实 AI SDK 与模拟 Provider，验证实际编码、流和多模态；本轮相关回归去重共 181 项。
- kernel/context/agent/velaros/model 构建与类型检查通过；改动源码的 ESLint 通过。
- `check:module-ownership`、`check:agent-public-api`、`check:agent-arch`、`check:kernel-arch`、`check:model-arch`、`check:lockfile-consistency`、`git diff --check` 通过。
- 验证范围为相关链路，未执行全仓所有测试及发布门；未提交或推送。
