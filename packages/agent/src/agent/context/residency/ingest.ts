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
  /**
   * 上一批摄入是否已经见过轮边界（增量摄入的续跑状态）。
   *
   * 轮序自增发生在**第二个及以后**的边界上，这个"见过没有"是跨批状态。不带着它走，一批以 user
   * 消息结尾时下一批就得从 turn+1 起（预支），于是同一份历史逐条增量摄入与一次性整批摄入给出
   * 两套轮序：`[0,1,1,2]` vs `[0,0,1,1]`，尾保护窗口跟着错位，离线重放与在线运行的账本不可比
   * （审计 V8 / U22）。
   */
  turnBoundarySeen?: LooseOptional<boolean>
  /** 全保真层引用：toolCallId → payloadRef（PayloadStore 已存的原文）。 */
  payloadRefsByToolCallId?: LooseOptional<Readonly<Record<string, string>>>
}

export interface HistoryIngestPlan {
  inputs: ContextAdmissionInput[]
  /** 摄入后的下一个轮序（增量摄入用）：**当前轮**，不预支。 */
  nextTurn: number
  /** 本批结束时是否已见过轮边界（下一批的 `turnBoundarySeen` 入参）。 */
  turnBoundarySeen: boolean
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
  let sawTurnBoundary = !!options.turnBoundarySeen

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
      // 并行结果各取各的 ref：整张表交给准入，第 2..N 份才不会指向第一份的 payload。
      payloadRefsByToolCallId: payloadRefs,
    })
  })

  return { inputs, nextTurn: turn, turnBoundarySeen: sawTurnBoundary }
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
