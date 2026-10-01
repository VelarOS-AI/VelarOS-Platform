# ScriptAct 历史执行记录回顾（第 48 轮）

第 49 轮后续实现、验收及当前边界见 [剩余问题处理](LOCAL-FIXES.md)。下文记录第 48 轮审计时的状态。

本轮只读取已有记录并做本地回归。历史任务、模型、镜像、成绩、费用和冻结清单保持；不派发新的评测或模型请求。

覆盖 **149 个作业、187 次试次**：95 个源试次、44 次安装/预检、40 次重放、8 次 Oracle。187 份结果都存在；55 份 ScriptAct trace、25 份 Codex native 日志，以及 4 份仅有 ATIF 的历史其他 agent 记录纳入分析。518 份 campaign JSON 已建立可检索索引。

ScriptAct 去重后有 1,165 次宿主操作、795 次脚本执行、22 次协议拒绝和 1 次取消、8 次宿主操作失败、9 次脚本失败、130 次 Shell 非零退出。它们有包含关系，不能相加成为“总故障数”；Shell 非零也可能是正常探查。

## 本轮结论

- 确认并修复两个执行包装器遗漏：BusyBox 参数不兼容，以及预先取消时陈旧 PID 文件残留。局部 POSIX 回归验证了退出码、输出、管道、会话隔离、强制回收及独立服务存活；Alpine 的 UV/Node ABI 兼容仍待处理。
- 近期主要问题仍集中在读取粒度、重复程序、精确编辑依据、工具可用性和验证范围，不能只追求缓存命中率。已有字段补读尚缺实际采用证据。
- 7 次编辑拒绝均有合理的安全原因；保留精确定位和事务保护。新增的修复不能通过吞掉错误或自动猜测目标来减少往返。
- 旧历史改写问题已有明确修复；43 的 3 次改写由显式 release 引起。不同环境、旧 WebSocket 回退、模型版本变化及未知费用都继续约束历史比较。
- 全量轨迹重复导出是可测的次要开销；最大已观察值约 1.043 GB/14.405 秒，优先级低于模型往返和验证命令。

## 问题台账

| 编号 | 优先级 | 状态 | 问题 |
|---|---|---|---|
| R01 | P1 | 本轮本地修复 | BusyBox 会在执行命令前拒绝 setsid --wait |
| R02 | P1 | 本轮本地修复 | 预先取消时留下陈旧 PID 文件 |
| R03 | P1 | 仍待处理 | Alpine 与 GNU 运行时 ABI 不兼容 |
| R04 | P1 | 部分修复，效果或边界仍待确认 | 截断后重读与归档补读采用不足 |
| R05 | P1 | 有证据的待验证假设 | 单次模型回复重复提交相同程序和示例占位程序 |
| R06 | P1 | 模型使用问题，保护逻辑正确 | 编辑依据不精确造成拒绝和重试 |
| R07 | P1 | 仍待处理 | 工具不存在或不在实际 PATH 的探查成本 |
| R08 | P2 | 部分修复，效果或边界仍待确认 | 验证范围过大或重复验证 |
| R09 | P2 | 仍待处理 | 每轮重复导出全量轨迹 |
| R10 | P2 | 已有修复及验证记录 | 能力发现合同的额外往返 |
| R11 | P1 | 已有修复及验证记录 | 控制段缺失、未闭合与行尾空格导致协议重试 |
| R12 | P1 | 已有修复及验证记录 | 短租约退役改写历史正文 |
| R13 | P2 | 已有修复及验证记录 | 任务正文与稳定协议反复进入动态帧 |
| R14 | P1 | 已有修复及验证记录 | 只输出 stdout 时丢失 stderr 和失败诊断 |
| R15 | P2 | 已有修复及验证记录 | 完整诊断和成功状态在工作帧反复展开 |
| R16 | P1 | 已有修复及验证记录 | 模型续接、推理档位与缓存计费字段的链路完整性 |
| R17 | P1 | 已有修复及验证记录 | 超时后的容器进程与账本请求仍继续 |
| R18 | P2 | 评测结论或账本边界 | 两笔历史请求的最终用量未知 |
| R19 | P1 | 已有修复及验证记录 | Codex 原生失败被 Bash 管道吞掉 |
| R20 | P1 | 已有修复及验证记录 | 旧 Codex WebSocket 握手回退开销 |
| R21 | P1 | 已有修复及验证记录 | 镜像初始未跟踪文件导致补丁捕获错误 |
| R22 | P1 | 已有修复及验证记录 | 一次性 Shell 命令被误判为常驻服务 |
| R23 | P1 | 已有修复及验证记录 | 图片能力没有接入评测宿主 |
| R24 | P1 | 部分修复，效果或边界仍待确认 | 环境准备、镜像解析和在线安装的不稳定性 |
| R25 | P1 | 已有修复及验证记录 | Rosetta 下 Go TLS 错误污染官方判分 |
| R26 | P2 | 仍待处理 | QEMU 架构问题和排障能力仍交织 |
| R27 | P2 | 评测结论或账本边界 | Git 服务题说明与隐藏判分假设不一致 |
| R28 | P1 | 评测结论或账本边界 | 单题反复修复与候选版本变化不足以证明整体领先 |
| R29 | P2 | 已有修复及验证记录 | 工具次数的层级口径不一致 |

