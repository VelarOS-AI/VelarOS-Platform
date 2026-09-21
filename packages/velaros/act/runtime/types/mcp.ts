

export type McpTransportKind = 'stdio' | 'http' | 'sse' | 'auto'

/** MCP 工具行为提示（annotations），用于推断 riskClass/角色/并发安全。 */
export interface McpToolAnnotations {
  title: Nullable<string>
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
}

/** 从 MCP server 列出的单个工具描述符（已在边界解析成受控形状）。 */
export interface McpToolDescriptor {
  name: string
  description: Nullable<string>
  /** JSON Schema（MCP inputSchema，type:'object'）；翻译层经 z.fromJSONSchema 转 zod。 */
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
}

export interface McpResourceDescriptor {
  uri: string
  name: string
  description: Nullable<string>
  mimeType: Nullable<string>
}

export interface McpResourceContent {
  uri: string
  mimeType: Nullable<string>
  text: Nullable<string>
  blob: Nullable<string>
}

/** MCP callTool 的原始返回（SDK result 对象）；结果翻译在 mcpCallResult.ts。 */
export type McpRawCallResult = Record<string, unknown>
