# @velaros-ai/context

Act 的持久上下文、原始材料引用、ModelView 和共享 store 存储。

普通宿主从 `@velaros-ai/velaros` 的 `createRuntime({ workspace, dataDir, model })` 进入，运行时会装配本包。独立宿主可以使用 `createContextRuntime`、`createContextView` 和 `createContextInvocationJournal`，并从 `@velaros-ai/context/node` 获取 `localContextStorage({ path })`。

- 原始输入、脚本和回执保存为不可变对象，活动正文由引用和驻留策略生成。
- ModelView 的证据由真实来源读取，并核验授权、版本、预算及完整性。
- store 通过 StoreStorage 持久化结构化对象、修订、订阅消息与确认；对象提交和附带消息原子落盘，默认适配器使用同一个 SQLite。
- ContextStorage 是注入边界；正文、任务状态、调用回执和共享空间沿同一存储合同恢复。

本地 SQLite 适配器要求 Node.js 22.13 及以上，在实际创建时加载 `node:sqlite`。注入其他 ContextStorage 的 Runtime 可以在禁用 SQLite 的 Node 进程中工作。模型上下文编译由 Model 包的 ProviderRequestCompiler 统一完成。

替换后端仍使用唯一入口 `createRuntime({ storage, ...options })`。实现 `ContextStorage`，需要共享对象和消息时同时实现 `storage.stores: StoreStorage`；无需改 Agent Loop、ScriptAct 或模型 API。存储需保证跨实例 CAS、正文先落盘、回执幂等与对象/消息原子提交。参见 [存储适配规范](../../docs/architecture/storage.md)；适配器合同测试在 `test/support/storage-contract.mjs`，数据库自己的崩溃恢复与持久性还需单独验证。

详细约束见 [MODULE.md](./MODULE.md)，接入与分区规则见仓库的 `docs/architecture/platform-runtime.md`。

源码统一使用 `contract/types/impl/utils`：`contract/provides.ts` 登记公开类接口，`contract/requires.ts` 声明注入端口，`types/` 保存数据和内部工作类型，类接口与实现同文件。入口和运行环境边界见 MODULE.md。
