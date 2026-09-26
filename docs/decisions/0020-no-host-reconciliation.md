# 0020: 效果不明不再等宿主核对

- Status: accepted
- Date: 2026-09-26
- Owners: `@velaros-ai/context`（任务状态）、`@velaros-ai/agent`（运行与子任务状态）、`@velaros-ai/velaros`（act 运行时）

## Context

一次写操作中途失败或进程被打断，运行时分不清写没写进去，就把效果记成未知。之后它不许开下一步、不许收尾、
不许写入、不许换新任务（`NEEDS_RECONCILE`），运行停在 `needs_reconcile`，等宿主调 `session.reconcile()`。
Desktop 从来没有调用它，也没有对应的卡片；能力里只有系统存储登记了核对器。于是一出现未知效果，会话就卡死，
下一条消息也被同一道检查挡回来。用户的裁决：设计是除了危险命令不弹卡，这个核对没用就删掉。

## Decision

- 删掉所有因效果不明而挡路的检查：开下一步、写入前、收尾、换新任务、子任务未知效果向父任务的传播。
- 删掉任务状态 `needs-reconcile`、运行状态 `needs_reconcile`、子任务状态 `needs_reconcile`、交付状态 `needs-reconcile`
  与完成检查的 `recovery: 'reconcile'`；宿主入口 `session.reconcile()` 删除。
- 效果不明的操作照实留在结算事实里，模型每一帧都看得见，自己去查（读文件、`git status`、读存储）。
- 上次停在执行中途（进程退出、崩溃、后台收尾失败）或被取消时，下一次 `submit` 或 `script` 开始前自动按持久日志收拾：
  中断的脚本记成失败、不重跑，调用效果照日志记，领域登记了核对器的照核对结果记，取消之后才落定的照实补记，
  没收尾的子任务记成中断。`begin` 遇到没收拾的中断执行抛 `TASK_INTERRUPTED`（运行时总是先收拾，产品里走不到）。

## Alternatives

- **保留闸，另做一张「请核对」卡片**：用户要自己判断一个写入落没落地，这正是模型用读操作就能做的事。否决。
- **只在「完全访问」下放行**：模式越多越难懂，而闸在任何模式下都没有出口。否决。

## Security and privacy

脚本照旧不会被自动重放；危险命令确认与空间边界不变。模型看得到哪些写入效果不明，决定下一步前可以先查。

## Compatibility and migration

破坏性改动：`@velaros-ai/agent` 升到 9.0.0（`ActRunStatus`、`AgentJob.status`、`ModelToolDelivery.status` 去掉
`needs_reconcile` / `needs-reconcile`，完成检查去掉 `recovery: 'reconcile'`）；`VelarosSession.reconcile` 删除；
`ContextTaskStatus` 去掉 `needs-reconcile`。已存的旧数据照常读：任务状态读成 `context-pending`，
运行结束状态展示成 `failed`，子任务读成 `interrupted`。

## Validation

context INV-4、agent INV-38、act 运行时 INV-28、INV-55 按新语义改写；`completion-recovery`、`act-children`、
`dual-core`、`task-lifecycle`、`program-context`、`text-runtime` 的核对用例改成「不挡、下一轮自动收拾、不重放」。

## Consequences

一次写入效果不明不再让会话卡死；模型要自己确认现状再继续。崩溃重启后在旧租约过期之前（6 分钟）发消息，
仍会因为租约被占而失败，过期后自动收拾。
