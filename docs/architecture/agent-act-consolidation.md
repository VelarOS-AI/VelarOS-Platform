# Agent 与 Act 正式架构

更新：2026-09-20。本文描述当前实现；差量和验收记录见 `../engineering/agent-act-consolidation-delta.md`。

运行完成事件在执行、帧及租约收尾成功后提交；各清理阶段独立尝试，持久化与子结果故障向宿主传播。`session.trace(turnId)` 按同一存储中的真实记录连接请求、模型原文、协议判定、脚本版本、Kernel 回执、租约和下一帧。故障覆盖及追踪合同见 [执行可靠性与原始追踪](../engineering/act-reliability-delta.md)。

## 包边界

| 包 | 权威职责 | 生产文件 |
| --- | --- | --- |
| agent | 回合、运行控制、子任务调度 | `src/impl/ActLoop.ts`、`ActRunService.ts`、`AgentSupervisor.ts` |
| model | 请求编码、封存、计量、供应商传输 | `src/impl/requests/ProviderRequestCompiler.ts`、`AiSdkModelDriver.ts` |
| context | 原文、输入摘要、引用、视图、CAS、任务租约和预算 | `src/impl/SessionContext.ts`、`ContextViewSession.ts`、`LocalContextStorage.ts` |
| kernel | 能力单源定义、绑定、schema、模式、派发、效果回执和审批合同 | `src/impl/runtime/OperationRuntime.ts`、`ApprovalContracts.ts`、`TaskApprovalState.ts` |
| script | JS 检查、隔离运行、Kernel 桥 | `src/impl/KernelScriptSession.ts`、`KernelInvocationPort.ts` |
| velaros | ScriptAct、上下文策略、标准模块、领域和外部接入 | `src/impl/RuntimeSession.ts`、`StandardModules.ts`、`ComposedRuntime.ts` |

Velaros 依赖五个基础包；Agent 只依赖 Model/Context/Kernel/Core；Model、Context、Script 不反向引用 Agent。公开的 Agent 工厂只有运行服务和子运行调度器，Loop 是内部实现。

## 一次真实执行的顺序

1. 宿主调用 `runtime.openSession(id)`，再迭代 `session.submit(input)`。input 可以是字符串，也可以携带 text、files、images。
2. ActRunService 建立 runId。ActLoop 归档输入及原生图片，ContextView.begin 取得当前任务租约。失败或等待后的续跑保留已用预算；已完成任务的新输入开始新的额度周期。
3. 轮边界合入 steer 原文。RuntimeSession 重跑稳定观察；ProgramContext 选择观察输出、有效结果租约、目标、计划、子任务状态和必要效果事实。
4. ProviderRequestCompiler 编码实际消息和图片，以同一 ModelDriver 计量。v2 请求快照覆盖模型、system、messages、responseFormat、outputTokens 和指纹。
5. ActLoop 预留本轮预算并持久化真实 request。模型文本增量交给 ScriptTurnDecoder；正文和程序预览实时交给宿主。
6. 正常 finish、完整段和协议校验通过后，保存原始响应，发出 accepted 事件。ScriptAct 的执行意图经 RuntimeSession 进入 KernelScriptSession，再进入唯一 OperationRuntime。
7. Kernel 检查固定绑定、参数、运行模式及宿主授权；真实操作产生回执。未知效果保留为 unknown，不能因传输恢复而重跑脚本。
8. 下一帧读取实际观察和结果租约。done 需要等待后台脚本及子任务，并通过现有完成检查。

模型外层仍使用可配置的 ScriptAct 标记、blobs、observe、execute、done。宿主的运行控制方法不会变成模型供应商 tools。

## 运行控制

`submit` 推进一次运行；`steer` 归档补充并使尚未接受的响应失效；`answer` 只接受当前 runId 和交互 id；`cancel/close` 传播取消并收束在途操作。输入队列通过持久 input 和 input-applied 记录恢复，已归档但尚未合入的输入可以在续跑轮边界递交。

`inspect` 返回运行状态和交互。`events(after, limit)` 用存储单调序号分页。text/program 是流预览；accepted 包含最终正文和不可变原始响应引用，turn/rejected/state/interaction/answer 等控制事件保存到同一存储。renderer 的 `createActEventProjector` 按序去重，从接受事件建立展示历史。

进程重启不会恢复任意 JavaScript 调用栈。未完成运行表现为 interrupted；已派发操作沿现有 journal/reconcile 恢复事实，再由新 run 继续。

## 通用子任务

宿主在 `agents.profiles` 配置模型、精确模块名单、上下文模式和运行上限；模型通过 `velaros:agents.start/resume/status/wait/send/cancel` 使用。

