# Act 执行可靠性与原始追踪

本轮范围是正式主干的故障恢复、行为覆盖核对和单轮原始数据追踪。执行由 RuntimeSession、ActRunService、ActLoop、KernelScriptSession、OperationRuntime 完成；证据保存在已有 ContextStorage 与调用 journal。

## 修正的行为

| 问题 | 当前行为 | 接入点 |
| --- | --- | --- |
| 执行收尾抛错会跳过帧收尾、租约释放和定时器清理 | 各清理阶段分别尝试，聚合错误上报；完成事件在收尾成功后提交 | agent/ActLoop、ActRunService |
| 接受事件或运行状态落盘失败时，宿主恢复只能看到模糊的中断状态 | 接受事件持久化失败时不派发脚本；尽力记录 failed，消费方仍收到异常 | agent/ActRunService |
| 子结果写入失败后，活动槽位释放，稍晚到达的 wait 可能漏掉错误 | 故障保留在调度器中，pending/wait/waitAny/父收尾/关闭均能观察；显式续跑重新开启后清除此故障 | agent/AgentSupervisor |
| 用户引导归档较慢时，旧响应仍可能先被派发 | 输入到达立即抢占；轮边界等待串行归档，失败中止当前运行 | agent/ActRunService |
| 完成验收期间接受新目标，但仍按旧目标报告完成 | 新输入中止旧验收，并在持久接受前使旧视图失效；下一轮处理新目标。与完成 CAS 竞争失败时明确拒绝引导 | agent/ActRunService、ActLoop |
| 一个会话关闭失败后，其余资源清理被跳过 | 等待所有会话收束，分别尝试释放 Kernel 和存储；会话及子会话绑定在 finally 清理 | velaros/RuntimeSession、ComposedRuntime |

故障注入在修改前复现了执行收尾跳过、子结果落盘错误丢失和验收期间新目标被遗漏。接受事件写失败、消费者退出、慢输入归档、多阶段清理异常均有独立断言。

## 真实数据追踪

VelarosSession 新增宿主接口 `trace(turnId, maxChars?)`，返回可移植的 ActTurnTrace。turnId 来自 submit 的 turn 事件，也可从 events 的持久游标历史获取。

```ts
const turnIds: string[] = []
for await (const event of session.submit(input)) {
  if (event.type === 'turn') turnIds.push(event.turnId)
}
const trace = await session.trace(turnIds[0])
const originalRequest = JSON.parse(trace.request.body!)
// originalRequest.providerRequest：封存的 system/messages/tools/outputTokens/指纹。
// originalRequest.request：交给 ModelDriver 的请求、运行时材料及 ContextStatus。
// trace.response.body：模型原文；trace.decision.body：协议判定与解析结果。
// trace.records：派发身份、源码版本、控制回执、结果、租约变化及控制事件。
// trace.invocations：Kernel 的准备、效果回执和核对记录。
const next = trace.nextTurnId ? await session.trace(trace.nextTurnId) : null
```

请求沿用 ProviderRequestCompiler 已有封存。ActLoop 为接受、协议拒绝、截断及取消响应保存 model-response 判定及原文引用；RuntimeSession 在派发前保存 script:dispatch，将请求、回复和控制身份连接。RuntimeTrace 只读这些记录，按现有引用和执行号连接 Kernel journal。

追踪默认正文总预算 1,000,000 个 UTF-16 字符，上限 8,000,000，覆盖 request/response/decision/records/invocations。超额返回 truncated、原始长度及引用，Context 记录可通过 `context.read(ref,{offset,limit})` 分页读全。缺失原文或未完成阶段写入 gaps。只能查询所属会话。

nextTurnId 指向同一 run 的下一次请求，包括协议修复请求；可用其真实材料比较脚本差量和观察输出差量。追踪按真实事件范围选择历史租约记录。

