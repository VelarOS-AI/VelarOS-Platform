/**
 * 摄入适配器：既有会话历史（ModelMessage 流）→ 驻留账本记录。
 *
 * 这是 B1 切换时的接口：v1 历史必须**无损**进账本——每条消息恰好一条记录，消息对象逐字保留在
 * `record.message` 上，配对的 tool-call / tool-result 结构原样成立。没有这条路，切换只能靠"新会话
 * 才享受 v2"，那等于两条实现并存（用户已裁决：单一实现不留双链）。
 *
 * 轮序切分沿用 v1 的 conversation 口径：真实用户消息是轮边界，内部续跑（`sys_note` 信封 /
 * `velarosInternal.kind === 'follow-up'`）不单独计一轮——否则一次用户会话里的内部续跑会把尾保护
 * 窗口挤空。
 */
import type { ModelMessage } from 'ai'

import { toNullable } from '@velaros-ai/core'

import { isInternalFollowUpMessage } from '../../history/internalMessages'

import type { ContextAdmissionInput } from './admission'
import type { ContextRecordKind } from './ContextRecord'
import { hasToolCallParts, readToolCallFacts, readToolResultFacts } from './messageFacts'
import type { ContextLedgerAppendResult, ContextResidencyLedger } from './ResidencyLedger'

export interface IngestHistoryOptions {
  /**
   * 记录时刻。历史消息没有时间戳，投影又禁取时钟，所以由调用方给一个**确定的**基准：
   * 缺省 0 = 归档重放（同一份历史两次摄入产出逐字相同的账本）。
   */
  baseCreatedAt?: LooseOptional<number>
  /** 每条消息的时间步进（毫秒），用于让 fault 年龄有单调序。 */
  createdAtStepMs?: LooseOptional<number>
  /** 起始轮序。 */
  startTurn?: LooseOptional<number>
  /** 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。 */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
}

export interface HistoryIngestPlan {
  inputs: ContextAdmissionInput[]
  /** 摄入后的下一个轮序（增量摄入用）。 */
  nextTurn: number
}

/**
 * 历史 → 准入输入清单（纯函数）。
 * tool-result 的"目标"来自配对的 tool-call 参数，所以这里顺带把 args 挂回去。
 */
export function planHistoryIngest(
  messages: readonly ModelMessage[],
  options: IngestHistoryOptions = {}
): HistoryIngestPlan {
  const baseCreatedAt = options.baseCreatedAt ?? 0
  const step = options.createdAtStepMs ?? 1
  const payloadRefs = options.payloadRefsByToolCallId
  const argsByToolCallId = new Map<string, unknown>()
  const inputs: ContextAdmissionInput[] = []
  let turn = Math.max(0, Math.floor(options.startTurn ?? 0))
  let sawTurnBoundary = false

  messages.forEach((message, index) => {
    if (isTurnBoundary(message)) {
      if (sawTurnBoundary) turn += 1
      sawTurnBoundary = true
    }

    for (const call of readToolCallFacts(message)) {
      argsByToolCallId.set(call.toolCallId, call.args)
    }

    const firstResult = readToolResultFacts(message)[0]
    const toolCallId = firstResult ? firstResult.toolCallId : null

    inputs.push({
      kind: resolveRecordKind(message),
      message,
      createdAt: baseCreatedAt + index * step,
      turn,
      toolArgs: toolCallId ? argsByToolCallId.get(toolCallId) : null,
      payloadRef: toolCallId ? toNullable(payloadRefs?.[toolCallId]) : null,
    })
  })

  return { inputs, nextTurn: sawTurnBoundary ? turn + 1 : turn }
}

/** 把历史摄入一本账本（按序 append，每条都走准入钩子）。 */
export function ingestHistoryIntoLedger(
  ledger: ContextResidencyLedger,
  messages: readonly ModelMessage[],
  options: IngestHistoryOptions = {}
): ContextLedgerAppendResult[] {
  return planHistoryIngest(messages, options).inputs.map((input) => ledger.append(input))
}

/**
 * 消息 → 记录类别。
 * 一条消息一条记录（不按 part 拆），所以带工具调用片段的 assistant 消息整体记 `tool-call`：
 * 它在结构上就是一条工具调用消息，拆成两条记录只会让配对约束更难维持。
 */
export function resolveRecordKind(message: ModelMessage): ContextRecordKind {
  if (message.role === 'tool') return 'tool-result'
  if (message.role === 'system') return 'governance'
  if (message.role === 'user') return 'user'
  return hasToolCallParts(message) ? 'tool-call' : 'assistant'
}

function isTurnBoundary(message: ModelMessage): boolean {
  return message.role === 'user' && !isInternalFollowUpMessage(message)
}
