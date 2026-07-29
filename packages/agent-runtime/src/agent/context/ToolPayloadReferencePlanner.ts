import type { ModelMessage } from 'ai'

import { isArray,isRecord, isString } from '@velaros-ai/core'

import type { ContextPayloadStore } from './ContextPayloadStore'
import { ToolResultCanonicalizer } from './ToolResultCanonicalizer'

export interface BuildToolPayloadRefsForProviderMessagesInput {
  sessionId: string
  messages: ModelMessage[]
  store: ContextPayloadStore
  /**
   * 声明 outputInline 的工具（如 tool_map / tool_read）：其结果禁止被 page-out 成 payload
   * 引用。这里直接不为它们生成 ref，下游 dedupe/reclaim 因 `!payloadRef` 自然跳过，工具输出
   * 始终原样内联给模型，避免「模型看到 __contextRef 又得 recall_context 召回」的多余轮次。
   */
  isOutputInlineToolName?: (toolName: string) => boolean
}

const ToolPayloadRefOccurrenceKeyPrefix = '\u0000tool-result-occurrence:'

export function buildToolPayloadRefOccurrenceKey(messageIndex: number, partIndex: number): string {
  return `${ToolPayloadRefOccurrenceKeyPrefix}${messageIndex}:${partIndex}`
}

function readTextToolResult(part: unknown): Nullable<{
  toolCallId: string
  toolName: string
  serializedResult: string
}> {
  if (!isRecord(part) || part.type !== 'tool-result') return null

  if (!isString(part.toolCallId) || !isString(part.toolName) || !isRecord(part.output)) return null

  const outputType = part.output.type
  const outputValue = part.output.value
  if ((outputType !== 'text' && outputType !== 'error-text') || !isString(outputValue)) return null

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    serializedResult: outputValue,
  }
}

export async function buildToolPayloadRefsForProviderMessages(
  input: BuildToolPayloadRefsForProviderMessagesInput
): Promise<Record<string, string>> {
  const sessionId = input.sessionId.trim()
  if (!sessionId) return {}

  const canonicalizer = new ToolResultCanonicalizer(input.store)
  const refs: Record<string, string> = {}
  const toolResults: Array<{
    occurrenceKey: string
    sessionId: string
    toolCallId: string
    toolName: string
    serializedResult: string
  }> = []

  input.messages.forEach((message, messageIndex) => {
    if (message.role !== 'tool' || !isArray(message.content)) return

    message.content.forEach((part, partIndex) => {
      const result = readTextToolResult(part)
      if (!result) return
      if (input.isOutputInlineToolName?.(result.toolName)) return

      toolResults.push({
        occurrenceKey: buildToolPayloadRefOccurrenceKey(messageIndex, partIndex),
        sessionId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        serializedResult: result.serializedResult,
      })
    })
  })

  const canonicalResults = await canonicalizer.canonicalizeMany(toolResults)
  const payloadRefsByToolCallId = new Map<string, Set<string>>()

  canonicalResults.forEach((canonical, index) => {
    const inputToolResult = toolResults[index]
    if (!inputToolResult) return

    refs[inputToolResult.occurrenceKey] = canonical.payloadRef
    const payloadRefs = payloadRefsByToolCallId.get(inputToolResult.toolCallId) ?? new Set<string>()
    payloadRefs.add(canonical.payloadRef)
    payloadRefsByToolCallId.set(inputToolResult.toolCallId, payloadRefs)
  })

  for (const [toolCallId, payloadRefs] of payloadRefsByToolCallId) {
    if (payloadRefs.size === 1) {
      refs[toolCallId] = [...payloadRefs][0]!
    }
  }

  return refs
}
