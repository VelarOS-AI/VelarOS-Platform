// ToolPayloadReferencePlanner 用到的纯函数（不碰实例状态）。
import { isRecord, isString } from '@velaros-ai/core'

import { normalizeLegacyFoldStub } from '../../utils/context/context-ref-envelope'

/** 从一条 provider 消息片段里读出文本型工具结果；不是文本型工具结果时返回 null。 */
export function readTextToolResult(part: unknown): Nullable<{
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

/** 这段正文是否已经是指向原文的引用包装；是则返回那个地址。 */
export function existingPayloadRef(serializedResult: string): Nullable<string> {
  if (!serializedResult.includes('ctx-payload:')) return null
  try {
    const envelope = normalizeLegacyFoldStub(JSON.parse(serializedResult) as unknown)
    return envelope?.ref.startsWith('ctx-payload:') ? envelope.ref : null
  } catch {
    // arch-guard:silent-catch-ok 普通工具正文碰巧含 ctx-payload: 字样但不是引用包装，按原文归档。
    return null
  }
}