## 可复用的数据

- [187 次试次完整索引 CSV](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/all-trials.csv)：请求、费用、未知用量、时间、上下文峰值、缓存、脚本与协议指标，源/重放分别保留。
- [机器可读问题台账与证据哈希](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/review.json)；[原始结果与轨迹覆盖索引](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/inventory.json)。
- [去重后的执行问题信号](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/execution-signals.json)：按 job、trial、execution、invocation 定位，保存摘要与哈希而非模型思考内容。
- [逐试次完整指标](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/trial-metrics.json)；[518 份 campaign 记录索引](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/campaign-index.json)。
- [只读扫描脚本](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/scan.py)；[沿用现有口径重算指标的脚本](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/account.py)。

95 个源试次中，有些是被取消或零模型预检，不意味着 95 次已完成付费测评。84 次试次关联到账本请求；未关联请求的记录不能据此宣称历史费用为零。源码仓库任务的源阶段不判分，CSV 的原始空分必须结合重放阅读。

## 详细记录

### R01 · BusyBox 会在执行命令前拒绝 setsid --wait

**本轮本地修复 / P1**。第 44 轮原始输出明确报 unsupported wait；当前代码仍使用该参数。

改为关闭 job control 后启动独立会话，并由外层 wait 保留前台输出和退出码。4 项 POSIX 进程组测试通过；这是本地兼容验证，Alpine 整体安装仍见 R03。

实现与回归：[cancellable_environment.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/cancellable_environment.py)、[cancellable_environment_test.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/cancellable_environment_test.py)。

证据：[validation-44-setup-reproduction.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-44-setup-reproduction.json)、[cancellation-before.log](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/cancellation-before.log)、[regressions-final.log](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/regressions-final.log)。

### R02 · 预先取消时留下陈旧 PID 文件

**本轮本地修复 / P1**。沿 R01 排查发现 EXIT 清理注册晚于取消标记检查。本地复现提前退出 125 后 pid 仍存在；尚无证据表明历史任务发生过误杀。

在写 PID 和检查取消标记之前注册清理；本地断言确认命令不启动、退出码保留且 pid 删除。

实现与回归：[cancellable_environment.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/cancellable_environment.py)、[cancellable_environment_test.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/cancellable_environment_test.py)。

证据：[cancelled-pid-before.log](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/cancelled-pid-before.log)、[regressions-final.log](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/regressions-final.log)。

### R03 · Alpine 与 GNU 运行时 ABI 不兼容

**仍待处理 / P1**。第 44 轮绕过包装器直接运行仍报缺少 /lib64/ld-linux-x86-64.so.2；UV 引导及打包 Node 固定为 GNU Linux。

后续须统一选择兼容的 UV/Node 与原生依赖并冻结双方相同环境；本轮保持现有镜像、包和成绩。R01 不等于整条 Alpine 安装链已修复。

