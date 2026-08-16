# MCP、宿主自动化与 mod 的边界

MCP、宿主自动化 API 和 mod 都能扩展产品能力，但它们的方向、信任边界和所有者不同。产品宿主
可以同时实现三者，不能把它们合并成一条拥有隐式权限的捷径。

| 机制 | 用途 | Platform 所有权 | 产品宿主所有权 |
| --- | --- | --- | --- |
| MCP | 连接外部工具服务器 | 连接、协议翻译和结果归一化 | 配置、进程生命周期、审批和工具注册 |
| 宿主自动化 API | 让外部进程驱动整个应用 | 可复用的执行与能力协议 | 传输、认证、命令面和产品状态适配 |
| mod | 在受控装载生命周期内贡献能力 | manifest、Loader、registry、seam 与投影 | 信任策略、安装器、bindings 和产品 UI |

## MCP

`@velaros-ai/agent` 的 `tool-library/mcp` 提供 host-neutral 的 MCP 连接和翻译能力，包括：

- `McpClientConnection` 与超时策略；
- `translateMcpTool`、`buildMcpToolName` 和输入 schema 转换；
- `translateMcpCallResult`；
- stdio transport。

产品宿主负责 server discovery、配置、环境变量白名单、启动与停止、用户审批，以及将翻译后的
工具注册到自己的 `ToolProvider`。当前 Agent manifest 没有 `mcp` 轴，因此 mod 作者不得自行发明
该字段。未来若公开 MCP contribution，也应只声明服务器配置；实际 transport 和审批仍由宿主控制。

MCP 的自动批准策略不是 mod 权限。前者决定某次工具调用是否需要用户确认，后者声明 pack 可能
请求的能力范围，两者都不能代替 capability broker 的运行时检查。

## 宿主自动化 API

宿主自动化 API 的方向是“外部进程驱动应用”，例如提交任务、观察事件、响应确认或切换界面。
它属于具体产品的公开接口，不是 Platform mod manifest 的贡献轴。

边界规则：

- 外部进程驱动产品：使用宿主公开且经过认证的自动化 API；
- mod 改变 Agent 运行行为：使用 [seam](./seams.md)；
- mod 执行真实副作用：通过 [capability](./capabilities.md) 和权限 broker；
- mod 不得调用宿主私有自动化端点绕过权限与生命周期。

宿主若提供 loopback HTTP、SSE、IPC 或其他传输，必须公开认证、协议版本、监听范围、敏感命令
审批和弃用政策。Platform 不把某个产品的私有命令面写进通用协议。

## 安装器与市场

mod 的分发不能复用一个只支持固定 id、latest-only 或“先删除旧目录再覆盖”的旧式资源安装器。
面向公开生态的安装器至少需要：

- 开放而稳定的包标识符；
- 精确版本、摘要和签名寻址；
- 原子安装、失败恢复、回滚和吊销；
- 安装记录、权限变化提示和可审计来源；
- 启停与数据删除分离。

用户界面仍可按技能、连接器、资源或功能领域组织，不必向普通用户暴露内部的 mod 术语。机制
应统一，产品信息架构可以按用户任务拆分。完整分发要求见 [distribution.md](./distribution.md)。
