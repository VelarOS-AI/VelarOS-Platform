// 与宿主无关的 MCP 连接和协议翻译适配器。产品宿主负责服务器发现、配置、生命周期管理，
// 以及把翻译后的工具注册到自己的工具提供器。

export type {
  McpAuthorizationProvider,
  McpConnectionSpec,
  McpRawCallResult,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolAnnotations,
  McpToolDescriptor,
  McpTransportKind,
} from '../impl/connectors/McpClientConnection'
export {
  McpAuthorizationRequiredError,
  McpCallTimeoutMs,
  McpClientConnection,
  McpConnectTimeoutMs,
} from '../impl/connectors/McpClientConnection'
export { translateMcpCallResult } from '../utils/connectors/mcp-call-result'
export type {
  McpAutoApprovePolicy,
  TranslatedMcpTool,
  TranslateMcpToolInput,
} from '../utils/connectors/mcp-tool-translation'
export {
  buildMcpToolName,
  convertMcpInputSchema,
  translateMcpTool,
} from '../utils/connectors/mcp-tool-translation'
