# Velaros 能力包

模型业务能力按 files、shell、project、browser 等单元组织，系统能力按 [act/](act/README.md) 中的模块组织。四个职责组分别管理契约、实现和模板。

[Act 系统操作清单](act/README.md) 列出真实模块、操作、可用条件与允许模式。[共享运行时卡片](act/runtime/MODULE.md) 描述会话装配、协议解析、持久状态及生命周期。

包根入口 `@velaros-ai/velaros` 提供 `createRuntime`、领域模块装配与 MCP 连接；`/contracts` 提供公开数据；`/renderer` 提供浏览器安全事件投影。系统装配、搜索和子任务的宿主入口分别位于 `/act/system`、`/act/search`、`/act/agents`；模型自管理使用 `velaros:system`，业务能力使用自己的导入名。
