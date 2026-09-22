# 外部能力接入

已有 TypeScript 领域实现通过 `createCapabilityModule` 接入同源 OperationSurface。外部服务可提供 OperationModuleDefinition，在 run 中调用宿主给定的客户端，并将效果与结果写入真实回执。

MCP 连接由 Velaros Act Runtime 的 McpClientConnection 管理；公开连接工厂、传输配置和模块转换 API 见 Runtime 的 provides/requires。MCP 发现结果进入相同的操作绑定和授权链，资源生命周期由宿主及 Runtime 共同管理。

可装载的 Kernel 模块使用 KernelModuleDefinition；数据源使用 ContextSourcePort；模型适配使用 ModelDriver；存储适配使用 ContextStorage。集成者从对应 requires 注入，复用同一 Agent Loop、ScriptAct、请求编译和持久化链。

产品 UI 与服务账户由其拥有者提供。接入后的实际模型操作通过 modules.list/describe 核查，验收应覆盖权限投影和失败回执。详见 [运行边界](seams.md)。