这里的模型请求是编译器与 ModelDriver 边界的原始数据；供应商 HTTP 封装由具体 driver 实现。请求审计存在不表示供应商已经接收。snapshotVersion 是读取会话元数据时的版本；Kernel 核对事实取自查询时的权威日志，活动运行中的查询不承诺全局原子快照。

## 覆盖核对

| 行为 | 实际验收入口 |
| --- | --- |
| 接受落盘失败不执行、清理失败不报完成、慢输入抢占 | agent/spec/acceptance.test.ts 的 INV-34..37 与附加故障用例 |
| pending 交互恢复、迟到回答拒绝、取消释放 | velaros/test/act-run.test.mjs |
| 两个 Runtime 对同一 SQLite 会话竞争 | velaros/test/act-run.test.mjs；竞争者不调用模型，不释放原持有者租约 |
| 子任务配额、父身份、写范围与预算 | agent/spec/acceptance.test.ts、velaros/test/act-children.test.mjs |
| 写入后实际进程退出、未知效果核对、不重放脚本 | velaros/test/dual-core.test.mjs 的 A15 和 Phase 4 |
| 多连接 journal claim、回执写入故障与重启 | context/test/context.test.mjs |
| 批内失败、后台取消、租约消费、程序冲突 | velaros/test/text-runtime.test.mjs、script-submission.test.mjs、incremental-edit.test.mjs |
| 原始请求→编辑观察→一次写入→v2 视图的追踪及重开 | velaros/test/act-run.test.mjs |

迁移台账中不存在的 renderer.test.ts、kernel/test/operations.test.mjs 引用已校正为实际的 act-children、Context journal 和 Platform 集成测试。这是按关键行为的覆盖核对，不声称所有历史内部断言完成一对一迁移。

## 对外与模块影响

- velaros/src/interface/provides.ts 新增 VelarosSession.trace；contract/trace.ts 的 ActTurnTrace、ActTraceRecord 由根入口及 contracts 导出，纳入当前尚未提交的 Velaros 0.3.0 变更集。
- velaros/src/interface/internal.ts 新增 RuntimeTraceApi；类只读取既有存储，不创建运行或模型调用。
- Agent provides/requires、模型协议声明、标准模块 schema 维持当前合同。StandardModules 本轮没有修改。
- 新增的原始模型回复和解析记录属于宿主审计材料，不自动进入模型工作集。

## 验证与边界

最终相关回归 **500 通过、0 失败**：Node 的 Velaros/Context 179 项，Bun 的 Agent/Kernel/Model/Provider/MCP/活动账本 321 项。相对本轮开始新增 12 项故障与集成测试，重复运行不重复计数。

构建与类型检查覆盖 Agent 和 Velaros。module-ownership、agent-arch、agent-public-api、agent-browser、agent-schemas、conversation-semantics 与 git diff --check 均通过。本轮没有运行根目录全部 check:gates 或产品端验收。

本轮实际执行追踪导出于任务产物 `act-runtime-trace.json`：runId `935d602b-e0b4-482d-8df1-405ee6d50fbd`，请求 `3f30254f-13b9-4798-a843-69c578236ec6` → `b0cc6064-96ab-42f4-a982-16c5a444d299`；受控数据源由 v1 更新到 v2，write 调用一次且 effect=committed，两帧 gaps 为空。该产物保存执行时的原始身份，不作为随机身份的测试基线。

存储持续不可用时无法承诺立即持久释放租约；当前实现尝试所有清理并上报错误，跨实例仍由租约期限与恢复核对控制。子任务并发及模块写范围的调度域是一份 Runtime；不同 Runtime、不同父会话之间的全局写锁需要宿主协调，同会话执行权由共享存储的 ContextView 租约保护。

本轮追踪示例使用受控 ModelDriver，脚本实际执行，调用经过 Kernel 并持久化到 SQLite。真实模型任务质量、费用及长会话性能仍需独立验收。

修改前范围备份：`/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/act-hardening-before-mwedbx6r/source.tgz`。保留已有未提交工作，未执行提交或推送。
