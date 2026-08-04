# Agent Lab 宿主接入手册

## 接入真实任务

宿主在普通产品执行完成后保留可关联事实，不在热路径调用评测器：

1. 每轮生成稳定 `runId`，并把触发它的 `rootInputId` 写入 run span。
2. 记录 `run/turn/model/tool/capability/policy` 的收敛 span；外部引擎至少记录 run/turn/tool。
3. 采集器按 session/run 读取 span、会话标题/工作区/消息和产物，只归一化已有事实。
4. 验收器从真实工作区或产品状态读证据；命令直启 argv，路径不能逃逸工作区。
5. 用户接受/拒绝作为独立 sidecar evidence，重新审计时合并。
6. 默认记录不包含 prompt/answer；只有本地显式排障才包含，HTML 报告始终不包含。

`auditRealTask(record)` 不做 I/O、不调用模型。宿主用 `writeRealTaskBundle` 原子写
`record.json`、`assessment.json` 和 `report.html`。

## 固化问题

调用 `promoteRealTaskCase` 前必须人工提供：

- 审阅后的 prompt；
- `git commit` 或 archive 等可重建 workspace reference 与 source path；
- 至少一条确定性 acceptance contract；
- `redacted` 或 `shareable` 隐私结论与说明。

工作区当前脏状态不能用 `HEAD` 冒充快照。宿主应拒绝猜测 reference；不能重建的任务可以保留审计记录，
但不应伪装成可复现案例。

## 显式复跑

把一个 `RealTaskCase` 投影成单 leg Journey：setup 在隔离根恢复 snapshot，prompt 原样执行，criterion 读取
case acceptance。默认一个 executor、一个 replicate、concurrency=1。复跑仍使用原生 Driver 的权限、审批、
中止与 settle 行为；执行体不可用是 attrition，不是 0 分。

Driver 基建可保留一个最小 probe 验证真实 app 发送、写入、存储和 verifier 链，但 probe 只诊断 harness，
不能被称为产品能力回归。

## 新验收类型

先扩 `RealTaskAssertionKindSchema`，再由宿主实现读取面。读取面不存在时返回 `unknown`；不能退化成“回答包含
关键词”或“调用过某工具”。产物 evidence 只保存相对路径、大小、哈希和 provenance，大正文留在原 owner。

## 新执行体

外部执行体保留原生提示、工具、审批和恢复语义。宿主将其流事件桥到共享 execution span factory；模型、token
或 cost 没有可靠字段时留空并记录 gap。观测失败是旁路故障，不能影响任务主链。
