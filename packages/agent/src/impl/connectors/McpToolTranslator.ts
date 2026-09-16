// MCP 工具与调用结果的翻译：把 MCP 侧的形状折成 Agent 工具面认识的形状。
import { type z } from 'zod'

import type { McpRawCallResult, TranslatedMcpTool,TranslateMcpToolInput } from '../../types/connectors'
import { translateMcpCallResult } from '../../utils/connectors/mcp-call-result'
import { buildMcpToolName, convertMcpInputSchema, translateMcpTool } from '../../utils/connectors/mcp-tool-translation'

/**
 * MCP 翻译面：把一台 MCP 服务器报上来的工具与调用结果，折成 Agent 工具面的形状。
 *
 * 只做形状转换，不发起任何连接。无状态，进程内共用一份。
 */
export interface McpToolTranslatorApi {
  /** 把一条 MCP 工具描述折成 Agent 工具描述。 */
  translateTool(input: TranslateMcpToolInput): TranslatedMcpTool
  /** 把 MCP 的入参 schema 转成 Agent 侧的 JSON Schema。 */
  convertInputSchema(inputSchema: Record<string, unknown>): z.ZodType<Record<string, unknown>>
  /** 按服务器别名与原工具名拼出带命名空间的工具名。 */
  buildToolName(serverName: string, toolName: string): string
  /** 把一次 MCP 调用结果折成 Agent 工具结果。 */
  translateCallResult(raw: McpRawCallResult, label: string): unknown
}

/** 方法逐个转调 utils/connectors 里的纯函数；这里只负责把它们收成一件对外能力。 */
class McpToolTranslator implements McpToolTranslatorApi {
  public translateTool(input: TranslateMcpToolInput): TranslatedMcpTool {
    return translateMcpTool(input)
  }

  public convertInputSchema(inputSchema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
    return convertMcpInputSchema(inputSchema)
  }

  public buildToolName(serverName: string, toolName: string): string {
    return buildMcpToolName(serverName, toolName)
  }

  public translateCallResult(raw: McpRawCallResult, label: string): unknown {
    return translateMcpCallResult(raw, label)
  }
}

/** MCP 工具翻译面（无状态，进程内共用一份）。 */
export const mcpToolTranslator: McpToolTranslatorApi = new McpToolTranslator()
