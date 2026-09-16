# @velaros-ai/tool-contract

写一条 VelarOS 工具要用到的全部契约，七个能力空间共用一份：

- `toolContracts.defineRuntime(input)` / `toolContracts.createDefiner({ categoryOf, inputReuse?, contractVersion?, wrapExecute? })`：声明一条工具。装配期断言 canonical 工具 id、按工具自己的 schema 校验每条示例、编译模型面说明并过硬上限与软预算两道闸，逐 surface 再走一遍。
- `toolDescriptions`：结构化说明的渲染、判定、解析、精简与两道闸，外加各空间共用的约束句 `GlobalToolConcepts`。
- `toolSchemas`：zod schema 出 JSON Schema（一律 `io:'input'`）、发给 provider 前的稳定化、一整批工具的紧凑 schema 包。
- `toolKernelModules.define({ id, version, permissions, token, tools, resolveContext, label, mapError })`：把一个空间的工具集合挂进 VelaOS 内核；每次调用先严格解析入参，再向宿主解析一次上下文。
- `toolFailures.create(code, message, cause, { notApplied?, applied? })`：`not-applied` / `skipped` / `failed` 三种结论的统一失败信封，列表按 `ToolFailureLimits.listItems` 截。
- `toolIdentity`、`toolInputForgiveness`、`toolExamples`：工具与审批操作的身份、宽容入参的原语、示例登记表。

本包不认识回合循环、上下文治理、审批通道，也不认识任何一个空间：那些在 `@velaros-ai/agent` 与各空间自己那边。
两个入口整条引用链都不碰 Node 内置模块，渲染进程也能加载。

模块卡片见 [MODULE.md](./MODULE.md)，不变量见 [spec/invariants.md](./spec/invariants.md)。
