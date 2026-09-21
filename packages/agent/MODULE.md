# @velaros-ai/agent

## 这是什么

Act 执行核心。一次用户输入由 `ActRunService` 托管，以 `ActLoop` 推进回合；通用子任务由 `AgentSupervisor` 调度同一会话工厂。模型协议、能力模块和上下文投影由 Velaros 装配。

## 提供什么

- `createActRunService` → `ActRunServiceApi`：submit、steer、request、answer、inspect、events、cancel、close。
- `createAgentSupervisor` → `AgentSupervisorApi`：start、resume、status、wait、waitAny、send、cancel、cancelParent、pending、close。
- 注入契约：`ActRunServiceOptions`、`ActLoopOptions`、`ActLoopControl`、`ActProtocolPort`、`ActTurnDecoder`、`ActContextPort`、`ActExecutionPort`、`AgentSupervisorOptions`、`ActChildSession`。
- `./contracts`：输入、文件、图像、事件、运行快照、交互、预算、子任务句柄等可移植数据。
- `AgentStoreGrant`：start.stores 显式携带空间 ID 和读写前缀，AgentJob.stores 持久保存，resume 原样交给宿主重新核验。
- `ModelToolDelivery`：领域报告、证据与源码产物、继续入口的持久交付清单；`AgentJob.delivery` 使用同一合同。

## 骨干链路

归档输入 → ContextView 租约 → 观察与投影 → Model 编译、计量 → 有界接收与完整解码 → 保存接受身份 → 执行端口 → 下一轮或验收。预览即时传给消费者，完整响应和控制事件持久化；重放以 accepted 事件和原文引用为准。

## 依赖什么

Model 的请求编译、Kernel 的中立驱动合同、Context 的唯一存储和视图。领域能力及 ScriptAct 文本格式由端口注入。

## 状态归谁

ContextStorage 保存运行事件、状态、输入和子任务记录；ContextView 持有任务租约及计费总账。运行服务只持有本进程取消权与待回答 promise。重启后的活动脚本必须核对真实效果。

## 生命周期

一个会话同一时刻一个 run。steer 在轮边界追加原文并抢占尚未接受的模型响应；回答绑定 runId 和交互 id；close 取消并等待结束。父运行收尾时收束其子任务。

`ActInput.task` 默认为 continue；new 显式创建新的逻辑任务和总账。子任务配额属于逻辑任务。`needs_reconcile` 表示真实效果待宿主核对；子任务保持该状态并由 Velaros 阻止父任务绕过。完成检查可返回 repair/refresh/reconcile/input/capacity，修复次数有界。

子任务交付正文最多内嵌 64 个事件和 128000 字符；omittedEvents 明确报告移出数量，eventSource 指向子会话完整事件记录。公开变更与版本 5.0 的迁移见 `docs/engineering/act-chain-closure.md`。

## 不变量

见 `spec/invariants.md`、`spec/acceptance.test.ts` 和 Velaros 的 act-run/act-children 集成验收。架构门、浏览器门与公开 API 基线共同约束可达链路。

## 结构

`interface/`：产品、注入和内部接口。`contract/`：可移植数据。`impl/`：ActLoop、ActRunService、AgentSupervisor。`utils/model-stream.ts`：有界模型接收。
