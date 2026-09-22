# ScriptAct 文本协议实现差量

> 阶段差量记录：路径、API 和测试数字对应本次记录形成时的实现。当前接入请读 [模块规范](../architecture/module-ownership.md)、[Act 架构](../architecture/platform-runtime.md) 和 [能力目录](../../packages/velaros/act/README.md)。

日期：2026-09-20。基线：`342be1f246b542a6c94b9fdb95383354f203f670`。

## 交付范围

正式 Platform 主链已接入可配置的流式文本协议。主模型维护 observe 稳定程序，以 execute 提交一次性任务，用 blobs 提供不经源码转义的原文，用 done / done() 申请完成。普通 Markdown 与代码预览分流。全部声明、参数与程序通过检查后才派发。

多执行块、后台队列、独立执行身份与决策视图、事件等待、任务租约续期、按实际曝光消费结果、用户图片、原程序的 sourceRef / edits / modules / input / blobs 均接在既有 RuntimeSession、ScriptAct、Kernel、ContextStorage 与 ProviderRequestCompiler 上。

## 公开接口和迁移

| 接口 | 实际变更与消费者要求 |
| --- | --- |
| Kernel `ModelResponseFormat` | text / json 判别联合。读取 name/schema 前必须先缩窄为 json。 |
| Kernel `ModelTurnDelta` | 增加 text 增量。主 ScriptAct 驱动必须返回 text + 显式 finish(stop)，不能返回 object output。通用 JSON 消费者继续使用 output。 |
| `ModelImage` | 增加可选 origin，区分用户图片与能力附件；编码、容量规则与审计保持统一。 |
| `FoundationTurnDecoder` / `FoundationActionPort` | 装配层提供 open/reset/push/finish 解码器，以及 pending/wait/stop/needsRefresh 生命周期端口。Agent 处理调度，不解释具体控制头。自定义 ActionPort 必须迁移。 |
| `FoundationInput` / `FoundationAgentApi.submit` / `VelarosSession.submit` | 字符串兼容；支持 `{text?,images?}`，允许仅图片输入。输入及图片来源持久化。 |
| `FoundationRunEvent` / `FoundationRunStatus` | 增加 program start/delta/end 预览和 waiting 状态。宿主应分别处理正文、预览与真实运行状态。 |
| `VelarosRuntimeOptions` | 新增 protocol 配置和会话 inputs 读取口。名称、标记前缀、响应/头部/块预算、并发额度集中校验。 |
| `ScriptSubmissionReceipt` | 模型多块提交使用 executions[]；宿主单次 API 使用 execute。 |
| `ContextViewApi` | startStep 可登记并发与固定决策视图；request/updateCapsule/putArtifact 可明确 executionId；renew 续期。并发时不允许隐式猜测执行身份。 |
| `ProviderRequestCompiler` | 接受已经渲染的 compiledPrompt；以最终发送文本、图片做预算与指纹。纯文本请求审计不记录供应商实际未发送的 responseFormat。 |

`FoundationActionPort` 是破坏性变更，依照 Agent 公共接口政策将包版本升为 2.0.0，同步 workspace lock 和 API 基线。这里只更新仓库版本，不发布。

基线同时登记了 HEAD 已存在的声明差异：AgentToolNames、AgentToolCategoryByName、AgentToolLimits、ContextRefRetrieval、FoundationRunLimits、ProviderRequestFingerprint、ProviderRequestSnapshot。已从 HEAD 核对这些定义，并通过 schema、架构与公共 API 检查；本轮没有改动其业务定义。

## 文件与职责

- `velaros/impl/ScriptTurnDecoder.ts`、`utils/script-protocol.ts`：行边界增量解析；TypeScript 字面量 AST 白名单；别名、裸名称、原文和宿主参数绑定。头部表达式从不 eval。
- `velaros/impl/RuntimeSession.ts`：整批预检和 CAS 发布；按块序号派生独立身份；默认等待及有界后台队列；失败取消未派发任务；持久回执与恢复。
- `velaros/impl/ProgramContext.ts`：以 leaseId 固定实际投递清单，防止未见结果或新续租被旧帧消费；直接排版模型可读材料；持久作业状态。
- `velaros/impl/ComposedRuntime.ts`：同一 Runtime 内 write 能力串行；进入处理器前再次检查决策证据。只读能力可并发。
- `context/impl/ContextViewSession.ts`：每个活动执行保留独立决策视图，自己的回执只能结束自己的执行。完成时检查全部在途执行与未知效果。
- `agent/impl/loop/FoundationAgent.ts`：文本接收、最多两次协议修复、任务续期、事件等待、实际投递确认及完成验收。每次尝试绑定独立取消信号。
- `model/impl/requests/AiSdkModelDriver.ts`：AI SDK 普通文本流和通用 JSON 模式共用供应商传输；finish、截断、错误和用量继续由驱动报告。
- `script/bin/script-child.mjs`：深冻结 input，通过 JSON.parse 保留输入和 blobs 的 JSON 键语义；隔离器与能力调用机制保持共用。