实现与回归：[environment.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/environment.py)、[prepare-linux.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/prepare-linux.py)、[prepare-codex.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/prepare-codex.py)。

证据：[validation-44-setup-reproduction.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-44-setup-reproduction.json)。

### R04 · 截断后重读与归档补读采用不足

**部分修复，效果或边界仍待确认 / P1**。55 份 ScriptAct 轨迹只有 qemu-startup 一次任务调用 memory.read 共 4 次；43/45/46/47 均为 0。第 28 轮曾出现同命令和同正文重读；当前字段补读仅有本地功能证据。

已保留预算内投影、字段读取与诊断；下一步用旧轨迹定位缺口、已交付范围和源文件变化，区分必要重读与冗余。不能把展示增加或调用减少直接当作整题收益。

实现与回归：[materials.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/materials.ts)、[ContextMemory.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/ContextMemory.ts)、[output-render.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/script/src/utils/output-render.ts)。

证据：[field-read-47-offline-replay.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/field-read-47-offline-replay.json)、[validation-47-read-behavior.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-47-read-behavior.json)、[validation-43-output-budget-offline.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-43-output-budget-offline.json)。

### R05 · 单次模型回复重复提交相同程序和示例占位程序

**有证据的待验证假设 / P1**。第 46 轮首个原始回复含 4 个 execute，3 段源码完全相同；执行约多出 2.754 秒。轨迹显示重复已存在于模型回复，解码器按声明执行。

优先审查控制示例的重复和可复制占位内容；改变引导需离线验收。不能自动去重有副作用的脚本，也不能将这 2.754 秒推广为整题可节省量。

实现与回归：[script-protocol.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/script-protocol.ts)、[ScriptTurnDecoder.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/ScriptTurnDecoder.ts)。

证据：[validation-46-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-46-scriptact-final-diagnosis.json)。

### R06 · 编辑依据不精确造成拒绝和重试

**模型使用问题，保护逻辑正确 / P1**。7 次 edit 拒绝：2 次文件不存在、2 次目标不唯一、1 次内容不同、2 次缩进不同；另有 1 次 read 参数错误。41/46/47 的错误均给候选并在写入前拒绝。

问题在路径/唯一锚点/原始空白的选择与使用；保留精确匹配及事务保护。用实际候选与前序可见代码核对，不采用模糊自动写入。

实现与回归：[text-match-feedback.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/project/utils/editing/text-match-feedback.ts)、[project-edit.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/project/test/project-edit.test.ts)。

证据：[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-40-scriptact-1/instance_future-architect__vuls__xTPWiHH/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-41-scriptact-1/instance_future-architect__vuls__LX4zapu/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-46-scriptact-1/instance_navidrome__navidrome-e1__Fumsy7w/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-47-scriptact-1/instance_navidrome__navidrome-e1__DSyTCq6/agent/traces.json)。

### R07 · 工具不存在或不在实际 PATH 的探查成本

**仍待处理 / P1**。失败回执中 34 次出现 not found 相关信号；已人工确认近期 go、gofmt、rg 的可执行程序问题，不能把全部 34 次都算成同一种故障。

离线核对真实 Shell 环境、工作目录、工具可用性和后续成功调用；优先减少失败后再问模型的往返，不向通用运行时硬编码某道题的工具路径。

实现与回归：[ShellOperations.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/shell/impl/ShellOperations.ts)、[run.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/run.mjs)。

证据：[validation-39-go-path-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-39-go-path-diagnosis.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-40-scriptact-1/instance_future-architect__vuls__xTPWiHH/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-repository-validation-47-scriptact-1/instance_navidrome__navidrome-e1__DSyTCq6/agent/traces.json)。

### R08 · 验证范围过大或重复验证

**部分修复，效果或边界仍待确认 / P2**。Flipt38 相关测试通过后继续全仓测试，触发沙箱无 Docker 服务；39 的必要验证指引后同题请求、时间和费用降低。Vuls41 的重跑还包含真实新测试错误，不能一律当作浪费。

