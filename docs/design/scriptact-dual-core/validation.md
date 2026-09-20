# 双核实现验收记录

当前全平台推进结果见 [平台验证报告](platform-validation.md)。下列内容记录双核初次接入的验收范围。

日期：2026-09-19。仓库：`/Users/mac/Desktop/VelarOS/projects/VelarOS-Platform`。Node 24.15.0，Bun 1.3.13。验收针对当前工作树的正式代码路径。

## 实际完成阶段

| 阶段 | 状态 | 实际内容 |
| --- | --- | --- |
| Phase 1 | 完成 | 需求/计划校验、任务检查点、原始材料存储、精确解析、真实物化、版本/预算/失败反馈；实际 QuickJS + Project + SQLite 跑通 v1 → v2 → 视图 v2 → 重启继续 |
| Phase 2 | 完成接入 | 现有 ScriptAct、标准模块、主模型驱动、ProviderRequestCompiler 最终编译与请求审计；AI SDK 传输用可控模型验证 |
| Phase 3 | 完成接入 | 使用共享任务帧的有界 Context Planner，候选引用校验、有限检索/检查、只读 Source、共享模型预算、降级及完成检查 |
| Phase 4 | 机制完成，实模实验待执行 | SQLite 恢复、真正进程中止后的对账、取消及迟到结果、模式/策略切换、B0–B3 契约计量；真实供应商任务质量与成本尚无实验结论 |

## 实际检查结果

| 检查 | 结果 |
| --- | --- |
| Context + Velaros Node 集成测试 | 49 通过，0 失败 |
| Agent test 回归 | 848 通过，0 失败 |
| Agent spec 验收 | 23 通过，0 失败 |
| Kernel + Model 回归/验收 | 272 通过，0 失败 |
| Script 回归/验收 | 81 通过，0 失败 |
| Project 回归/验收 + AI SDK Provider + 编译门测试 | 611 通过，0 失败；其中 2 个编译门测试与 Agent test 重复 |
| Kernel / Context / Model / Script / Agent / Velaros | 六包构建及 typecheck 通过 |
| check:module-ownership | 通过，包含所有受治理模块 |
| Agent / Kernel / Model / Capabilities / Project 架构门禁 | 全部通过 |
| Kernel / Agent schema、Agent public API、Agent browser | 全部通过 |
| 锁文件一致性、Script 生成声明、git diff --check | 全部通过 |
| 本次核心实现文件 ESLint | 通过；范围见下方命令 |

本次没有运行整个仓库的发布总门 `bun run check`，因此上述结果不代表 UI、全部领域适配器和发布环境的全量认证。

测试合计 1,882 项不同用例通过，计数扣除了 Project/Provider 批次重复运行的两个 Agent 编译门测试。

## A01–A28 对应证据

表中 `views` 为 `packages/context/test/views.test.mjs`，`dual` 为 `packages/velaros/test/dual-core.test.mjs`，`journal` 为 `packages/context/test/context.test.mjs`。

