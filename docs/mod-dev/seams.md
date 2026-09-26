# 运行边界与生命周期

扩展从公开注入面进入。所有治理模块的注入声明在 contract/requires.ts，类 API 在类上方并通过 contract/provides.ts 登记。

| 时机 | 注入点与责任 |
| --- | --- |
| 创建 Runtime | VelarosRuntimeOptions：模型、runner、storage、模块、证据源及会话策略 |
| 激活/关闭能力 | OperationModuleDefinition.activate/dispose；Runtime 负责调用和资源收束 |
| 固定每帧参数 | Runtime inputs(sessionId)，由协议解析器冻结快照 |
| 准备与派发操作 | OperationDefinition.prepare/run，OperationContext 提供信号、真实效果和图片回执 |
| 调用前授权 | Runtime authorize(invocation, descriptor, signal) |
| 证据读取 | ContextSourcePort；写入冲突由领域在写入处按版本核对 |
| 观察时运行受限实现 | OperationDefinition.observe 或 CapabilityModuleOptions.observation |
| 核对未知效果 | OperationDefinition.reconcile，只读核对原调用 |
| 推进 Agent 循环 | ActProtocolPort、ActContextPort、ActExecutionPort，由正式 Runtime 装配 |

回调失败按其阶段处理：准备或授权失败不派发，派发后的失败依据持久回执判断真实效果。取消信号要求停止后续工作；已产生的外界效果通过回执核对。长驻资源必须随其所属模块和 Runtime 关闭。

主模型和搜索、整理等模型工具共享执行机制，能力和上下文策略由 Runtime 固定。详见 [运行架构](../architecture/platform-runtime.md)、[运行保障](../architecture/runtime-assurance.md)。