将每条验证命令关联到前一次代码变化和验证目的；保留必要检查及失败费用，扩大范围需要具体依据。

实现与回归：[model-instructions.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/model-instructions.ts)。

证据：[validation-38-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-38-scriptact-final-diagnosis.json)、[validation-39-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-39-scriptact-final-diagnosis.json)、[validation-41-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-41-scriptact-final-diagnosis.json)。

### R09 · 每轮重复导出全量轨迹

**仍待处理 / P2**。Teleport33 累计导出约 1.043 GB、14.405 秒；27 轮约 491 MB、6.516 秒。run.mjs 每轮重新读取并序列化全部历史。

后续可设计增量记录与完整终态快照；先保证崩溃恢复、实时诊断和最终逐字段一致。各计时区间可能重叠，不能简单从墙钟中扣除导出时间。

实现与回归：[run.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/run.mjs)。

证据：[trace-export-29-audit.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/trace-export-29-audit.json)、[validation-33-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-33-scriptact-final-diagnosis.json)。

### R10 · 能力发现合同的额外往返

**已有修复及验证记录 / P2**。27 的已有诊断推动 28 只常驻 shell.run 与 project.edit 的完整生成声明；索引和其他能力仍可发现。

已有实现和真实程序回归。保持完整类型与权限边界；指定操作的局部优势不代表所有任务都应常驻更多合同。

实现与回归：[StandardModules.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/StandardModules.ts)、[host-instructions.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/test/host-instructions.test.mjs)。

证据：[selected-contracts-28-local-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/selected-contracts-28-local-validation.json)。

### R11 · 控制段缺失、未闭合与行尾空格导致协议重试

**已有修复及验证记录 / P1**。共 22 次 SCRIPT_PROTOCOL 拒绝，另有 1 次取消。17 次缺少决策，5 次闭合/嵌套问题；第 28 轮之后的有轨迹实测未再记录协议拒绝。

固定协议前缀、明确闭合边界、完成控制先行和尾空格兼容已有实现与回归；继续保留拒绝整批后只执行一次的语义。重复合法段另列 R05。

实现与回归：[ScriptTurnDecoder.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/ScriptTurnDecoder.ts)、[script-protocol.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/script-protocol.ts)、[text-runtime.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/test/text-runtime.test.mjs)。

证据：[blob-boundary-22-repair.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/blob-boundary-22-repair.json)、[completion-first-29-local-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/completion-first-29-local-validation.json)。

### R12 · 短租约退役改写历史正文

**已有修复及验证记录 / P1**。开发12 的 44 次历史转换有 41 次改写与退役；38/39/40/41/42/45/46/47 为 0。43 的 3 次改写对应 3 次显式 memory.release。

segment 租约与冻结历史已有修复。显式释放是允许的状态变化，不能为了命中率取消释放或无条件保留所有正文。

实现与回归：[RecentContext.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/RecentContext.ts)、[ProgramContext.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/impl/ProgramContext.ts)、[context-memory.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/test/context-memory.test.mjs)。

证据：[scriptact-codex-segment-01.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/scriptact-codex-segment-01.json)、[sol-repository-repair-17-scriptact-1-history-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/sol-repository-repair-17-scriptact-1-history-diagnosis.json)。

### R13 · 任务正文与稳定协议反复进入动态帧

**已有修复及验证记录 / P2**。既有任务交付审计确认同一任务正文重复变化会扰动稳定前缀；22 已按原序号放入历史，协议固定部分也已移入系统说明。

已有任务顺序、授权重置、封段和重启回归；本轮不改缓存容量。

实现与回归：[context-memory.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/context-memory.ts)、[context-memory.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/test/context-memory.test.mjs)。

证据：[task-history-22-local-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/task-history-22-local-validation.json)、[context-task-prefix-audit-21.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/context-task-prefix-audit-21.json)。

### R14 · 只输出 stdout 时丢失 stderr 和失败诊断

**已有修复及验证记录 / P1**。19 的失败排障暴露 stderr 未交付；20 用真实 Runtime 回归复现并修复。

Kernel 独立诊断回执与 Shell 有界诊断保留，成功聚合也保留错误线索。

