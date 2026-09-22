# 按职责选择接入点

每项扩展落到实际模块定义或 requires 注入端口。

| 职责 | 当前接入方式 |
| --- | --- |
| [模型操作](tools.md) | 操作使用 Kernel 的 OperationModuleDefinition，每个方法集中声明 summary、input、output、effects 和 run |
| [能力发现与分组](tool-categories.md) | 模型目录由实际绑定和会话授权生成 |
| [资源与工作区](spaces.md) | 宿主通过 workspace、领域端口和模块 instanceId/generation 绑定实际资源 |
| [模型说明与请求材料](prompt-segments.md) | 主请求的固定说明、程序、材料和图片由 Runtime 与 ProviderRequestCompiler 组装 |
| [上下文来源与活动差量](turn-context-sources.md) | 持久证据源实现 ContextSourcePort 的 authorize/search/read/validate |
| [脚本执行与任务配置](execution-modes.md) | observe 是每轮运行的观察代码，execute 是显式的一次执行，结果可设置驻留租约 |
| [子任务与模型工具](sub-agent-types.md) | AgentSupervisor 负责持久子任务状态与收束，Velaros agents 模块提供 profiles/start/resume/reply/status/wait/cancel/send |
| [任务方法与模板](skills.md) | 可复用业务方法可以通过模块模板、共享脚本材料和任务输入提供 |
| [生命周期注入](hooks.md) | 操作 prepare/run/observe/reconcile 和模块 activate/dispose 由各自生命周期调用 |
| [产品壳扩展](ui-shell.md) | 产品拥有路由、视图、工作区布局和原生窗口生命周期；VelarOS UI 提供共享展示组件 |
| [产品设置扩展](ui-settings.md) | 产品拥有设置字段、持久化、编辑界面和配置更新方式 |
