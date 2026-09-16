
import { isArray, isRecord, isString } from '@velaros-ai/core'

import type { BuildToolPayloadRefsForProviderMessagesInput } from '../../types/context.js'
import { normalizeLegacyFoldStub } from '../../utils/context/context-ref-envelope'

import { ToolResultCanonicalizer } from './ToolResultCanonicalizer'

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

function existingPayloadRef(serializedResult: string): Nullable<string> {
  if (!serializedResult.includes('ctx-payload:')) return null
  try {
    const envelope = normalizeLegacyFoldStub(JSON.parse(serializedResult) as unknown)
    return envelope?.ref.startsWith('ctx-payload:') ? envelope.ref : null
  } catch {
    // arch-guard:silent-catch-ok 普通工具正文碰巧含 ctx-payload: 字样但不是引用包装，按原文归档。
    return null
  }
}

export async function buildToolPayloadRefsForProviderMessages(
  input: BuildToolPayloadRefsForProviderMessagesInput,
): Promise<Record<string, string>> {
  const sessionId = input.sessionId.trim()
  if (!sessionId) return {}

  const canonicalizer = new ToolResultCanonicalizer(input.store)
  const refs: Record<string, string> = {}
  const payloadRefsByToolCallId = new Map<string, Set<string>>()
  const registerRef = (occurrenceKey: string, toolCallId: string, payloadRef: string) => {
    refs[occurrenceKey] = payloadRef
    const payloadRefs = payloadRefsByToolCallId.get(toolCallId) ?? new Set<string>()
    payloadRefs.add(payloadRef)
    payloadRefsByToolCallId.set(toolCallId, payloadRefs)
  }
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

      const occurrenceKey = buildToolPayloadRefOccurrenceKey(messageIndex, partIndex)
      const existingRef = existingPayloadRef(result.serializedResult)
      if (existingRef) {
        // 之前的供应商投影已经指向原文：直接复用这个地址，不再给引用包装另存一份。
        registerRef(occurrenceKey, result.toolCallId, existingRef)
        return
      }
      toolResults.push({
        occurrenceKey,
        sessionId,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        serializedResult: result.serializedResult,
      })
    })
  })

  const canonicalResults = await canonicalizer.canonicalizeMany(toolResults)

  canonicalResults.forEach((canonical, index) => {
    const inputToolResult = toolResults[index]
    if (!inputToolResult) return

    registerRef(inputToolResult.occurrenceKey, inputToolResult.toolCallId, canonical.payloadRef)
  })

  for (const [toolCallId, payloadRefs] of payloadRefsByToolCallId) {
    if (payloadRefs.size === 1) {
      refs[toolCallId] = [...payloadRefs][0]!
    }
  }

  return refs
}