实现与回归：[OperationRuntime.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/kernel/src/impl/runtime/OperationRuntime.ts)、[results.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/shell/utils/results.ts)、[operation-diagnostics.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/kernel/spec/operation-diagnostics.test.ts)。

证据：[command-feedback-20-local-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/command-feedback-20-local-validation.json)。

### R15 · 完整诊断和成功状态在工作帧反复展开

**已有修复及验证记录 / P2**。24/26 已对交付后的诊断和同类成功回执作有据可回退的历史引用与分组；缓存率改善并不总伴随整题时间或费用下降。

失败、未知/部分效果和新增诊断继续单列；以完整尝试指标评价收益。

实现与回归：[context-memory.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/utils/context-memory.ts)、[context-memory.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/act/runtime/test/context-memory.test.mjs)。

证据：[diagnostic-history-24-local-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/diagnostic-history-24-local-validation.json)、[sol-repository-repair-26-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/sol-repository-repair-26-diagnosis.json)。

### R16 · 模型续接、推理档位与缓存计费字段的链路完整性

**已有修复及验证记录 / P1**。早期 GPT 系列识别、续接状态和缓存字段持久化均有修复记录；当前 TS 链路与对应验收已纳入上次提交。

保留完整原始响应所对应的续接状态，费用按请求价格快照计算；不能伪造历史 reasoning 或把输出中的 reasoning token 再计费。

实现与回归：[continuation.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/model/src/utils/wire/continuation.ts)、[continuation.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/model/spec/continuation.test.ts)、[acceptance.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/model/spec/acceptance.test.ts)、[model-continuation.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/kernel/spec/model-continuation.test.ts)。

证据：[scriptact-codex-continuation-01.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/scriptact-codex-continuation-01.json)、[REPORT.md](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/REPORT.md)。

### R17 · 超时后的容器进程与账本请求仍继续

**已有修复及验证记录 / P1**。07 两道 QEMU 存在 agent 阶段结束后新请求；旧取消探针确认进程心跳继续。08 的新协议加入进程组回收、供应商串行与费用归属尾段。

保留历史失败和全部费用。通用取消链已有修复，本轮补齐 BusyBox 与提前取消边界；最终格式/范围回归通过。

实现与回归：[cancellable_environment.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/cancellable_environment.py)、[budget-proxy.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/budget-proxy.mjs)、[report.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/report.py)。

证据：[cancellation-probe-20260928T120108Z.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/cancellation-probe-20260928T120108Z.json)、[execution-protocol-amendment-01.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/execution-protocol-amendment-01.json)。

### R18 · 两笔历史请求的最终用量未知

**评测结论或账本边界 / P2**。分别归属 sol-pilot-03-codex 和 validation31 Codex。当前保守预算仍预占，已知费用仅是已结算请求的估算。

维持未知标记和预占；没有服务商结算证据时不能清零、猜测费用或把该尝试当作费用完整样本。

实现与回归：[budget-proxy.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/budget-proxy.mjs)、[metrics.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/metrics.py)。

证据：[before.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/before.json)、[trial-metrics.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/trial-metrics.json)。

### R19 · Codex 原生失败被 Bash 管道吞掉

**已有修复及验证记录 / P1**。31 的 turn.failed 曾被外层成功状态掩盖；32 增加 pipefail、原生终态识别和网关错误分类。

原 reward 与原异常分别保留，评测成功必须同时有官方正确性与正常原生终态。

实现与回归：[repository_agents.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_agents.py)、[report.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/report.py)、[repository_test.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_test.py)。

证据：[validation-31-codex-terminal-failure-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-31-codex-terminal-failure-diagnosis.json)、[validation-32-harness-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-32-harness-validation.json)。

### R20 · 旧 Codex WebSocket 握手回退开销

**已有修复及验证记录 / P1**。32 的离线传输探针复现 7 次握手后回退；显式 Responses HTTP 改为一次 POST。25/27 等旧成绩包含该开销。

现有传输配置已修复。保留旧耗时并标注协议差异，不能用当前配置冒充历史公平环境。

