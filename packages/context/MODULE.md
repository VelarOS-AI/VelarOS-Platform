# @velaros-ai/context

## 这是什么
原始记录、材料、任务检查点与双核证据视图的统一权威。通过原子提交在下一次模型请求使用新工作集，原文保留为不可变对象。
## 提供什么
`createContextRuntime` 返回 `ContextRuntime`。`./node` 的 `localContextStorage` 返回 `ContextStorage`；`./contracts` 提供可移植数据。公共配置为 `ContextRuntimeOptions` 和 `LocalContextStorageOptions`。
`createContextView` 返回 `ContextViewApi`，通过 `ContextSourcePort` 读取真实证据，`ContextPlannerPort` 提供有界候选决策；`ContextCompletionPort` 负责领域验收。配置为 `ContextViewOptions`、`ContextBuildOptions`。

## 骨干链路
先写对象，再 CAS 写元数据与工作集。inspect/search/read/write/replace 为模型面；append/project 由宿主使用。
## 依赖什么
根入口只有可移植代码；依赖 Core 的统一行差量和 Kernel 的中立操作合同。Node 适配器使用 node:sqlite，要求 Node 22.13 或更新版本。
## 状态归谁
ContextStorage 保存唯一事实，ContextRuntime 是绑定会话的无缓存视图。模型无法改写历史记录类型。
## 生命周期
宿主创建与关闭存储；每个会话创建一个视图。SQLite 使用 WAL 与 FULL 同步，提交跨连接原子执行。
## 失败语义
CONTEXT_CONFLICT 要求重新 inspect；SCOPE_MISMATCH 拒绝跨会话引用；OBJECT_MISSING 明确报告原文缺失；CONTEXT_BUDGET 请求整理材料。
## 不变量
共 6 条，未验证 0 条，见 spec/invariants.md。
## 非目标
供应商 token 编码、模型循环与领域文件版本属于其各自负责人。
## 结构
```text
src/
  interface/ provides.ts requires.ts internal.ts
  contract/ context.ts view-schema.ts
  impl/ SessionContext.ts LocalContextStorage.ts ContextInvocationJournal.ts ContextViewSession.ts ContextEvidenceBuilder.ts
  utils/ state.ts journal.ts view.ts progress.ts
```

## 共享任务与进度

`ContextTaskFrame` 是主循环和有界规划器共用的目标、胶囊、回执及最近步骤。`ModelView.progress` 使用 `ContextProgress` / `ContextTextChange` 分别描述代码、输出、证据差量与图片变化，保留原文引用，连续重复达到 3 步给出 stalled 提示。同一目标重启继续累计步骤、用量和上一视图。附件只在视图中携带持久引用与哈希，真实字节在发送前恢复。
