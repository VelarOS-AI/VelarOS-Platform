# @velaros-ai/shell-command

agent 代跑一条 shell 命令的能力，所有空间共用一份：

- `shellCommandPolicy.analyze(command)`：执行前分类——是否只读（白名单加整体否决，拿不准一律非只读）、是否危险及理由（黑名单）、是否长驻服务、可能占用的端口。
- `shellCommandPolicy.isParallelSafe(input, { optIn })`：一次调用能不能和别的调用并发。
- `shellCommandPolicy.confirmationMessage(...)`：危险或长驻命令的确认文案。
- `shellCommandApproval.dangerous(...)`：危险命令的审批请求（高风险、手动、不可记忆），操作身份跨入口一致。
- `shellOperations`：代码面 `velar:shell` 的三个操作（`run`、`listTasks`、`refreshEnvironment`）。空间注入 `ShellSpacePort`：
  命令在哪儿跑、越界算不算、确认文案怎么写、谁真正起进程，都由端口说了算；模型那边只有一套说明。

本包不起进程、不读写文件；根入口渲染进程也能加载。`./contracts` 只有常量与可移植数据类型。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)，代码模版见 [templates/shell.js](./templates/shell.js)。
