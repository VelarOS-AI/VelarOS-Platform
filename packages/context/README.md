# @velaros-ai/context

Act 的持久上下文、原始材料引用、ModelView 和共享 store 存储。

普通宿主从 `@velaros-ai/velaros` 的 `createRuntime({ workspace, dataDir, model })` 进入，运行时会装配本包。独立宿主可以使用 `createContextRuntime`、`createContextView` 和 `createContextInvocationJournal`，并从 `@velaros-ai/context/node` 获取 `localContextStorage({ path })`。

- 原始输入、脚本和回执保存为不可变对象，活动正文由引用和驻留策略生成。
- ModelView 的证据由真实来源读取，并核验授权、版本、预算及完整性。
- store 在同一个 SQLite 中持久化结构化对象、修订、订阅消息与确认；对象提交和附带消息原子落盘。
- ContextStorage 是注入边界；正文、任务状态、调用回执和共享空间沿同一存储合同恢复。

本地 SQLite 入口要求 Node.js 22.13 及以上；不在浏览器或 Bun 中加载此入口。模型上下文编译由 Model 包的 ProviderRequestCompiler 统一完成。

详细约束见 [MODULE.md](./MODULE.md)，接入与分区规则见仓库的 `docs/architecture/platform-runtime.md`。
