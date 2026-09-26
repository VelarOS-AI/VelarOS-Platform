# Desktop 执行记录接入差量

日期：2026-09-22。

## 本轮链路

Platform 的 Kernel 调用日志 → Runtime trace → 有界执行摘要 → Desktop 可靠 notice → 现有会话工具卡片 → 会话保存与重开。

Desktop 在模型回合切换时读取上一回合，运行收尾关闭 Runtime 前再核对本轮所有回合。按会话与调用身份更新同一条记录，内容未变化时不重复交付。成功或失败回执使用工具卡片；尚无完成回执与取消使用明确的状态文字。参数、返回值、错误和外部效果分别展示，正文截断有标记。

读取失败或证据缺失给出展示提示；不把诊断失败改写成实际执行失败。正式终态仍等待产品流的持久交付屏障。

## Platform 对外合同差量

- 新增公开数据 ActInvocationSummary，挂载于 ActTurnTrace.invocations[].summary；根入口与 contracts 入口导出。
- summary 从完整的 Kernel InvocationRecord 生成，包含 moduleId、operation、原始回执 status、独立的 effect，以及参数/结果预览与截断标记。无终态回执时为 pending；reconciliation 不覆盖原始回执语义。
- 参数最多 2000 字符，结果最多 6000 字符；二者计入 trace 与分页 trace 的 maxChars 总正文预算。摘要先于同条调用的 raw body 分配剩余预算，因而同一预算下原始 body 可能比原先更早截断；原始数据仍保存在 Platform。
- provides/requires 方法、工具定义和执行权限不变。手工构造 ActTurnTrace 的消费者需要补齐 summary。

## 观察摘要

`ActTurnTrace.observation`（`ActObservationSummary`，根入口与 contracts 入口导出）给宿主展示持续观察用，宿主不必解析内部记录：

- `registration`：这一回合响应里 observe 声明的登记结果。`status` 是 updated / unchanged / cleared / rejected；没登记上时 `failure` 与没过检查的执行同一套原因（如 `OBSERVATION_CHECK` 带出错行）；`source` 是登记的源码（清除时为空），计入本页正文预算。这一回合没有 observe 声明时为 null。
- `run`：喂进这一回合请求的那次观察运行（观察每帧在请求前运行，结果进这一帧）。`executionId` 与 `invocations[].executionId` 对应，观察运行的调用照常列在 `invocations` 里；`status` / `failure` 由持久结果与调用回执推出，与执行摘要同一套判定；`durationMs` 取自持久结果；当时没有观察时为 null。
- 执行摘要同样带 `durationMs`（持久结果里记的运行耗时）；还没有结果或没过检查时为 null。
- 登记本身不运行程序：同一次观察的登记在第 N 回合，运行结果从第 N+1 回合的追踪开始出现；登记被拒时，后面回合的 `run` 仍是原来那个观察。
- 程序记录读不出源码时源码为空并记一处 `gaps`，不让整页读取失败。

## 子任务摘要

`ActTurnTrace.agents`（`ActAgentSummary[]`，根入口与 contracts 入口导出）列出这一回合的执行里派发（`velaros:agents.start`）或续跑（`resume`）的子任务，按调用顺序：

- `id`、`sessionId`（子任务自己的会话，按它读支线追踪）、`executionId`（派发它的那段执行）、`profile`，以及派发时交代的 `task`（续跑时是这一阶段的说明）。
- 同一个子任务可以续跑好几次，它的持久记录按段切开：派发或续跑写下的那份（还没有 `pending`）是一段的开头，之后的提问、回答与收束都记在这一段。这一回合第 k 次派发或续跑它，对应这一回合请求之后它开始的第 k 段，下面几项都只取那一段：
  - `status` 与 `error` 取这一段最新的记录（`running` / `waiting` / `completed` / `cancelled` / `failed` / `interrupted`）；
  - `answer` 是这一段结果笔记里最后接纳的一段回答，收束前为空；
  - `durationMs` 是从这一段开头到收束的时间，收束前为 null。
- 任务与回答计入本页正文预算，截断时 `answerTruncated` 为真。后面的回合续跑同一个子任务时，那一回合的追踪列出新的一段，身份不变；前面回合的摘要仍是它自己那一段。
- 执行还在跑时（父脚本在 `wait` 子任务）追踪照样能读：宿主在执行期间定时重读当前回合，就能看到子任务从进行中到收束。

## Desktop 归属与恢复

宿主不解析 Kernel 原始 JSON，也不根据会话结束推断调用成功。沿用既有卡片和会话持久化通道，不复制执行日志 owner。

本轮历史查看覆盖已投影到会话的记录。验证同时证明：原 Runtime 关闭后，不配置模型的新 Runtime 可通过公开 trace 读取同一份持久调用事实。当前 UI 按回合边界刷新；命令内逐段输出和集成前历史记录的批量回填另需独立接入。

## 验收差量

新增 INV-45，核对原始回执、未知效果、取消、截断及分页总预算。原 trace 索引验收保持。

Desktop 真实编辑/命令集成测试增加执行 notice 和关闭后只读追踪断言；轻量 fake session 补齐已存在的 trace 方法。新增收尾刷新晚到回执、追踪失败仍关闭资源的回归。renderer 验证重复交付、状态更新、保存恢复及恶意/畸形 notice 拒绝。原有执行、取消、持久恢复及可靠交付断言保留。

## 验证结果

- Platform 执行摘要、追踪索引、Runtime 和子运行回归：30 项通过。
- Desktop renderer 正文与执行展示回归：8 项通过。
- Desktop Runtime 与可靠流集成：Electron Node 环境 23 项通过，覆盖真实项目修改、命令执行、关闭后历史读取和取消回执。
- 21 个受影响类型分区通过；Platform 7 包拓扑构建、Desktop 生产构建及 Electron 入口产物校验通过。
- 两仓库模块归属检查通过。Desktop 架构增量检查保留 document-renderer README 的 6 项既有错误，该文件本轮未改。