```js
import { start, wait } from 'velaros:agents';
import { output } from 'velaros';
const job = await start({ task: '检查登录状态来源', profile: 'investigate' });
output(await wait({ id: job.id }));
```

start 返回 id、parentSessionId、sessionId、profile、status、writes。终态增加 result 引用，原文保存在父会话；完整子事件和请求保存在子会话。父上下文每轮包含子任务状态及结果引用。

调度器在打开会话前原子占用进程内并发槽和写范围。writes 使用模块 id，外部写入要求占用该模块；同模块的并发子任务冲突会明确拒绝。Kernel 的效果队列继续串行化真实写操作。当前递归派发由根任务协调，不向子配置开放 agents 模块。

子任务使用同一个 RuntimeSession 和 ActLoop。BudgetedModelDriver 在实际发送前占用父任务预算；本地子账记录执行明细，父总账只记录一次子调用。子会话个数以持久父会话记录累计，续跑不新建会话。resume 重新检查当前宿主配置，读写权限不能超过父任务。

materials 只接受父会话持有的引用；Runtime 复制不可变原文到子范围，保存 source/objectId/copy 谱系，以文件引用交给子模型。模型通过 memory.read 真实读取。共享授予发生在派发时，后续可见租约不改变该份已授权快照；需要动态撤销材料的宿主应关闭对应子任务并重新创建收窄后的任务。

父取消、关闭和结束收束子任务。宿主可通过 `runtime.getSession(job.sessionId)` 回答活动子任务交互。

## 高级搜索

AdvancedSearch 创建相同 RuntimeSession，使用相同 ActRunService、ActLoop、ScriptAct、编译器、Kernel 和存储。SearchContext 提供增量历史；SearchActivation 负责来源数量、读量、软收尾、最终报告及父任务预算。search 只允许 execute，观察可读已发布报告。

搜索的证据授权与语义报告策略仍由 SearchActivation 管理。通用子任务的并发槽和搜索活动表分别表达子运行调度、证据检索生命周期；二者实际模型调用共享 ContextView 的原子预算。搜索重启续查仍按当前来源重新授权。

## 能力与装配

标准定义只在 StandardModules：

| 模块 | 作用 |
| --- | --- |
| modules | 当前授权目录、声明及绑定释放 |
| programs / results | 程序版本和结果召回、租约 |
| inputs | 用户原文、附件、意图摘要 |
| artifacts / execution | 同会话材料和调用事实 |
| task | inspect 与 update；模型的下一步、假设、决定、未解问题 |
| interaction | ask / confirm；答案不代替具体操作授权 |
| agents | 通用子任务 |
| search / evidence / history | 有界搜索、真实来源、段内历史与卷 |

长期模型指导、计划和进度集中在 task capsule，用户原文和宿主固定指令保持各自来源。修改 capsule 不会改写用户目标或授权。

模块发现、脚本类型检查、实际调用使用相同范围。`VelarosRuntimeOptions.authorize` 在每次真实派发前接受不可变 PreparedInvocation 和 descriptor；宿主可接审批政策。领域已有的 shell/sandbox 审批继续使用 Kernel 的 ApprovalPort，缺少审批端口默认拒绝。

MCP 连接迁入 Velaros：`createMcpClientConnection` 保留 stdio、HTTP、SSE、OAuth 挂起续接、分页、取消和关闭。`createMcpModule` 将固定工具快照接成 OperationModuleDefinition。远端 readOnlyHint 不自动授予观察权限，宿主显式 readOnly 名单才可；写操作要求 authorize，结果不明保持 unknown。图片经独立附件链发送。变更目录应更新绑定代际并重新装配。

远端配对、调用、连接代际继续由 Kernel RemoteNodeClient/Server 负责；Mod 加载继续由 KernelModLoader/Store 负责。宿主把它们的能力装成 OperationModuleDefinition，技能或其他指令材料作为 ContextSourcePort/宿主基础指令注入。产品配置、市场和旧 Agent seam 不进入执行核心。

## 迁移与范围

Agent 4.0 只保留根入口和 contracts。旧循环、ToolExecutor、工具驻留治理、workflow IR、产品 Session/Chat 运行入口已随合同迁移退出。逐测试理由见 `agent-test-migration.md`。

这次已实现唯一循环、生命周期、子运行、主要领域依赖迁移和公开入口收口。旧产品专有聊天数据库/归档需要各产品按原数据版本写离线适配器；平台不会猜测产品私有结构或自动重放旧执行。真实模型质量、长任务成本及远端服务联调需用实际宿主配置验证，本地可控驱动验收不替代这些结论。
