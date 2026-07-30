/**
 * 账本投影（上下文治理 v2 的唯一 prompt 组装口）。
 *
 * `project(账本, 驻留态向量, 预算) → ModelMessage[]`：**纯函数、确定性、同输入必同输出**。
 * 函数体内禁 `Date.now` / 随机 / locale 相关比较——时间由记录元数据携带，顺序由 `seq` 钉死。
 *
 * 三段布局（P1：段与段之间只追加，轮与轮之间前缀逐字不变 ⇒ 缓存全命中）：
 *   [稳定前缀：system + 工具清单 + 治理规则]  ← 调用方传入，投影不生产它
 *   [账本投影：账本序，按驻留态渲染]
 *   [活动尾：尾保护窗口内的记录全文 + 外部注入块（dashboard / turn-context）]
 *
 * **结构配对是硬约束**（本文件相对设计稿的唯一实质补充）：tool-call 与 tool-result 必须成对进
 * provider，否则 `assertValidModelHistory` 直接拒绝、会话锁死。所以"SUMMARIZED 隐藏 member"
 * 对工具类记录降级为**结构墓碑**——消息壳与 toolCallId 保留，正文换成墓碑信封。只有非工具类
 * 记录（user / assistant 叙事 / env-delta）才真正从投影里消失。
 */
import type { ModelMessage } from 'ai'

import { isArray, isFiniteNumber, isRecord } from '@velaros-ai/core'

import { buildContextRefEnvelope } from '../contextRefEnvelope'

import { buildExcerptEnvelope } from './admission'
import {
  type ContextRecord,
  type ContextResidency,
  type ContextResidencyVector,
  estimateResidencyTokens,
  residentChars,
} from './ContextRecord'
import { stableFingerprint } from './determinism'

export interface ContextProjectionBudget {
  /** 尾保护轮数：最近若干轮的记录恒以全文投影（活动尾）。 */
  tailProtectTurns: number
  /** 治理窗口 G（token）。给出即产出占用率，缺省则占用率为 null。 */
  budgetTokens?: LooseOptional<number>
  /** token 估算口径，默认 4 字符 1 token。 */
  charsPerToken?: LooseOptional<number>
}

export interface ProjectContextLedgerInput {
  records: readonly ContextRecord[]
  residency: ContextResidencyVector
  budget: ContextProjectionBudget
  /** 稳定前缀：调用方产出并保证逐轮字节不变。 */
  stablePrefix?: readonly ModelMessage[]
  /** 活动尾的外部注入块挂载点（context-dashboard / turn-context delta）。 */
  tailBlocks?: readonly ModelMessage[]
}

export interface ContextProjectionStats {
  recordCount: number
  byResidency: Record<ContextResidency, number>
  /** 真正从投影里消失的记录数（被 summary 代表的非工具成员）。 */
  hiddenCount: number
  /** 渲染成墓碑的记录数。 */
  tombstoneCount: number
  excerptCount: number
  /** 落在尾保护窗口、被强制全文渲染的记录 id（账本序）。 */
  tailProtectedRecordIds: string[]
  projectedChars: number
  projectedTokens: number
  budgetTokens: Nullable<number>
  occupancyPercent: Nullable<number>
  /** 账本段的内容指纹：前缀是否漂移一眼可判（缓存回归的探针）。 */
  ledgerFingerprint: string
}

export interface ContextProjectionResult {
  messages: ModelMessage[]
  stats: ContextProjectionStats
}

/** 账本投影：唯一的 prompt 组装口。 */
export function projectContextLedger(
  input: ProjectContextLedgerInput
): ContextProjectionResult {
  const ordered = [...input.records].sort((left, right) => left.seq - right.seq)
  const tailFloorTurn = resolveTailFloorTurn(ordered, input.budget.tailProtectTurns)
  const charsPerToken = input.budget.charsPerToken ?? 4

  const byResidency: Record<ContextResidency, number> = {
    INLINE: 0,
    EXCERPT: 0,
    SUMMARIZED: 0,
    EVICTED: 0,
    EXPIRED: 0,
  }
  const tailProtectedRecordIds: string[] = []
  const ledgerMessages: ModelMessage[] = []
  const tailMessages: ModelMessage[] = []
  let projectedChars = 0
  let hiddenCount = 0
  let tombstoneCount = 0
  let excerptCount = 0

  for (const record of ordered) {
    const declared = input.residency.get(record.id) ?? record.admittedResidency
    byResidency[declared] += 1
    const isTailProtected = record.turn >= tailFloorTurn
    if (isTailProtected) tailProtectedRecordIds.push(record.id)

    const effective: ContextResidency = isTailProtected ? 'INLINE' : declared
    const rendered = renderRecord(record, effective)
    if (rendered.kind === 'excerpt') excerptCount += 1
    if (rendered.kind === 'tombstone') tombstoneCount += 1
    if (rendered.kind === 'hidden') {
      hiddenCount += 1
      continue
    }

    projectedChars += residentChars(record, effective)
    if (isTailProtected) {
      tailMessages.push(rendered.message)
      continue
    }
    ledgerMessages.push(rendered.message)
  }

  const projectedTokens = estimateResidencyTokens(projectedChars, charsPerToken)
  const budgetTokens = normalizeBudgetTokens(input.budget.budgetTokens)

  return {
    messages: [
      ...(input.stablePrefix ?? []),
      ...ledgerMessages,
      ...tailMessages,
      ...(input.tailBlocks ?? []),
    ],
    stats: {
      recordCount: ordered.length,
      byResidency,
      hiddenCount,
      tombstoneCount,
      excerptCount,
      tailProtectedRecordIds,
      projectedChars,
      projectedTokens,
      budgetTokens,
      occupancyPercent: resolveOccupancyPercent(projectedTokens, budgetTokens),
      ledgerFingerprint: stableFingerprint(ledgerMessages),
    },
  }
}

