# 本轮差量与契约复核

> 历史设计与阶段验收记录。本文中的接口、路径和测试数字对应其记录阶段；当前实现请读 [Act 运行架构](../../architecture/platform-runtime.md)、[模块规范](../../architecture/module-ownership.md)、[系统能力](../../architecture/act-system-space.md) 与 [存储合同](../../architecture/storage.md)。原始输入规格保存在 reference-pack/。

基线为 2026-09-19 开工时当前工作树。该工作树已有大规模包迁移与主干建设，本轮在其现状上扩展；下列范围是双核接入差量，不能以相对 HEAD 的全部删除/新增量作为本轮改动量。

## 实现文件

| 包 | 主要文件 | 差量职责 |
| --- | --- | --- |
| Context | `src/contract/context.ts`、新增 `view-schema.ts` | 需求、候选、计划、视图、检查点、来源与预算数据；边界 JSON 校验 |
| Context | 新增 `impl/ContextViewSession.ts`、`impl/ContextEvidenceBuilder.ts`、`utils/view.ts` | CAS 任务与 lease、真实证据物化、有界检索、读集/覆盖/来源、完成检查 |
| Context | `impl/ContextInvocationJournal.ts` | 复用调用日志，增加会话/执行索引与追加式核对事实 |
| Context | `impl/SessionContext.ts`、`impl/LocalContextStorage.ts` | 保存完整任务检查点、保护内部日志命名空间、保留现有对象存储和 CAS |
| Context | `interface/{provides,requires,internal}.ts`、`index.ts`、`contracts.ts` | 注入 Source/Planner/Verifier，导出正式视图 API |
| Agent | `impl/loop/FoundationAgent.ts` | 物化视图进入现有主干循环，共享预算、独立验收事件、完整响应后执行、超时与取消 |
| Agent | `impl/context/ProviderRequestCompiler.ts` | 增加 compileModelTurn，复用校验/指纹/快照，固定最终请求字节 |
| Agent | 新增 `impl/context/BoundedContextPlanner.ts`、`utils/loop/model-stream.ts` | 受限规划角色和有界模型等待 |
| Agent | `contract/requires.ts`、`types/foundation.ts`、`index.ts` | 主干注入接口、verification 事件、编译结果 |
| Kernel | 新增 `types/model.ts`、`impl/runtime/ModelRequestEncoder.ts`、`utils/runtime/model-request.ts` | 中立 ModelDriver 协议与请求编码单一来源 |
| Kernel | `impl/runtime/OperationRuntime.ts`、`types/operations.ts` | 派发前检查、冲突代码、只读 reconciliation、保留真实回执 |
| Kernel | `contract/{provides,requires}.ts`、`index.ts`、`contracts.ts` | API 归属与公开协议 |
| Model | `impl/requests/AiSdkModelDriver.ts`、`types/driver.ts`、契约/入口 | 使用中立协议和已编译请求；未报告 token 保持未计量；编码实现归拢到 Kernel |
| Script | `impl/KernelScriptSession.ts`、`utils/standard.ts`、`contract/requires.ts`、`bin/script-child.mjs` | 注入 view/task/artifacts 声明与虚拟模块，执行仍走原 QuickJS |
| Script | `impl/NodeSubprocessCodeRunner.ts` | 纠正实际执行器说明，保持既有发布认证契约 |
| Velaros | `src/impl/{ComposedRuntime,RuntimeSession,StandardModules}.ts` | 同一实例图装配、写入前提、脚本步骤结算、宿主核对、标准模块 |
| Velaros | `src/interface/{provides,requires,internal}.ts`、入口 | 模式/策略/Source 配置与会话 view/reconcile |
| Project | 新增 `impl/operations/ProjectContextSource.ts`、`contract/{provides,requires}.ts`、`index.ts` | 用原项目内核提供路径、范围、符号、编码、revision 的只读证据源 |

对应包 MODULE.md、Context invariants、包 test 入口和本目录设计/接入/验收/链路文档同步更新。补齐 Velaros Script 模块卡原有目录树的 impl 层。根 ESLint 的现有共享实现规则增加 Context 范围。

## 工具逐项复核

所有标准工具仍在 `packages/velaros/src/impl/StandardModules.ts` 登记。说明、schema、执行与脚本声明沿原单一装配链生成。

