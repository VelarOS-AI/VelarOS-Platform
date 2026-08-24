// 与宿主无关的 MCP 连接和协议翻译适配器。产品宿主负责服务器发现、配置、生命周期管理，
// 以及把翻译后的工具注册到自己的工具提供器。

export { translateMcpCallResult } from './mcpCallResult'
export type {
  McpAuthorizationProvider,
  McpConnectionSpec,
  McpRawCallResult,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolAnnotations,
  McpToolDescriptor,
  McpTransportKind,
} from './McpClientConnection'
export {
  McpAuthorizationRequiredError,
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