/** 尾保护窗口的起始轮：最新轮往回数 `tailProtectTurns` 轮。 */
export function resolveTailFloorTurn(
  records: readonly ContextRecord[],
  tailProtectTurns: number
): number {
  const protectTurns = Math.max(0, Math.floor(tailProtectTurns))
  if (protectTurns === 0) return Number.POSITIVE_INFINITY

  const latestTurn = records.reduce((latest, record) => Math.max(latest, record.turn), 0)
  return latestTurn - (protectTurns - 1)
}

type RenderedRecord =
  | { kind: 'inline' | 'excerpt' | 'tombstone'; message: ModelMessage }
  | { kind: 'hidden'; message: null }

function renderRecord(record: ContextRecord, residency: ContextResidency): RenderedRecord {
  const message = record.message
  if (!message) return { kind: 'hidden', message: null }

  if (residency === 'INLINE') return { kind: 'inline', message }

  if (residency === 'EXCERPT') {
    const excerptMessage = renderExcerptMessage(record, message)
    if (excerptMessage) return { kind: 'excerpt', message: excerptMessage }
    return { kind: 'inline', message }
  }

  // SUMMARIZED / EVICTED / EXPIRED：工具类记录必须留结构壳（配对不可破），其余真正消失。
  if (record.kind === 'tool-result') return {
      kind: 'tombstone',
      message: rewriteToolResultOutputs(message, () => buildTombstoneText(record, residency)),
    }

  if (record.kind === 'tool-call') return {
      kind: 'tombstone',
      message: stripAssistantTextParts(message),
    }

  if (residency === 'SUMMARIZED') return { kind: 'hidden', message: null }

  return { kind: 'tombstone', message: buildTombstoneMessage(record, residency) }
}

function renderExcerptMessage(record: ContextRecord, message: ModelMessage): Nullable<ModelMessage> {
  const envelope = buildExcerptEnvelope(record)
  if (!envelope) return null

  const serialized = JSON.stringify(envelope)
  if (record.kind === 'tool-result') return rewriteToolResultOutputs(message, () => serialized)

  return { role: 'assistant', content: serialized }
}

/**
 * 墓碑文本：一行 id + 原因 + 召回指针。
 *
 * EXPIRED 刻意**不发信封**——原文已冷归档 GC，给一个能召回的指针只会换来一次空转召回。
 * 诚实的做法是给纯文本墓碑，模型一眼看出"这段回不来了"。
 */
function buildTombstoneText(record: ContextRecord, residency: ContextResidency): string {
  const reason = `context record ${record.id} is ${residency.toLowerCase()}`
  if (residency === 'EXPIRED')
    return `[context-record ${record.id} expired: cold-archived, original no longer retrievable]`

  const ref = resolveTombstoneRef(record)
  return JSON.stringify(
    buildContextRefEnvelope({
      __contextRef: 'history-budget-truncated',
      ref,
      reason,
      originalLength: record.bytes.full,
      retrieval: {
        tool: 'recall_context',
        args: { ref, refKind: resolveTombstoneRefKind(record), reason },
      },
      meta: { recordId: record.id, anchors: [...record.anchors] },
    })
  )
}

function resolveTombstoneRef(record: ContextRecord): string {
  return record.excerpt?.ref ?? record.payloadRef ?? record.toolCallId ?? record.id
}

function resolveTombstoneRefKind(record: ContextRecord): 'payload-ref' | 'tool-payload' | 'context-handle' {
  if (record.payloadRef) return 'payload-ref'
  if (record.toolCallId) return 'tool-payload'
  return 'context-handle'
}

function buildTombstoneMessage(record: ContextRecord, residency: ContextResidency): ModelMessage {
  return { role: 'assistant', content: buildTombstoneText(record, residency) }
}

/** 改写 tool 消息里每个 tool-result 片段的正文，消息壳与 toolCallId 逐字保留。 */
function rewriteToolResultOutputs(
  message: ModelMessage,
  nextValue: () => string
): ModelMessage {
  if (message.role !== 'tool' || !isArray(message.content)) return message

  const content = (message.content as unknown[]).map((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') return part
    const output = isRecord(part.output) ? part.output : { type: 'text' }
    return { ...part, output: { ...output, type: 'text', value: nextValue() } }
  })

  return { ...message, content } as ModelMessage
}

/** tool-call 消息降级：文本片段清掉，tool-call 片段逐字保留（配对不可破）。 */
function stripAssistantTextParts(message: ModelMessage): ModelMessage {
  if (message.role !== 'assistant' || !isArray(message.content)) return message

  const content = (message.content as unknown[]).filter(
    (part) => !isRecord(part) || part.type !== 'text'
  )
  if (content.length === 0) return message

  return { ...message, content } as ModelMessage
}

function normalizeBudgetTokens(value: LooseOptional<number>): Nullable<number> {
  if (!isFiniteNumber(value) || value <= 0) return null
  return Math.floor(value)
}

function resolveOccupancyPercent(
  projectedTokens: number,
  budgetTokens: Nullable<number>
): Nullable<number> {
  if (!budgetTokens) return null
  return Math.round((projectedTokens / budgetTokens) * 1000) / 10
}
