// MCP 接入通道适配器（宪章 §2「四通道一执行路」第③通道）。
// 家=tool-library/mcp/：host 无关的连接 + 翻译；desktop 侧装配（provider/manager/config）在
// apps/desktop tools/mcp。对外经 @velaros-ai/agent-runtime 桶暴露。

export { translateMcpCallResult } from './mcpCallResult'
export type {
  McpConnectionSpec,
  McpRawCallResult,
  McpToolAnnotations,
  McpToolDescriptor,
} from './McpClientConnection'
export {
  McpCallTimeoutMs,
  McpClientConnection,
  McpConnectTimeoutMs,
} from './McpClientConnection'
export type {
  McpAutoApprovePolicy,
  TranslatedMcpTool,
  TranslateMcpToolInput,
} from './mcpToolTranslation'
export {
  buildMcpToolName,
  convertMcpInputSchema,
  translateMcpTool,
} from './mcpToolTranslation'
