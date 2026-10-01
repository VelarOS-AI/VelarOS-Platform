# 可恢复的并行开发评测

`parallel_campaign.py` 负责一次冻结开发批次的调度、检查点与报告。`repository_launch.py` 负责每个 source/replay 阶段的容量租约、独立容器、签名凭据、取消清理和供应商结算。官方成绩继续来自全新容器中的官方 PatchReplayAgent。控制器没有自动重试付费解题的路径。

## 冻结输入

先由操作者准备现有 repository manifest：明确双方相同 `model`、`reasoning_effort`，每个 participant 同时填写 `model` 和 `kwargs.reasoning_effort`；冻结候选文件、官方任务与判分器、执行脚本、依赖和资源协议。每个 attempt 的 source/replay job 名全局唯一，每个 job 仍只允许一个 Harbor trial。候选共享只读制品，工作目录、容器、上下文和请求身份独立。

本入口当前只接受 Codex 与 ScriptAct、已登记暴露的 development 题。`evaluation.roles` 不能用 development 标签绕过暴露登记。新题选取与独立确认组不由本入口自动推进。

示例 plan（写入后保持字节不变；占位路径和 SHA 必须替换）：

```json
{
  "schema": 1,
  "manifest": "/absolute/campaign/manifest.json",
  "manifest_sha256": "sha256-of-manifest-bytes",
  "gateway_directory": "/absolute/campaign/gateway",
  "participants": { "codex": "codex", "scriptact": "scriptact" },
  "workers": 2,
  "batches": [
    { "id": "integration", "role": "development", "attempts": [1, 2] }
  ]
}
```

`participants` 的键与 manifest 中的参与者 ID 完全一致，值为 `codex` / `scriptact`。attempt 序号从 1 开始，每个批次同题、同重复次数配对，全部批次恰好覆盖 manifest 的每个 attempt 一次。`workers` 不得超过 `manifest.resource_pool.max_active_attempts`；CPU、内存和其他 campaign 已占容量继续由共享租约约束。

网关 URL 在 `manifest.gateway.url` 冻结，例如 `http://127.0.0.1:48762`。`manifest.gateway.budget_mode = "unlimited"` 会明确传入启动器无美元上限模式，费用和未知用量仍完整记录。控制器从 plan 的 gateway 目录读取 `budget.json`，只把该目录传给启动器，不读取或输出主 token。启动器使用已有 `.velaros-workspace/bench/venv/bin/python` 环境。

## 运行与恢复

```sh
python3 scripts/agent/harbor/parallel_campaign.py \
  --plan /absolute/campaign/plan.json \
  --state-dir /absolute/campaign/checkpoints
```

省略 `--run` 时只核对元数据和生成报告，不派发模型请求。正式运行显式选择一个预声明批次：

```sh
python3 scripts/agent/harbor/parallel_campaign.py \
  --plan /absolute/campaign/plan.json \
  --state-dir /absolute/campaign/checkpoints \
  --batch integration --run
```

同一 checkpoint 由文件锁保证只有一个控制器。每次启动器派发之前，控制器先原子持久化 `dispatching`。每约 5 秒刷新请求统计和已提交结果；不会把正在写入的 job JSON 当作计量故障。每个批次结束后停止，后续批次需要显式调用。

重启时重复同一命令。已完成尝试仅重新归账；源任务与清理已结束且 replay 没有任何派发痕迹时，仅继续首次 replay。已有 job、dispatch receipt、日志、凭据或网关请求中的任何一项，都足以阻止重新开始同一来源不明的付费源任务。即使检查点记录派发后、实际创建进程前崩溃，也保持 uncertain，不假定这次没有计费。新尝试必须进入新的冻结清单，旧尝试仍保留。

普通 reward=0 或解题异常进入问题清单，其他题继续。环境/官方判分故障停止对应 participant 后续任务；身份、账本或已提交证据冲突停止所有新派发，活动任务继续安全收尾。清理/供应商结算不确定的资源租约由启动器保留。控制器收到 SIGTERM 或 Ctrl-C 后停止排新任务，只向自己已启动的 launcher 各转发一次 SIGTERM，由 launcher 取消 Harbor 并清理、结算；控制器继续持锁等它们结束并记录 interrupted。重复信号不跳过清理；不可捕获的强制终止后依然按不确定派发恢复。

确诊并处理基础设施问题后，可用 `--release-queue-after N --reason '证据与处理说明'` 允许该参与者的后续任务继续。这不会重试第 N 次尝试，也不会覆盖旧证据。身份故障与 uncertain 状态不能通过此选项解除，需先还原可核验的执行证据和资源状态。

## 产物与计量

- `checkpoint.json`：plan/manifest SHA、逐 attempt 状态、派发与结束时间、批次状态和带理由的队列恢复记录。
- `report.json`：每个 attempt 的所有身份归属请求（包含执行中、失败与迟到结算）、未知费用数、未结算数；`jobs/trials` 保存官方 reward、源异常、源/模型/工具/判分/端到端耗时、上下文峰值与维护、缓存读写及费用、分层模块和工具次数。
- `report.md`：状态、reward、请求、已知费用、未知费用、未结算请求概览。
- `issues.json`：稳定问题 ID、attempt/candidate 证据链、症状类别、责任人与验证占位。没有根因证据时保留 `unconfirmed`，不把多个不同原因的失败自动合并。
- `attempt-N-source.controller.log` / `attempt-N-replay.controller.log`：启动器日志；原始 Harbor job、逐阶段 dispatch receipt 和网关账本继续保留。

`all_attempt_requests` 按签名身份汇总，不以任务开始/结束时间划窗。已知费用是下界，真实请求缺少用量时保持 unknown；没有请求才记为零。供应商迟到结算后再次生成报告即可更新，不需重跑任务。正常运行中的 partial JSON 不参与判分；只有 phase 完成凭据和完整 job 结果一致时才进入官方结果表。

ScriptAct 底层能力操作、外层工具和 Codex 原生操作继续按各自 scope 列出，不能直接比较不同层级总次数。开发结果的 `supports_general_superiority` 恒为 false，比较是描述性的。候选、资源协议或任务分布变化后创建新的冻结清单，不能修改已有清单后续跑。

## 离线验证

```sh
cd scripts/agent/harbor
python3 -m unittest parallel_campaign_test repository_report_test request_identity_test tool_metrics_test -v
```

新增合成回归覆盖双 worker 上限、普通失败继续、参与者队列故障隔离、身份全局停排、未知派发不重发、首次 replay 恢复、凭据残留、仅账本留存、迟到结算、单 controller 锁、plan 配对/模型/推理/暴露校验、partial JSON、清理阻断及工具计数层级。测试不读取真实题目正文，不启动模型或容器。
