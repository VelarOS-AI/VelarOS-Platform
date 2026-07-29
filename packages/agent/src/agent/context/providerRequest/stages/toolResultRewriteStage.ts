/**
 * Ring 1 stage ⑤——tool-result 改写 / 去重。
 *
 * 每个 tool 结果：首见的大载荷按内容寻址折成 payload-ref 句柄，同哈希重复的折成 dedupe 句柄；
 * 「当轮免裁窗口」——最后一个 assistant 之后的结果是本轮刚跑完、模型下一步就要读的，原样内联
 * （当轮可用、次轮回收）。stateful 工具结果永不折叠。回收阶梯（reclaim）见 compaction stage。
 */
import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isRecord, isString } from '@velaros-ai/core'

import { isFailureLikeToolResultValue } from '../../../history/microCompaction'
import { type ContextLedgerEntry, estimateBlockTokens } from '../../ContextLedger'
import { buildContextRefEnvelope } from '../../contextRefEnvelope'
import type { ProviderHistoryRewriteSignal } from '../../ProviderRequestCompiler'
import { isStatefulToolResultName } from '../../StatefulToolResults'
import { buildToolPayloadRefOccurrenceKey } from '../../ToolPayloadReferencePlanner'
import { sha256 } from '../contentHash'

interface ToolResultPayloadIdentity {
  toolCallId: string
  toolName: string
  output: Record<string, unknown>
  value: string
}

interface ToolResultPayloadSeenEntry {
  toolCallId: string
  toolName: string
  payloadRef?: string
}

export interface ToolResultRewriteOptions {
  payloadRefsByToolCallId?: Record<string, string>
  referenceBudgetChars: number
}

export interface ToolResultDedupeResult {
  messages: ModelMessage[]
  ledger: ContextLedgerEntry[]
}

/** 把去重 / 折叠账目投影成历史改写签名（供改写指纹聚合）。 */
export function buildToolResultRewriteSignals(
  entries: readonly ContextLedgerEntry[]
): ProviderHistoryRewriteSignal[] {
  const rewrittenEntries = entries
    .filter((entry) => entry.action === 'reference' || entry.action === 'dedupe-reference')
    .map((entry) => ({
      action: entry.action,
      reason: entry.reason,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      hash: entry.hash,
      ref: entry.ref,
    }))

  if (isEmpty(rewrittenEntries)) return []

  return [
    {
      kind: 'tool-result-payload',
      details: rewrittenEntries,
    },
  ]
}

function readToolResultPayload(part: unknown): Nullable<ToolResultPayloadIdentity> {
  if (!isRecord(part) || part.type !== 'tool-result') return null

  if (!isString(part.toolCallId) || !isString(part.toolName) || !isRecord(part.output)) return null

  const outputType = part.output.type
  const outputValue = part.output.value
  if ((outputType !== 'text' && outputType !== 'error-text') || !isString(outputValue)) return null

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: part.output,
    value: outputValue,
  }
}

function buildDuplicateToolResultReference(
  payload: ToolResultPayloadIdentity,
  hash: string,
  seen: ToolResultPayloadSeenEntry
): string {
  // B2:统一信封。ref 优先内容寻址;机器桩必须带显式 refKind(禁止依赖前缀推断)。
  const ref = seen.payloadRef || seen.toolCallId
  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'duplicate-tool-result',
      ref,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      payloadRef: seen.payloadRef,
      payloadHash: hash,
      originalLength: payload.value.length,
      reason: 'duplicate of earlier tool result',
      retrieval: {
        tool: 'recall_context',
        args: {
          ref,
          refKind: seen.payloadRef ? 'payload-ref' : 'tool-payload',
          reason: 'need the deduplicated tool result',
          maxChars: 8_000,
        },
      },
      meta: { sameAsToolCallId: seen.toolCallId, sameAsToolName: seen.toolName },
    })
  )
}

function buildToolPayloadReference(
  payload: ToolResultPayloadIdentity,
  hash: string,
  payloadRef: string
): string {
  // B2:与 sanitize 同名生产者完全同形(消掉"同一种桩两种 affordance")。
  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'tool-payload-ref',
      ref: payloadRef,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      payloadRef,
      payloadHash: hash,
      originalLength: payload.value.length,
      retrieval: {
        tool: 'recall_context',
        args: {
          ref: payloadRef,
          refKind: 'payload-ref',
          reason: 'need full historical tool result',
          maxChars: 8_000,
        },
      },
    })
  )
}

