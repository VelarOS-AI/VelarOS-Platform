# 关闭后的历史读取合同核对

本记录先只读核对已发布基线 `70e93a2b` / `v0.7.6` / 0.9.5 的合同、实现与用例。R2 `59d61148` 的新文案不作为旧承诺；该批尚未合 main 或发行。根协调随后已选定存储 owner 方案，独立纠正已实现并通过九项最小相关证明，不增加兼容或新的公共入口。

## 旧承诺与实际入口

| 来源（70e93a2b） | 实际承诺/证据 |
| --- | --- |
| Runtime README 第 137–139 行、INV-31、INV-46 | Session.close 不关闭 Runtime，历史事实保留，活动 Runtime.trace/traceBranches 能追踪已关闭支线；INV-46 没有指定读取句柄。 |
| RuntimeSession.ts 的 VelarosSession 材料三方法、trace、close 注释 | 未声明四项读取在 Session.close 后必须 CLOSED；原实现也未设此准入。因此统一 CLOSED 是公开行为收紧，不能称只补内部关闭遗漏。 |
| act-children.test.mjs 106–114/139–150、request-presentation.test.mjs 143–164 | 关闭后读取通过活动 Runtime 或新存储 owner 完成，未证明旧 Session 句柄的寿命要求。任务材料用例只在 Runtime 仍活动时读取。 |
| ADR0029、SessionControl.ts | openSessionControl 不激活执行环境，每次复核原执行/授权绑定；lease.close 停止准入、排空已受理操作再关闭自有连接。当前公共面只有 notes、goal、分页 trace 与 traceBranches。 |
| Context README、SessionContext、ContextStorage | 独立、存活且已授权的存储 owner 可按引用分页并重组用户原文；连接关闭不删除事实。它不自动提供 RuntimeCompletedTask 固定任务范围、已接纳轮次及 Runtime 执行身份校验。 |

## 已确认的覆盖缺口

SessionControlLease 缺少 `completedTask`、`taskMaterials`、`readTaskMaterial`；`MemoryConsolidationOptions.source` 仍要求 Session 的材料读取端口。不能让产品通过解析 `script:lease-state` 等私有标题重造固定任务范围。control.trace 是分页查询，也不是 Session.trace(turnId) 的直接同签名替代。

现有 Runtime/控制 lease 可以覆盖冷 trace；独立存储 owner 的任务材料读取公共合同尚未填平。根协调已完成三产品只读核对：Workbench 的 Session.trace 在最终排空后才 close，历史/支线走 Runtime；Server 无上述 Session 读取，历史走产品 SQLite 投影；Desktop 无关闭后 Session 读取，历史和后台采集使用 Runtime 或独立只读控制 lease。三端均不需要为 CLOSED 行为做本地适配，但这一调用事实不等于公共合同已允许收紧。

## 设计判断与边界

- 存储 owner 必须排空已经受理的读取再关闭连接；这一资源修复与“关闭 Session 后禁止新读”分开决策。
- 优先保留 0.9.5 句柄的历史读取能力：把读取登记到仍活动 Runtime 的存储 owner，即使执行 Session 已退出活动表；Runtime 开始关闭后统一停止准入并排空。Session 的执行/交互关闭不必等同于其存储 owner 已关闭。
- 如果选择让 Session 全部失效，先设计独立、已授权且有关闭屏障的任务材料读取合同，再协调调用者。产品不以 catch 或重开执行 Session 兜底，读取历史不应要求激活执行环境。
- 采用存储 owner 方案：保留关闭 Session 的合法历史读取，Runtime 开始关闭时才统一拒绝新读并排空；每次复核原执行/授权身份，子会话捕获已验证的根归属，不解析 ID 或退回缺绑定路径。读取不启动模型、Kernel 执行环境或新 Session。
- 这是资源归属纠正，不能称为给旧实现留下兼容。R2 的 blanket CLOSED 不合 main、不发布；纠正独立提交，源文档和最小关闭准入/排空证明同时校准。
