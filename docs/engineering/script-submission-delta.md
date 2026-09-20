# 结构化脚本回合协议差量报告

日期：2026-09-20。

## 当前交付

正式模型入口是 `script_turn` JSON 响应：必填 message、observe、execute。两个脚本区域允许 null；非 null 区域使用现有源码、版本引用和精确编辑契约。一份完整响应至多转换为一次 ScriptSubmission，随后使用现有 RuntimeSession、ScriptAct、Kernel、ContextStorage 和 ProgramContext 链路。

AI SDK 使用 `streamText` 配合 `Output.object`。驱动收完流并检查正常结束后才交付经过 schema 校验的完整 output。外部 FoundationRunEvent 的文本、用量、状态和验收类型保持原接口；message 在完整回合被接受后发出，脚本正文不会作为用户文本显示。

## 接口差量

| 接口 | 本次变更及影响 |
|---|---|
| Kernel / Model `ModelResponseFormat` | 声明 type、name、description、schema，表示整份模型输出契约。 |
| `ModelTurnRequest` | response 承担响应格式；compiledPrompt、materials、images、mode 和输出预算保持原语义。自定义驱动须实现新的回合协议。 |
| `ModelTurnDelta` | output(value)、usage、error、finish(stop/length)。每个成功回合恰好一份 output；身份由宿主生成。 |
| `ModelRequestEncoderApi` | response 封存格式，output 校验不可变 JSON；encode/messages 继续编码原来的文本与图像。复用 Kernel 已有 Ajv 依赖。 |
| `FoundationActionPort` | response 提供格式，decode 分离消息与可选提交，invoke 接收宿主 acceptedTurnId。Agent 不解释业务脚本字段。 |
| `ProviderRequestSnapshot` / `ProviderRequestFingerprint` | 新增可选 responseFormat / responseFormatHash。结构化链路在指纹中计入格式；普通聊天链路的既有快照保持逐字节一致。 |
| `StandardModuleFactory` | response 和 parseTurn 定义业务回合。parseScript、create 继续服务原有宿主提交和模块装配。 |
| `VelarosSession.script / observe / execute / submit` | 宿主签名、提交回执、幂等身份选项和事件类型保持现状。 |

工具装配：业务模块定义保持现状。完整业务响应 schema 集中在 `StandardModules.ts`，其 observe/execute 与宿主 ScriptSubmission 共享字段定义。模型响应 schema 不能注册成业务模块。

## 调用与返回

`ProviderRequestCompiler → AiSdkModelDriver → 完整 output → FoundationAgent 接受并持久化 → StandardModules.parseTurn → RuntimeSession.control → 既有脚本提交/执行链`。

执行回执继续落在共享存储中。下一轮重新运行稳定观察，ProgramContext 将最新观察、有效结果租约、目标、缺口和必要事实投影成 runtime-view。实际图像继续作为同次模型请求的图片附件。一次性执行的返回结果保持原租约，不因这次协议适配重新执行。

observe/execute 双候选仍先一起检查，通过后 CAS 发布观察版本、执行源码和 prepared 占位。源码失败进入草稿修复流程。schema 错误属于尚未接受的协议响应，失败时不写脚本、不消费租约。prepared 状态和未知效果仍需核对，不自动重放。

上下文检索助手仍是有界只读规划器，使用相同中立驱动生成 context_plan 决策，候选、调用预算及真实证据物化流程保持现状。

## 供应商与显示行为

OpenAI 的 strict JSON Schema 子集不能完整表达当前可选字段与任意 JSON input。本链路明确传递 strictJsonSchema:false，保留完整 schema；本地 Ajv 是最终接收门，不做类型转换或默认填充。供应商不支持响应格式时报告错误。

每轮最多接受一份响应，取消、截断、重复 output、结束后继续返回、缺失字段和未知事件均不能派发脚本。用户消息在整份文档校验后显示，因此不会逐 token 展示尚未接受的 message。

## 验收调整说明

- 现有模型桩直接生成新协议文档，显式使用 null；测试辅助函数只构造当前协议，不提供旧协议转换器。
- 增量编辑的同轮多调用用例改为连续回合及合并提交，继续验证显示基线、CAS、源码/输出差量和失败阻止写入。
- A24 的错误参数用例改为拒绝整个不合法响应；代码检查错误仍由其他集成用例验证下一轮草稿反馈。
- 新增 10 项主循环接收测试，覆盖重复、迟到、缺失、截断、schema 错误等，逐项验证没有派发、没有 accepted 记录、没有租约消费。
- SDK 测试检查原生 responseFormat、完整 output、图片、用量、错误和取消；传统聊天请求快照金标及通用客户端测试继续覆盖共享接口。

## 验证结果

- Velaros 正式主链：77 项通过。
- ScriptAct、Agent 编译器/传统请求快照、AI SDK 传输：84 项通过。
- Context 存储与视图：24 项通过。
- Model 通用请求客户端：5 项通过。
- 共 190 项通过；无失败、跳过。
- Kernel、Model、Agent、Velaros 构建；Velaros typecheck；本轮 TypeScript ESLint；module-ownership、Kernel/Model 架构检查、diff 空白检查：通过。

真实探针使用安装的 OpenAI Chat adapter 序列化 HTTP，模型回复由本地预设提供；SQLite、QuickJS 和文件操作实际执行。文件从 count=1 变成 count=2，发送两次请求，下一轮观察读取 count=2，执行结果剩余租期为 2，Kernel 记录 read、edit、read 三次能力调用。

本次尚未验证真实模型服务的生成质量与各供应商支持情况；未运行整个仓库的全量检查。原始请求、响应、回执、下一轮 ModelView 和执行跟踪已采集到任务产物目录。
