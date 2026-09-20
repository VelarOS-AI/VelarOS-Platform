# Velaros 运行时装配

`createRuntime` 将 ContextStorage、Kernel、Script、Model 与 Agent 装成一份实例图。宿主提供存储、runner、模型和领域资源，通过 `openSession`、`script`、`submit`、`reconcile`、`close` 使用。

模型外层入口为 `script({observe?, execute?})`，至少提供一项。observe 支持完整程序、显式 sourceRef 或省略版本号的当前观察 edits；execute 支持完整程序或显式引用，并可设置 retainTurns。一次提交先检查所有候选，通过后原子发布源码、观察版本和执行占位，再运行一次性代码。每轮请求前重新运行当前观察程序，输出及有效租约经 ProviderRequestCompiler 送给模型。

ProgramContext 在既有 ContextStorage 中保存不可变源码、草稿、控制回执与观察指针，并以 CAS 发布；Session 提交回执记录执行占位和完成，Kernel journal 记录实际业务调用效果。脚本版本和执行身份分别记录。未知效果先通过 reconcile 核对。

标准模块定义集中于 `src/impl/StandardModules.ts`：modules 发现能力，artifacts 读取材料，execution 查询回执，programs 读取源码，results 读取或续租结果。script schema 与校验也在此单源定义，由 Session 直接接收。`createCapabilityModule` 将领域 surface 与操作实现装入同一 Kernel，复用声明、schema、效果分类和权限。

Context 保留证据解析、真实读取、版本验证和预算控制。BoundedContextPlanner 独立保留为有界检索实现，可供高级搜索能力装配；它有调用次数、候选和输出限制。正式主循环每轮投影由观察程序及结果租约决定。

公开装配契约在 `src/interface/requires.ts`，使用面在 `provides.ts`，内部协作在 `internal.ts`，数据在 `contract/runtime.ts`。启动时激活资源；关闭时停止活动任务、释放 Kernel 模块、关闭存储。

验收见 `spec/invariants.md`、`test/runtime.test.mjs`、`test/script-submission.test.mjs`、`test/incremental-edit.test.mjs`、`test/program-context.test.mjs`、`test/platform.test.mjs`、`test/dual-core.test.mjs`、`test/provider.test.ts`。详细主链见 [正式架构](../../docs/architecture/platform-runtime.md)。
