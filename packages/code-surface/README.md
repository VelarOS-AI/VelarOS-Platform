# @velaros-ai/code-surface

代码面：模型写一段程序，用生成出来的能力声明把事情一次办完，而不是一次一个工具地调。

- `codeProgramChecker.check({ source, declarations })`：执行之前的那道门。程序是 JavaScript，但照样受 TypeScript 检查（类型从声明里推）——字段拼错、读不存在的字段、入参形状错、输出被截断，都在这里拦下，报错直接给出正确的名字。
- `createCodeSurfaceSession({ checker, runner, capabilities, events })`：办完一次程序——查体量、检查、隔离里执行、把程序发的能力调用转给宿主、编成给模型看的结果。
- `nodeSubprocessCodeRunner`：开发期用的隔离运行器（`node --permission` 子进程）。**不可发版**：它挡不住网络，正式版换 WASM 里的 QuickJS。

程序发出的每一次能力调用都转回宿主，审批、危险判定、运行事件仍在原来那道端口后面；文件内容这类大字符串走 `blobs` 不进源码，避免多层转义。