| 工具 | 原因 | 模型可见影响 |
| --- | --- | --- |
| `script.run` | 世界效果由子操作真实回执记账 | 包装层 effect=none，避免把所有脚本一律记为 unknown；子操作仍逐项检查与结算 |
| `view.sources` | 模型需要先发现实际 Source ID | 返回源 ID 和一致性声明，不携带实现细节或凭据 |
| `view.request` | 将观察需求与事实正文分开 | 只登记合法 ViewIntent；不能注入“已读取事实”或改变硬预算 |
| `task.inspect` | 模型知道进度和容量 | 返回阶段、胶囊、计量、验收状态 |
| `task.update` | 维护有限推进状态 | 只能写下一目标、假设、决策和问题；真实回执、原始目标、验收结果不接受模型改写 |
| `artifacts.put` | 保存大结果与派生材料 | 返回当前任务范围的持久引用，继承声明来源读集 |
| `artifacts.read` | 按引用和范围召回 | 对任务材料集合与会话身份检查 |

view/task/artifacts 的控制状态操作不声明世界副作用，仍由 Kernel 校验并写调用日志。`modules` 发现/释放、原 `context` 工作集工具和 `execution.inspect` 继续共用原实例。领域读写操作仍由宿主注入，并遵守领域权限与条件写。

## 对外接口逐项复核

| 接口位置 | 新增/扩展 | 兼容与迁移 |
| --- | --- | --- |
| Context provides | ContextViewApi；ContextInvocationJournal 的 list/核对记录 | 原 ContextRuntime/Storage 路径保留；视图是同一会话状态的扩展 |
| Context requires | ContextSourcePort、ContextPlannerPort、ContextViewOptions、ContextBuildOptions、ContextCompletionPort | 宿主显式注入只读源；需要机械验收时注入 verifier |
| Velaros requires | VelarosContextOptions；RuntimeOptions.context | 可选，缺省 off；显式 active 接入物化视图 |
| Velaros provides | session.view、session.reconcile | view 随配置提供；reconcile 只用于非活动会话的只读核对 |
| Agent requires | FoundationAgentOptions 增加 view/mode/strategy/contextModel/completion | 新字段可选；原 action/context/model 注入方式继续有效 |
| Agent provides/types | Foundation 入口、CompiledFoundationRequest、verification 事件 | 宿主消费 verification 确认真实验收状态；不要仅以文字判断验证完成 |
| ProviderRequestCompilerApi | compileModelTurn | 原 compile/finalize 路径保留；自行实现该接口的适配器需补充新增方法 |
| Kernel requires | ModelDriver；beforeDispatch；OperationDefinition.reconcile；Journal 可选核对方法 | 既有模块与 Journal 无核对能力时保持 unresolved；不会自动重试未知写入 |
| Kernel provides/data | OperationRuntimeApi.reconcile、ModelRequestEncoderApi；模型协议及核对数据 | 共享协议归 Kernel，Agent 不依赖供应商 Model 包 |
| Model requires/入口 | ModelDriver 继承 Kernel 契约，原公开模型数据转发中立定义 | 供应商实现仍在 Model；主核和上下文核可配置不同模型 |
| Project requires/provides | ProjectContextSourceOptions / ProjectContextSourceApi / 工厂 | 注入原 AgentProjectKernelPort；可选绑定单会话范围 |
| Script requires | 标准虚拟模块说明 | 使用同一声明、导入检查和执行器；现有程序入口保持 |

Agent 公共 API 基线本次复核为 8 项新增、1 项修改、0 项删除；版本从 1.4.0 增至 1.5.0 并更新锁文件及基线。修改项是 ProviderRequestCompilerApi 的方法扩展，结构化实现者需要同步；仓库实现和消费者已通过类型检查。这里记录的是本地源码契约，尚未发布包。

## 存储、权限与一致性差量

- 同一 ContextStorage 保存对象、会话检查点及 Kernel 日志。单对象字符限额从 4,000,000 增至 8,000,000，以保存验收中的 5 MB 材料；模型视图仍有独立小预算。
- Journal 索引先于派发登记。核对结果作为追加事实保存，保留原 receipt；prepared-only 在重启后继续阻止重放。
- 沿用 ADR 0009 和现有空间/路径/危险命令规则；Source.authorize 表达宿主真实可发布范围。Context 规划器只有只读候选口。
- Project 声明 revision 可验证、条件写 best-effort。Generic Runtime 不承诺跨文件、浏览器和服务的统一回滚。
- 任务取消保留终态；旧 revision/lease 的视图不能发布。主核和上下文核共享模型预算，缺失供应商用量不会记为实际零成本。

## 测试改动与复核

新增 Context views、Velaros dual-core/provider 与真实进程退出 fixture、Agent 编译门测试。原 Context 日志测试补上 IDEMPOTENCY_CONFLICT 精确代码断言。AI SDK 传输测试放在装配包，避免 Agent 对 Model/SDK 产生逆向依赖。现有行为验收继续通过；没有放宽断言来接受重复效果、过期事实或虚假完成。

Context 加入已有版本的 Ajv；Velaros 的 AI SDK 仅新增测试依赖；bun.lock 同步。未执行提交、推送或发布。
