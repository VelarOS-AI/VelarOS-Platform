# Act 主干与扩展装配

Agent 包提供 ActLoop、ActRunService、AgentSupervisor。模型协议、脚本运行、上下文准备通过 `src/contract/requires.ts` 注入；数据在 types，类接口与实现同文件，公开面通过 contract/provides.ts 登记。

Velaros 的 act/runtime 统一装配 ModelDriver、Script runner、ContextStorage、领域操作、系统模块和模型工具。createRuntime 是正式宿主入口。system 管理 modules/memory/store，search 提供高级搜索，agents 提供子任务和用户交互。详见 [Act 目录](../../packages/velaros/act/README.md)。

Kernel 的模块 host 管理 KernelModuleDefinition 生命周期；Mod 信封由 velarosModEnvelopes 解析。Act 的 OperationModuleDefinition 是脚本操作定义，宿主通过 Runtime.modules 挂载。两种合同各有明确消费者，接入方式见 [模块开发说明](../mod-dev/README.md)。

运行顺序、版本与失败恢复以 [Platform runtime](../architecture/platform-runtime.md) 为准，源码布局以 [模块规范](../architecture/module-ownership.md) 为准。