function createToolPayloadReferenceLedgerEntry(input: {
  messageIndex: number
  partIndex: number
  payload: ToolResultPayloadIdentity
  hash: string
  payloadRef: string
  chars: number
  action: 'reference' | 'dedupe-reference'
  reason: string
}): ContextLedgerEntry {
  return {
    id: `message:${input.messageIndex}:tool-result:${input.partIndex}`,
    zone: 'tool-payloads',
    chars: input.chars,
    estimatedTokens: estimateBlockTokens(input.chars),
    action: input.action,
    reason: input.reason,
    toolCallId: input.payload.toolCallId,
    toolName: input.payload.toolName,
    hash: input.hash,
    ref: input.payloadRef,
  }
}

function resolveToolPayloadRef(
  options: ToolResultRewriteOptions,
  payload: ToolResultPayloadIdentity,
  messageIndex: number,
  partIndex: number
): string | undefined {
  const occurrenceRef =
    options.payloadRefsByToolCallId?.[buildToolPayloadRefOccurrenceKey(messageIndex, partIndex)]
  if (occurrenceRef) return occurrenceRef

  return options.payloadRefsByToolCallId?.[payload.toolCallId]
}

export function dedupeToolResultMessages(
  messages: ModelMessage[],
  options: ToolResultRewriteOptions
): ToolResultDedupeResult {
  const seenByHash = new Map<string, ToolResultPayloadSeenEntry>()
  const ledger: ContextLedgerEntry[] = []
  // 当轮免裁窗口：最后一个 assistant 之后的 tool 结果是本轮刚执行完、模型下一步就要读的
  // 内容，换成零预览句柄会立刻逼出一次 recall_context 空转。当轮原样内联，下一轮它位于
  // 历史更早处自然回收成句柄——「当轮可用、次轮回收」。
  const lastAssistantIndex = messages.findLastIndex((message) => message.role === 'assistant')
  const nextMessages = messages.map((message, messageIndex) => {
    if (message.role !== 'tool' || !isArray(message.content)) return message

    let changed = false
    const content = message.content.map((part, partIndex) => {
      const payload = readToolResultPayload(part)
      if (!payload) return part
      if (isStatefulToolResultName(payload.toolName)) return part

      const hash = sha256(payload.value)
      const payloadRef = resolveToolPayloadRef(options, payload, messageIndex, partIndex)
      const isCurrentTurnResult = messageIndex > lastAssistantIndex
      const seen = seenByHash.get(hash)
      if (!seen) {
        seenByHash.set(hash, {
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          payloadRef,
        })

        // 失败门(与其余三层折叠一致):失败/阻断类结果永不折成零预览句柄——错误正文
        // 是模型下一步纠错的唯一依据,折掉会逼一次空转召回才拿到 error。
        if (
          isCurrentTurnResult ||
          !payloadRef ||
          isFailureLikeToolResultValue(payload.value) ||
          payload.value.length <= options.referenceBudgetChars
        )
          return part

        const referenceValue = buildToolPayloadReference(payload, hash, payloadRef)
        const chars = referenceValue.length
        changed = true
        ledger.push(
          createToolPayloadReferenceLedgerEntry({
            messageIndex,
            partIndex,
            payload,
            hash,
            payloadRef,
            chars,
            action: 'reference',
            reason: 'tool result payload stored by content-addressed ref',
          })
        )

        return {
          ...part,
          output: {
            ...payload.output,
            value: referenceValue,
          },
        }
      }

      // 当轮免裁窗口对去重同样成立:本轮刚跑完的重复结果换成去重句柄会立刻逼一次
      // recall 空转(与文件头自述契约一致)。当轮原样内联,下一轮它落到历史更早处再自然去重。
      if (isCurrentTurnResult) return part

      const duplicatePayloadRef = seen.payloadRef ?? payloadRef ?? `tool:${seen.toolCallId}`
      const referenceValue = buildDuplicateToolResultReference(payload, hash, {
        ...seen,
        payloadRef: duplicatePayloadRef,
      })
      const chars = referenceValue.length
      changed = true
      ledger.push(
        createToolPayloadReferenceLedgerEntry({
          messageIndex,
          partIndex,
          payload,
          hash,
          payloadRef: duplicatePayloadRef,
          chars,
          action: 'dedupe-reference',
          reason: 'duplicate tool result payload hash',
        })
      )

      return {
        ...part,
        output: {
          ...payload.output,
          value: referenceValue,
        },
      }
    })

    if (!changed) return message

    return {
      ...message,
      content: content as ModelMessage['content'],
    } as ModelMessage
  })

  return {
    messages: nextMessages,
    ledger,
  }
}
