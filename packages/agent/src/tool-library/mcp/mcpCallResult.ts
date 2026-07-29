// MCP callTool 结果 → 工具执行返回值的翻译（边界解析：SDK 原始 result 只在此处解析一次）。
//
// MCP 结果形状：`{ content: [{type:'text',text} | {type:'image',...} | ...], structuredContent?, isError? }`
// 或 `{ toolResult }`。翻译规则：拼接 text 片段；结构化内容优先返回对象；isError → 抛 AppError
// （让标准 ToolExecutor 失败路径把它记成工具错误结果，回到模型）。

import { isArray, isBoolean, isPresent, isRecord } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { McpRawCallResult } from './McpClientConnection'

/** MCP result 的 isError 标志（unknown 边界字段）；仅 boolean true 视为失败。 */
function isErrorResult(raw: McpRawCallResult): boolean {
  return isBoolean(raw.isError) && raw.isError
}

/** 从 MCP content 数组拼接可读文本（text 片段），并对非文本片段给出占位摘要。 */
function joinContentText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (!record) continue
    const text = readString(record, 'text')
    if (text) {
      parts.push(text)
      continue
    }
    const type = readString(record, 'type')
    if (type === 'image' || type === 'audio') {
      parts.push(`[MCP ${type} content]`)
    } else if (type === 'resource' || type === 'resource_link') {
      const uri = readString(asRecord(record.resource) ?? record, 'uri')
      parts.push(uri ? `[MCP resource: ${uri}]` : '[MCP resource]')
    }
  }
  return parts.join('\n').trim()
}

/**
 * 把 MCP 原始返回翻译成工具 execute() 的返回值。
 *
 * - `isError` → 抛 AppError（EXECUTION），标准执行路生成失败信封回模型。
 * - 有 `structuredContent` → 返回结构化对象（模型可直接消费）。
 * - 否则返回拼接后的文本；`{toolResult}` 形态直接返回其值。
 */
export function translateMcpCallResult(raw: McpRawCallResult, label: string): unknown {
  // 备用形态：`{ toolResult }`（无 content 数组）。
  if (!isArray(raw.content) && isPresent(raw.toolResult)) {
    if (isErrorResult(raw)) {
      throw new AppError('EXECUTION', `MCP 工具失败：${label}`)
    }
    return raw.toolResult
  }

  const content = isArray(raw.content) ? raw.content : []
  const text = joinContentText(content)
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : null

  if (isErrorResult(raw)) {
    throw new AppError('EXECUTION', text || `MCP 工具失败：${label}`)
  }

  if (structured) {
    // 同时带文本时把文本并入结构化输出，避免模型只看到裸对象丢失叙述。
    return text ? { ...structured, _text: text } : structured
  }

  return text || '（MCP 工具无输出内容）'
}