| ID | 自动化证据 | 实际保证及边界 |
| --- | --- | --- |
| A01 | dual「A01/A28」、Phase 1 | 真项目符号定位、原文与版本；精确需求 0 次上下文模型调用 |
| A02 | views「A02/A08」、dual Phase 3 | 共享任务帧、真实候选选择、物化正文及共享用量 |
| A03 | views「A03/A18/A21」、dual「A03/A20」 | 5 MB 内容持久保存、按引用读取、主视图受容量限制 |
| A04 | views A04、dual Phase 1/2 | 写入后只有 v2 作为当前证据；主模型下一轮收到编译后的 v2 |
| A05 | views「A05/A17」及 planner 期间变 v3 | 持续变化返回缺口；候选之后再读取 v3，不把预览当当前证据 |
| A06 | dual A06 | 决策证据变更后阻止写入，较新文件保持原样 |
| A07 | views A07 | 无基线 diff 退为允许原文，或 BASELINE_MISSING |
| A08 | views「A02/A08」 | 未登记候选不能成为事实，有界修复/降级 |
| A09 | dual「A09/A13/A27」 | 规划器调用 script.run 被拒，世界写入数 0 |
| A10 | views A10、有界规划器测试 | 源文本保留数据标签；模型笔记独立；候选没有世界执行端口。不是任意提示注入免疫的证明 |
| A11 | views A11、候选范围再次校验 | 禁止源的预览不进入主视图、规划请求或计划审计；内容敏感策略由宿主 Source 实现。原始受控审计不是公开 trace |
| A12 | views A12、Agent dualCoreCompiler.test.ts | 强制用户目标超过预算时阻塞；不截断目标后发送 |
| A13 | views「A13/A27」「A13/A16/A17」、dual 恶意规划器 | 规划次数、读取、期限有界；不响应取消的源/模型/验收器不能无限占住等待 |
| A14 | dual「A14/A24」 | 第一次写入保留、后续失败可见；caught error 仍在强制反馈 |
| A15 | dual 3 个未知效果/核对测试 | 网络结果未知及真正子进程退出；持久意图恢复、核对追加事实、世界只写一次 |
| A16 | views 竞争/迟到测试、dual A16 | 取消终态保留，旧租约不能发布；已派发操作的迟到回执保留 |
| A17 | views 旧 revision / 撤销范围测试 | 旧计划不能 CAS 发布；规划前和物化/发布再检查范围 |
| A18 | views「A03/A18/A21」 | 预算淘汰同步改变覆盖；最终编译器不二次裁剪已发布正文 |
| A19 | views A19 | 派生材料继承来源读集并传播 stale；多份源证据分别保留。语义矛盾识别仍由主核判断 |
| A20 | dual「A03/A20」 | 检查点引用在 SQLite 重启后仍可恢复；当前存储保留对象，未实施对象 GC，不能声称已测 GC 算法 |
| A21 | views「A03/A18/A21」 | 即使引用存在，跨会话/当前任务范围也不能读取 |
| A22 | journal 调用日志测试 | 同 ID 不同参数返回 IDEMPOTENCY_CONFLICT；相同 ID 恢复已有事实 |
| A23 | views A23 | 领域验收期间源变化，旧测试成功不能完成当前任务 |
| A24 | dual「A14/A24」、外层无效脚本输入 | 缺少观察需求或脚本失败仍有强制反馈与恢复引用 |
| A25 | dual 三模式和四策略测试 | 世界操作只执行一次；off/shadow/active 可切换，shadow 不增加上下文模型调用 |
| A26 | views A26 及伪快照测试 | observed-at 明示弱一致性，不支持快照的 Source 不能伪称快照 |
| A27 | views「A13/A27」、dual「A09/A13/A27」 | required 语义证据不足时 completion 被阻止 |
| A28 | dual「A01/A28」及 Project 原验收 | 真实 UTF-16 文本、符号定位、二进制明确拒绝、空间外路径/符号链接拒绝 |

## 可复现命令

从仓库根目录执行。先依拓扑构建 Kernel、Context、Model、Script、Agent、Velaros；新环境可使用仓库 `bun run build`。

```sh
node --test packages/context/test/context.test.mjs packages/context/test/views.test.mjs packages/velaros/test/runtime.test.mjs packages/velaros/test/dual-core.test.mjs
bun test packages/agent/spec/acceptance.test.ts packages/agent/test
bun test packages/kernel/spec/acceptance.test.ts packages/kernel/test packages/model/spec/acceptance.test.ts packages/model/test
bun test packages/script/spec/acceptance.test.ts packages/script/test
bun test packages/velaros/project/spec/acceptance.test.ts packages/velaros/project/test packages/velaros/test/provider.test.ts packages/agent/test/dualCoreCompiler.test.ts
bun run check:module-ownership
bun run check:agent-arch
bun run check:kernel-arch
bun run check:model-arch
bun run check:capabilities-arch
bun run check:project-arch
bun run check:kernel-schemas
bun run check:agent-schemas
bun run check:agent-public-api
bun run check:agent-browser
bun run check:lockfile-consistency
bun run check:script
git diff --check
```

六个包各自执行 `bun run --cwd packages/<包名> typecheck`。ESLint 实际范围为：Context/src、Velaros/src、FoundationAgent、BoundedContextPlanner、ProviderRequestCompiler、model-stream、foundation 类型、Kernel model 类型与 ModelRequestEncoder/model-request、AiSdkModelDriver/driver 类型、ProjectContextSource。

## 计量与后续实测

`evaluation-contract-smoke.jsonl` 来自四策略测试的实际诊断输出，可重新运行测试生成。记录写入次数、主/上下文调用、已报告 token、未计量次数、视图大小和物化成本。模型为确定性测试驱动；QuickJS、SQLite 和项目事务为真实实现。测试任务验证共用执行机制，不用于比较语义任务质量。

真实实验应固定模型版本、任务集、能力/权限和总预算，注入真实主模型及上下文模型，对四策略运行相同任务，并由领域验收器计分。当前没有真实模型准确率、供应商费用、缓存收益或论文性能结论。

生产接入还需宿主装配各领域 Source、实际发布规则和验收器。当前提供 Project Source；网页、远端服务等复用同一端口接入，各自声明真实一致性能力。现有 Script 本地运行器发布认证标记为 false，部署隔离认证仍沿用原发布流程。存储对象回收及通用指标采集后端不在本次完成项中。
