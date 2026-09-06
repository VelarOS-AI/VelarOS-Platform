// MCP callTool 结果 → 工具执行返回值的翻译（边界解析：SDK 原始 result 只在此处解析一次）。
//
// MCP 结果形状：`{ content: [{type:'text',text} | {type:'image',...} | ...], structuredContent?, isError? }`
// 或 `{ toolResult }`。翻译规则：普通结果与模型可见多媒体内容分离；结构化内容优先返回对象；
// isError → 抛 AppError（让标准 ToolExecutor 失败路径把它记成工具错误结果，回到模型）。

import type { ToolResultModelContentPart } from '@velaros-ai/agent/protocol'
import { isArray, isBoolean, isPresent, isRecord } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

import { withToolResultModelContent } from '../../tools/modelImageLift'

import type { McpRawCallResult } from './McpClientConnection'

/** MCP result 的 isError 标志（unknown 边界字段）；仅 boolean true 视为失败。 */
function isErrorResult(raw: McpRawCallResult): boolean {
  return isBoolean(raw.isError) && raw.isError
}

interface ParsedMcpContent {
  text: string
  modelContent: ToolResultModelContentPart[]
}

function describeResource(uri: Nullable<string>): string {
  return uri ? `[MCP resource: ${uri}]` : '[MCP resource]'
}

function mediaPart(
  type: 'image-data' | 'file-data',
  record: Record<string, unknown>,
  requiredMediaPrefix: 'image/' | 'audio/'
): Nullable<ToolResultModelContentPart> {
  const data = readString(record, 'data')
  const mediaType = readString(record, 'mimeType')
  if (!data || !mediaType || !mediaType.toLowerCase().startsWith(requiredMediaPrefix)) return null
  return { type, data, mediaType }
}

/**
 * Parse MCP content once into a compact display/result string and ordered provider content blocks.
 * Valid binary bytes only enter modelContent; they are never copied into the ordinary result.
 */
function parseContent(content: readonly unknown[]): ParsedMcpContent {
  const textParts: string[] = []
  const modelContent: ToolResultModelContentPart[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (!record) continue

    const type = readString(record, 'type')
    if (type === 'text') {
      const text = readString(record, 'text')
      if (!text) continue
      textParts.push(text)
      modelContent.push({ type: 'text', text })
      continue
    }

    if (type === 'image') {
      const part = mediaPart('image-data', record, 'image/')
      if (part) modelContent.push(part)
      else {
        const summary = '[MCP image content]'
        textParts.push(summary)
        modelContent.push({ type: 'text', text: summary })
      }
      continue
    }

    if (type === 'audio') {
      const part = mediaPart('file-data', record, 'audio/')
      if (part) modelContent.push(part)
      else {
        const summary = '[MCP audio content]'
        textParts.push(summary)
        modelContent.push({ type: 'text', text: summary })
      }
      continue
    }

    if (type === 'resource') {
      const resource = asRecord(record.resource) ?? record
      const uri = readString(resource, 'uri')
      const summary = describeResource(uri)
      const text = readString(resource, 'text')
      if (text) {
        const describedText = `${summary}\n${text}`
        textParts.push(describedText)
        modelContent.push({ type: 'text', text: describedText })
        continue
      }

      const blobRecord = { data: resource.blob, mimeType: resource.mimeType }
      const mediaType = readString(resource, 'mimeType')?.toLowerCase()
      const part = mediaType?.startsWith('image/')
        ? mediaPart('image-data', blobRecord, 'image/')
        : mediaType?.startsWith('audio/')
          ? mediaPart('file-data', blobRecord, 'audio/')
          : null
      textParts.push(summary)
      modelContent.push({ type: 'text', text: summary })
      if (part) modelContent.push(part)
      continue
    }

    if (type === 'resource_link') {
      const summary = describeResource(readString(record, 'uri'))
      textParts.push(summary)
      modelContent.push({ type: 'text', text: summary })
      continue
    }

    // Preserve the old tolerant boundary behavior for non-standard servers that still attach text
    // to a custom content type.
    const text = readString(record, 'text')
    if (text) {
      textParts.push(text)
      modelContent.push({ type: 'text', text })
    }
  }
  return { text: textParts.join('\n').trim(), modelContent }
}

/**
 * 把 MCP 原始返回翻译成工具 execute() 的返回值。
 *
 * - `isError` → 抛 AppError（EXECUTION），标准执行路生成失败信封回模型。
 * - 有 `structuredContent` → 返回结构化对象（模型可直接消费）。
 * - 图片/音频 → 通过 `modelContent` 信封交给 Executor，普通结果不含 base64。
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
  const parsed = parseContent(content)
  const structured = isRecord(raw.structuredContent) ? raw.structuredContent : null

  if (isErrorResult(raw)) {
    throw new AppError('EXECUTION', parsed.text || `MCP 工具失败：${label}`)
  }

  const binaryCount = parsed.modelContent.filter((part) => part.type !== 'text').length
  const result = structured
    // 同时带文本时把文本并入结构化输出，避免模型只看到裸对象丢失叙述。
    ? parsed.text ? { ...structured, _text: parsed.text } : structured
    : parsed.text || (binaryCount
        ? `（MCP 工具返回 ${binaryCount} 个媒体内容块）`
        : '（MCP 工具无输出内容）')

  if (binaryCount > 0) return withToolResultModelContent(result, parsed.modelContent)

  return result
}
