# ScriptAct 正式接入点

当前主干契约见 `docs/architecture/platform-runtime.md`。模型维护稳定观察程序与一次性执行程序；Runtime 依据真实结果构造上下文。这里记录实际代码接入点，设计参考包用于保留原始资料。

| 职责 | 真实文件 | 接入方式 |
| --- | --- | --- |
| Runtime 装配 | `packages/velaros/src/impl/ComposedRuntime.ts` | 单一 Kernel、ContextStorage、模型、会话与可信外层调用身份 |
| 模型循环 | `packages/agent/src/impl/ActLoop.ts` | 准备观察、编译投影、接收完整响应、有序控制调用 |
| 程序维护 | `packages/velaros/src/impl/RuntimeSession.ts` | 解析底稿、精确编辑、检查、草稿修复、调度执行 |
| 版本与上下文 | `packages/velaros/src/impl/ProgramContext.ts` | CAS 发布、谱系、控制回执、结果租期和源码/输出差量 |
| 脚本执行 | `packages/script/src/impl/KernelScriptSession.ts` | 复用既有检查器、隔离执行器、KernelInvocationPort |
| 精确编辑 | `packages/script/src/utils/edit.ts` | 单一底稿、唯一匹配、重叠拒绝、整组应用 |
| 工具定义 | `packages/velaros/src/impl/StandardModules.ts` | 模型可见模块目录、能力 schema 与内部标准模块统一装配 |
| 权限与效果 | `packages/kernel/src/impl/runtime/OperationRuntime.ts` | 准备、授权、模式限制、派发、真实回执及核对 |
| 持久存储 | `packages/context/src/impl/LocalContextStorage.ts` | 复用 SQLite 对象存储和跨实例 CAS |
| 请求编译 | `packages/model/src/impl/requests/ProviderRequestCompiler.ts` | Runtime 视图或有序历史、图片、容量报告的同源编码、用量估计与发送门 |
| 高级搜索 | `packages/velaros/src/impl/AdvancedSearch.ts` / `SearchActivation.ts` | 复用同一 Agent Loop、ScriptAct、来源与任务总预算 |
| 搜索历史 | `packages/velaros/src/impl/SearchContext.ts` | 增量消息、作用域租约与有界检查点 |
| 用户输入 | `packages/context/src/impl/SessionContext.ts` | 原文归档、文件引用、分页读取与意图投影 |
| 证据读取 | `packages/context/src/impl/ContextEvidenceBuilder.ts` | 候选来源检查、真实读取、版本验证、预算和缺口 |
| 领域接入 | `createCapabilityModule` / `createShellCapabilityModule` | 复用领域实现、原权限与效果回执 |

增量与版本专项验证在 `packages/velaros/test/incremental-edit.test.mjs`；租期与观察约束在 `program-context.test.mjs`；真实项目、重启和进程恢复在 `dual-core.test.mjs`、`platform.test.mjs`；高级搜索与上下文管理专项在 `advanced-search.test.mjs` 和 `context-management.test.mjs`。
