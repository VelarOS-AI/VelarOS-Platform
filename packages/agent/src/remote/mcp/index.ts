// 门面:Platform Agent 远程节点的 MCP 适配层。
//
// 到 Host 仍然只有 remote-node 一条线;本子路径只负责把它翻译成任何 MCP 客户端都认识的形状,
// 好让 Codex / Claude Code 这类改不了的 agent 也能操作目标机器。
export * from './RemoteNodeMcpBridge'
export * from './stdio-entry'
