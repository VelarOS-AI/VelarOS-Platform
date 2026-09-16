import { isArray } from '@velaros-ai/core'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { BuildToolPayloadRefsForProviderMessagesInput } from '../../types/context.js'
import { buildToolPayloadRefOccurrenceKey } from '../../utils/context/context-ref-envelope'
import { existingPayloadRef, readTextToolResult } from '../../utils/context/tool-payload-reference-planner'

import { ToolResultCanonicalizer } from './ToolResultCanonicalizer'

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

export { ToolPayloadReferencePlanner }