上述包路径均位于 `packages/<包>/src/`，child 路径除外。

## 工具装配复核

`StandardModules.ts` 的能力目录、schema、说明和权限分类仍为唯一来源。本轮逐项变更：

- `artifacts.put`：将当前 invocation.executionId 传入 Context，防止并发脚本把材料登记到另一个执行下。
- 观察和执行的宿主程序校验继续由 parseScript 共用；模型控制文本由 ScriptTurnDecoder 解析后送入这个校验器。

模块作者继续提供同一 OperationModuleDefinition；写调度包裹既有处理器，不另建工具目录或调用通道。未知世界效果继续依赖真实 journal 核对，不因结果正文租约到期而消失。

## 验收承诺调整

- 主模型测试桩改为从真实请求读取本帧标记并生成文本；有界 Context Agent 的 JSON 决策测试继续独立执行。
- “重复 object output”与“必填 null 字段”属于对象响应的约束。主模型验收改为重复完成声明、对象事件误入文本模式、未闭合后续块等；整份响应零派发、零接受、零租期消费的承诺保持。
- 普通 Markdown 在生成期间即可显示；控制代码只发 program 预览。显示内容不表示执行成功。
- 协议错误可原帧修复两次，因此 A24 的固定调用数由 1 调整为 3，仍要求零写入和零租期消费。源码检查错误仍通过下一业务帧草稿反馈修复。
- 曝光租约按帧内的结果和 leaseId 确认。增加生成期间结果到达、生成期间续租两项竞态测试。
- 短所有权租约测试采用 2 秒期限并阻塞后台 4.5 秒，跨过多个续期周期；期限须容纳同步静态检查与测试进程竞争，过期时仍拒绝继续运行。

## 验证

最终验证：238 项测试通过，0 失败、0 跳过（重复执行的用例只计一次）。

| 验证组 | 结果 | 命令 / 范围 |
| --- | --- | --- |
| Velaros 正式主链 | 117 通过 | `node --test`：text-decoder、text-runtime、model-protocol、script-submission、incremental-edit、program-context、runtime、dual-core、platform 九个文件 |
| Provider、Script utils、Agent 请求快照 | 56 通过 | `bun test packages/velaros/test/provider.test.ts packages/script/test/script.test.ts packages/agent/test/providerRequestTranscript.test.ts packages/agent/test/modelInputCompatibility.test.ts` |
| Context 存储与视图 | 25 通过 | `node --test test/context.test.mjs test/views.test.mjs`，cwd 为 packages/context |
| Script 隔离器验收与通用模型客户端 | 40 通过 | `bun test packages/script/spec/acceptance.test.ts packages/model/test/model-request-client.test.mjs` |

Kernel、Context、Model、Script、Agent、Velaros 六包 build 与 typecheck 均通过。修改的 TypeScript 源文件 ESLint、module-ownership、Agent/Kernel/Model 架构、Agent schema、Agent public-api、lockfile-consistency 与 git diff --check 均通过。

主链新增测试已加入 Velaros 的正式 test 命令。所有测试均本地自动化；隔离脚本、SQLite、文件写入与 SDK 编码实际运行，模型内容由测试驱动或模拟供应商提供。

## 边界与后续验证

- 尚未验证在线模型的协议遵循率、长任务完成率、成本以及不同供应商的实际支持矩阵。
- 写闸门是 Runtime 实例内的保守串行机制。跨进程和系统外部写入继续由领域前提、锁和宿主权限处理，不能声称全局事务或完整回滚。
- 进程恢复通过持久占位、结果和 journal 核对；中断的 JavaScript 不自动从断点继续执行。
- 正式主链有响应、头部、块数、并发/排队、回合、时间、模型和现有脚本输出预算；本次没有运行全仓库所有产品模块测试。