实现与回归：[portable_codex.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/portable_codex.py)、[repository_report.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_report.py)。

证据：[validation-32-transport-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-32-transport-validation.json)。

### R21 · 镜像初始未跟踪文件导致补丁捕获错误

**已有修复及验证记录 / P1**。NodeBB34 在模型前被干净目录检查拒绝；35 改为临时 index 记录真实初始树，覆盖文本、二进制、提交及删除。

已有真实仓库回归与同镜像历史证据，保持 HEAD/index/原文件和原始失败记录。

实现与回归：[repository_agents.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_agents.py)、[repository_test.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_test.py)。

证据：[validation-35-initial-state-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-35-initial-state-validation.json)。

### R22 · 一次性 Shell 命令被误判为常驻服务

**已有修复及验证记录 / P1**。nginx -t、command -v/-V 与 redis-server --daemonize yes 的错误分类曾引出后台查询和额外往返。

命令策略已有分类修复和真实 Shell 回归，真实前台服务及显式后台语义保留。

实现与回归：[command-policy.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/shell/utils/command-policy.ts)、[shell-command.test.ts](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/packages/velaros/shell/test/shell-command.test.ts)。

证据：[validation-36-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-36-scriptact-final-diagnosis.json)、[validation-37-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-37-scriptact-final-diagnosis.json)。

### R23 · 图片能力没有接入评测宿主

**已有修复及验证记录 / P1**。07 chess 出现图片输出失败，19 次请求且零分；10 启用正式图片能力后同题 7 次请求、官方通过。

现有图片装配和真实请求验收保留；该任务已成为开发证据，单题改善不等于泛化结论。

实现与回归：[run.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/run.mjs)、[harbor.test.mjs](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/harbor.test.mjs)。

证据：[images-development-01.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/images-development-01.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-development-10-images-scriptact/build-cython-ext__bAMkXMi/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-development-10-images-scriptact/chess-best-move__6cZ77VT/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-development-10-images-scriptact/fix-code-vulnerability__8Jhyhdq/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-development-10-images-scriptact/regex-log__HsnaSwS/agent/traces.json)。

### R24 · 环境准备、镜像解析和在线安装的不稳定性

**部分修复，效果或边界仍待确认 / P1**。早期在线安装超时、OCI 索引 Accept 缺失、下载中断和磁盘不足均有记录；已有固定运行时打包、索引校验、续传摘要和容量预检。

已知修复保留，最新 Alpine ABI 缺口单列 R03。准备失败与代码能力分开，不改官方时限或抹去原失败。

实现与回归：[prepare-linux.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/prepare-linux.py)、[repository_resolve.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_resolve.py)、[repository_images.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_images.py)。

证据：[validation-31-index-resolution-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-31-index-resolution-validation.json)、[validation-34-recovery-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-34-recovery-validation.json)。

### R25 · Rosetta 下 Go TLS 错误污染官方判分

**已有修复及验证记录 / P1**。Teleport32 既有补丁与官方参考都出现同类 TLS 错误；33 的 CPU 特性兼容配置使原补丁官方重放通过，新增模型调用为 0。

共享环境配置已有修复；两方历史源环境不同的记录继续单列，不能据此宣称严格效率领先。

实现与回归：[repository_launch.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_launch.py)、[repository_report.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_report.py)。

证据：[validation-33-rosetta-go-tls-validation.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-33-rosetta-go-tls-validation.json)、[validation-32-teleport-codex-replay-avx2-off.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-32-teleport-codex-replay-avx2-off.json)。

### R26 · QEMU 架构问题和排障能力仍交织

**仍待处理 / P2**。07 两道 QEMU 超时含 Rosetta syscall 282；08 Codex 在同类症状下解决 startup，但 alpine-ssh 仍超时，且协议版本不同。

保留环境症状与策略差距两个维度，不将失败全归因于模型或环境。当前只能分析旧启动与恢复序列，环境消歧尚不完整。

实现与回归：[metrics.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/metrics.py)。

