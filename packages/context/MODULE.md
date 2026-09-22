# @velaros-ai/context

## 这是什么
原始记录、材料、任务检查点与双核证据视图的统一权威。通过原子提交在下一次模型请求使用新工作集，原文保留为不可变对象。
## 提供什么
根入口 `.` 提供会话、证据和调用日志工厂；`./contracts` 提供数据和常量，`./node` 提供本地适配器。
`createContextRuntime` 返回 `ContextRuntime`。`./node` 的 `localContextStorage` 返回 `ContextStorage`；`./contracts` 提供可移植数据。公共配置为 `ContextRuntimeOptions` 和 `LocalContextStorageOptions`。
`createContextView` 返回 `ContextViewApi`，通过 `ContextSourcePort` 读取真实证据，`ContextPlannerPort` 提供有界候选决策；`ContextCompletionPort` 负责领域验收。配置为 `ContextViewOptions`、`ContextBuildOptions`。

`ContextStorage.records` 以 `ContextRecordQuery` / `ContextRecordPage` 分页查询元数据；`collect` 以 `ContextObjectCollection` / `ContextObjectCollectionResult` 核对孤立对象回收。两个方法对外部适配器可选，LocalContextStorage 实现索引路径。`ContextViewApi.preview` 仅组装候选而不发布；`begin` 明确 continue/new 任务边界。

`createTurnContextSessionLedgers`、`createTurnContextAppendHub` 保存浏览器等来源的活动差量，换代保持稳定游标语义；接口为 `TurnContextSessionLedgersApi`、`TurnContextAppendHubApi`、`TurnContextAppendBus`、`TurnContextLedgerOptions`。

`ContextStorage.selectSnapshot` 以 ContextRecordSelection 选择精确标题、字面前后缀、引用、类型或序号，可对每个选择取最新项、最后 N 项或每个标题的最新版本；ContextRecordSnapshot 返回同一版本的元数据和去重排序后的所选记录。SQLite 用单一读事务保持一致性，旧适配器继续 load 完整快照。所选记录不能作为完整 CAS 的替换目录。

`ContextStorage.stores` 为可选 `StoreStorage` 端口，LocalContextStorage 在同一 SQLite 连接中提供持久 JSON 对象、CAS、删除墓碑、调用幂等回执和有界变更流。StoreObject/Mutation/Watch/Changes/Page 描述对象、订阅与分页，StoreLimits 固定大小和保留上限。对象不随上下文租约或会话原文回收而删除。空间经 create 显式建立；store_catalog/store_creations 保存目录和创建回执，store_heads/store_objects/store_changes/store_consumers/store_commits 保存每个 store 的序号、对象、事件、订阅与提交回执。scope 表示宿主边界，store 表示具体空间。

ContextTaskState.storeRefs 保存当前任务使用的 store ID；由装配层通过原会话 CAS 合并，任务边界控制驻留，引用不改变对象数据的生命周期。

公开日志工厂 `createContextInvocationJournal` 返回 `ContextInvocationJournalApi`；来源访问工厂 `createEvidenceAccess` 返回 `EvidenceAccessApi`。`TurnContextAppendListener` 是活动通知回调。

公开常量：`ContextLimits`、`DefaultContextViewLimits`、`StoreLimits`；JSON Schema：`ContextTargetSchema`、`ContextTimeSchema`、`ViewIntentSchema`、`ContextPlannerSchema`、`TaskCapsuleSchema`。

## 骨干链路
先写对象，再提交元数据与工作集。单条归档优先使用可选的 ContextStorage.appendRecord，在同一事务内验证正文、来源与身份，递增记录序号和状态版本；未提供时使用完整 CAS。任务续租、预算与用量优先通过可选 loadMetadata/compareAndSwapMetadata 读写 ContextMetadata 小快照；任务切换把旧任务归档目录与新元数据原子提交。调用索引按 refId 查重后增量追加。扩展缺失时继续完整 CAS，所有路径共享版本。存储 API 由装配层使用，模型能力经 StandardModules 和 ScriptAct 进入。
## 依赖什么
根入口只有可移植代码；依赖 Core 的统一行差量和 Kernel 的中立操作合同。Node 适配器仅在创建时加载 node:sqlite，要求 Node 22.13 或更新版本；ContextStorage / StoreStorage 合同不暴露 SQL、连接类型或表名。
## 状态归谁
ContextStorage 保存唯一事实，ContextRuntime 是绑定会话的无缓存视图。模型无法改写历史记录类型。
## 生命周期
独立使用时宿主创建与关闭存储；成功注入 createRuntime 后由 Runtime 关闭该连接或池租约，每个会话创建一个视图。close 幂等并取消所属 store 等待，不删除数据。SQLite 使用 WAL 与 FULL 同步，提交跨连接原子执行。
## 失败语义
CONTEXT_CONFLICT 要求重新 inspect；SCOPE_MISMATCH 拒绝跨会话引用；OBJECT_MISSING 明确报告原文缺失；CONTEXT_BUDGET 请求整理材料。
## 不变量
共 12 条，未验证 0 条，见 spec/invariants.md。存储替换边界及适配器验收见 `docs/architecture/storage.md`。
## 非目标
供应商 token 编码、模型循环与领域文件版本属于其各自负责人。
## 结构
```text
src/
  contract/ provides.ts requires.ts constants.ts
  types/ context.ts store.ts activity.ts runtime.ts
  impl/ 会话、证据、调用日志、活动账本和存储适配器；每个类的接口写在类上方
  utils/ state.ts journal.ts view.ts progress.ts store.ts tuning.ts
  index.ts contracts.ts node.ts
```

## 共享任务与进度

`ContextTaskFrame` 是主循环和有界规划器共用的目标、胶囊、回执及最近步骤。`ModelView.progress` 使用 `ContextProgress` / `ContextTextChange` 分别描述代码、输出、证据差量与图片变化，保留原文引用，连续重复达到 3 步给出 stalled 提示。同一目标重启继续累计步骤、用量和上一视图。附件只在视图中携带持久引用与哈希，真实字节在发送前恢复。

## 持久 store

空间目录按宿主 scope 和拥有者或授权 ID 过滤，对象按 store ID 寻址。StoreCreate/Descriptor/Directory 描述创建和目录。宿主可以归档空间并接管历史数据；模型读写权限由 Act 会话固定。事务同时提交对象、空间序号、变更和调用回执；只在提交后通过已有 TurnContextAppendHub 发即时通知，跨连接等待每 250ms 核对持久序号。最近 4096 条变更保留，超出明确报告 gap；正文与墓碑保留。订阅声明、消费位置和幂等回执持久化；确认采用订阅代次及实际投递序号。

持久消息复用 StoreStorage，使用 publish/subscribe/messages/delivered/acknowledgeEvents/waitEvents；消息逐条保存，投递游标和业务确认分离。详见 `docs/engineering/act-cooperation-delta.md`。
