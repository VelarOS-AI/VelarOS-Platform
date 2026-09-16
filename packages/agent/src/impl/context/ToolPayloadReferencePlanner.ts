import { isArray, isRecord, isString } from '@velaros-ai/core'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { BuildToolPayloadRefsForProviderMessagesInput } from '../../types/context.js'
import { buildToolPayloadRefOccurrenceKey, normalizeLegacyFoldStub } from '../../utils/context/context-ref-envelope'

import { ToolResultCanonicalizer } from './ToolResultCanonicalizer'

/** 从一条 provider 消息片段里读出文本型工具结果；不是文本型工具结果时返回 null。 */
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

/** 这段正文是否已经是指向原文的引用包装；是则返回那个地址。 */
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

/**
 * 工具结果原文归档规划器：一次 provider 请求建一个（`buildToolPayloadRefsForProviderMessages` 的内部实现），
 * 收下这批消息里所有文本型工具结果，存进 payload 店，返回「出现位置 → 原文地址」的映射。
 * 自身只持有一个归一化器，无跨请求状态。
 */
export interface ToolPayloadReferencePlannerApi {
  /**
   * 扫一遍消息里的工具结果并归档，返回引用映射：键既有「消息下标:片段下标」的出现位置，
   * 也有 `toolCallId`（仅当那次调用在这批消息里只对应一个地址时才给，多个地址时留空免得指错）。
   * 已经是引用包装的正文直接复用原地址，不再另存一份；`isOutputInlineToolName` 认下的工具整条跳过。
   * `sessionId` 去空白后为空时不归档，返回空映射。
   */
  buildRefs(input: BuildToolPayloadRefsForProviderMessagesInput): Promise<Record<string, string>>
}

/**
 * 把一批 provider 消息里的工具结果原文归档，产出「出现位置 → 原文地址」的映射。
 *
 * 持有归一化器（而不是每次现 new 一个）：同一份 store 上的归档要走同一条去重路径，
 * 否则同一段正文会在账本里留下两份地址。
 */
class ToolPayloadReferencePlanner implements ToolPayloadReferencePlannerApi {
  private readonly canonicalizer: ToolResultCanonicalizer

  constructor(store: ContextPayloadStore) {
    this.canonicalizer = new ToolResultCanonicalizer(store)
  }

  /** 扫一遍消息，把还没归档的工具结果存进 store，返回引用映射。 */
  public async buildRefs(
    input: BuildToolPayloadRefsForProviderMessagesInput
  ): Promise<Record<string, string>> {
    const sessionId = input.sessionId.trim()
    if (!sessionId) return {}

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

    const canonicalResults = await this.canonicalizer.canonicalizeMany(toolResults)

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
}

/** 按一次 provider 请求归档工具结果原文，返回引用映射。 */
export async function buildToolPayloadRefsForProviderMessages(
  input: BuildToolPayloadRefsForProviderMessagesInput,
): Promise<Record<string, string>> {
  return new ToolPayloadReferencePlanner(input.store).buildRefs(input)
}