证据：[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/chess-best-move__eowBVug/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/configure-git-webserver__MEamfuh/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/log-summary-date-ranges__4pFUFgr/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/polyglot-c-py__HUPrHLJ/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/qemu-alpine-ssh__bDXXvay/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/qemu-startup__ccNEwMu/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/sqlite-with-gcov__qza2aFi/agent/traces.json)、[result.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-08-codex-recovery/chess-best-move__4BLT65j/result.json)、[result.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-08-codex-recovery/polyglot-c-py__L6uhdEG/result.json)、[result.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-08-codex-recovery/qemu-alpine-ssh__6B9gEZ5/result.json)、[result.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-08-codex-recovery/qemu-startup__BuqsM4t/result.json)、[result.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-08-codex-recovery/sqlite-with-gcov__KC4sGuP/result.json)。

### R27 · Git 服务题说明与隐藏判分假设不一致

**评测结论或账本边界 / P2**。已有任务审计记录账户/登录假设差异；07 按任务部署与验证后，最终官方 HTTP 仍为 404。

保留官方零分与适用范围限制；不将隐藏测试假设写进通用提示或产品逻辑。

实现与回归：[metrics.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/metrics.py)。

证据：[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/chess-best-move__eowBVug/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/configure-git-webserver__MEamfuh/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/log-summary-date-ranges__4pFUFgr/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/polyglot-c-py__HUPrHLJ/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/qemu-alpine-ssh__bDXXvay/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/qemu-startup__ccNEwMu/agent/traces.json)、[traces.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/jobs/sol-validation-07-scriptact/sqlite-with-gcov__qza2aFi/agent/traces.json)、[REPORT.md](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/REPORT.md)。

### R28 · 单题反复修复与候选版本变化不足以证明整体领先

**评测结论或账本边界 / P1**。Vuls41 与 Navidrome46 的时间和费用均相对前版退步；Navidrome47 仍比 Codex 贵约 38%，第45轮更快且更便宜。所有旧尝试保留。

按当前暂停评测的要求，仅用现有记录建立版本/任务/环境矩阵；保持预注册参考和全尝试费用，不择优拼接总胜率。

实现与回归：[repository_report.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/repository_report.py)、[COHORT.md](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/COHORT.md)。

证据：[validation-41-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-41-scriptact-final-diagnosis.json)、[validation-47-scriptact-final-diagnosis.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/campaign/validation-47-scriptact-final-diagnosis.json)。

### R29 · 工具次数的层级口径不一致

**已有修复及验证记录 / P2**。旧报告将 Codex 外层 tool call 与 ScriptAct 宿主操作直接相比；44 已区分 native command/file-change 与 ScriptAct script/host operation。

本轮读取25份 native日志，沿用线程范围去重；次数按各自层级保留，不把一个批处理当作一次底层操作。

实现与回归：[metrics.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/metrics.py)、[metrics_test.py](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/metrics_test.py)。

证据：[REPORT.md](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/scripts/agent/harbor/REPORT.md)、[trial-metrics.json](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/trial-metrics.json)。

## 验证与适用范围

本轮 55 项相关 Python 本地回归通过，包含 4 项新增取消/等待测试；格式、模块所有权与 diff 检查通过。BusyBox 命令行边界由拒绝扩展选项的测试替身验证，进程组和信号使用真实 POSIX 机制；本轮没有重跑 Alpine 镜像安装或官方题目。

原始模型账本在本轮前为 1,620 次请求、已知估算 $44.1233191、保守占用 $122.8703382 / $1,000。结束时另存零新增调用校验。两笔历史未知用量继续预占。新执行包装器尚未进入任何冻结评测清单，旧清单和旧成绩完整保留。

优先顺序：先闭合取消/环境兼容缺口；再基于旧记录逐项分析读取和编辑依据；然后处理工具探查、验证范围与日志导出。当前阶段不新增付费任务，也不据局部修复宣称整题效率改善。

终验：[零新增调用与原始记录完整性证明](/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform/.velaros-workspace/bench/retrospective-48/final-checks.json)。1620 次请求与费用账前后相同，267 份结果/轨迹文件和 518 份 campaign JSON 摘要逐一核对未变。
