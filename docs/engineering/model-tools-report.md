# 主线与模型工具：实现交付报告

这套方案已经接入正式 Platform。主线负责持续推进用户任务；业务子 Agent 接受主线派发；搜索、上下文整理作为按需模型工具，各自在独立会话内完成一件事。它们使用同一个 RuntimeSession、ActLoop、ScriptAct、Kernel、ContextStorage 和 ProviderRequestCompiler。

## 模型真正能看到什么

| 当前角色 | 业务能力 | 模型工具 | 派发子 Agent |
| --- | --- | --- | --- |
| 主线 | 宿主装配的能力 | 已配置的搜索与上下文整理 | 宿主配置的业务子任务 |
| 业务子 Agent | 主线授权的模块与写入范围 | 已授权搜索、上下文整理 | 能力集合中无此成员 |
| 搜索 | 只读证据检索与本会话状态 | 叶子 | 叶子 |
| 上下文整理 | 固定父快照读取与本会话状态 | 叶子 | 叶子 |

这套划分发生在装配阶段。缺少的能力不会出现在 `modules.list/search`、`modules.describe`、系统包整体模板、TypeScript 声明或脚本运行绑定中。错误代码手写一个未注入的导入会在运行前检查失败。Kernel 与活动管理器继续验证调用身份，防止宿主内部错误绕开装配。

脚本使用方式保持简单：

```js
import { output } from 'velaros';
import { context } from 'velaros:system';
output(await context.request({ targetChars: 24000 }));
```

这条操作在当前 execute 中登记请求，返回 `status: "scheduled"`。当前脚本正常完成；下一次发给业务模型之前，Runtime 完成整理。`context.status({})` 查看结果，`context.reset({})` 恢复宿主默认展示预算。

## 一次整理实际如何运行

1. 当前业务脚本完成，稳定观察产生本轮结果。
2. 主循环检查最终请求的容量，或发现模型显式安排的整理请求。
3. Runtime 固定父会话材料版本，创建一个独立的整理会话，预留最终交付预算。
4. 整理模型收到任务快照和材料入口。它通过 `velaros:context-materials.list/read` 分页读取原文，使用同样的 execute/done 协议工作。
5. 模型输出 ContextPatch，说明笔记、用户意图、历史、结果可见性及观察展示量如何调整，同时保留未查明事项。
6. Runtime 检查版本、保护引用与每个修改项；全部合法后通过一次 CAS 发布。原始用户输入、源码与结果继续在原存储中。
7. 原业务会话重新组装五分区上下文，经 ProviderRequestCompiler 校验后，以 work 请求继续任务。

整理不会重跑已执行脚本，不会因重编译多执行一次 observe，也不会消费父会话的业务结果租约。新用户输入会打断旧整理；旧快照的补丁不能覆盖新意图。下一业务轮仍由现有 observe 脚本采集新数据，整理策略只约束其展示量。

如果整理模型没有交付补丁，主线能看到失败回执，Runtime 尝试引用投影。基础目标、当前用户图片和必要运行状态仍必须通过最终窗口检查；放不下则明确 context_blocked。搜索和整理遇到自己的容量或预算预警时，会先收到最后交付提醒，输出已有证据及缺口，最后受硬上限约束。

## 本次执行测试得到的数据

下列是受控模型驱动发出确定响应后，由真实 ActLoop、ScriptAct 隔离执行器、Kernel 和 SQLite 存储跑出来的计数；模型回答由测试提供。

一次“主线派发业务子任务，子任务调用上下文整理”的测试记录：

```json
{
  "rootBusinessRequests": 2,
  "childBusinessRequests": 2,
  "maintenanceRequests": 1,
  "rootBranchCalls": 3,
  "rootInputTokens": 23,
  "childBranchCalls": 1,
  "childInputTokens": 23
}
```

根账本中的三个支线调用，是子任务的两次模型请求加整理的一次请求。整理模型在测试中上报 23 个输入 token；同一消耗各记入根与直接父任务的账本一次。这是祖先预算归属，不是三次重复计费。该测试把实际模型并发设为 1，仍正常完成，等待工具结果不会占住模型请求槽。

另一个 Provider 超窗恢复测试得到：父模型两次请求，独立整理模型一次请求，父 observe 执行一次，父业务 execute 执行零次；整理生成的笔记进入恢复后的父请求。

## 预算与宿主配置

| 范围 | 缺省任务额度 | 说明 |
| --- | --- | --- |
| 主线 | 100,000 次模型调用、1 亿 token；单次运行 10,000 回合、24 小时 | 大总额度；每个模型窗口仍独立校验 |
| 业务子任务 | 512 次模型调用、400 万 token；单次运行 256 回合、1 小时 | 同时受祖先剩余额度约束 |
| 上下文整理 | 24 次调用、100 万 token、20 分钟 | 最后一轮预留 65536 token、90 秒 |
| 搜索 | 宿主命名 profile | 沿用已有可配置档位、继续能力和证据校验 |

`modelTools` 配置公共活动树与实际模型并发；`agents.profiles` 配置业务能力及预算；`context.maintenance.model/profile` 配置整理工具。默认最多是主线、业务子任务、叶子工具三层。模型能力和任务总预算分别管理。

## 实际完成与验证

已完成能力集合投影、固定层级调度、全部祖先预算结算、搜索共用生命周期、独立整理模型工具、原子上下文补丁、自动容量触发、显式整理操作、取消与新输入处理、目录/模板/契约和正式包检查。

| 验证 | 结果 |
| --- | --- |
| Act Runtime / System / Search / Agents 集成回归 | 242 / 242 通过 |
| Agent 验收、请求编译、Provider 多模态与协议 | 33 / 33 通过 |
| ScriptAct 执行器、Context 通知、Kernel 审批 | 70 / 70 通过 |
| Context SQLite 与视图 | 25 / 25 通过 |
| Agent / Velaros 构建、Velaros 类型检查 | 通过 |
| 模块治理、Agent 架构、公共 API、操作 schema | 通过 |
| Script 契约、Act 目录、锁文件一致性 | 通过 |
| Velaros 安全打包，包含两份新模板 | 通过 |
| diff 空白检查 | 通过 |

共 370 项上述运行测试通过。另有 Script 契约生成检查中的测试，作为门禁独立执行。

真实模型的语义整理质量、真实搜索成本和长时间生产负载尚未进行在线评估。本次证明的是执行、能力隔离、预算、版本、取消和上下文发布机制；不把测试驱动的回答质量当作真实模型能力。

## 代码入口

- [ComposedRuntime](../../packages/velaros/act/runtime/impl/ComposedRuntime.ts)：按角色装配模型、模块与会话。
- [ModelToolRuntime](../../packages/velaros/act/runtime/impl/ModelToolRuntime.ts)：活动归属、并发、祖先预算。
- [ModelToolActivation](../../packages/velaros/act/runtime/impl/ModelToolActivation.ts)：软收尾与硬上限。
- [ContextMaintenance](../../packages/velaros/act/runtime/impl/ContextMaintenance.ts)：独立整理会话和生命周期。
- [ContextMaintenanceState](../../packages/velaros/act/system/impl/ContextMaintenanceState.ts)：固定快照及原子补丁。
- [ContextModule](../../packages/velaros/act/system/impl/ContextModule.ts)：对模型开放的操作定义。
- [ActLoop](../../packages/agent/src/impl/ActLoop.ts)：轮边界整理与请求重编译。
- [实际操作清单](../../packages/velaros/act/README.md)、[差量与验收变更](model-tools-delta.md)。

仓库原有未提交工作保留；本轮没有提交或推送。
