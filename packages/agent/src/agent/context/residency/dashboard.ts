/**
 * 上下文仪表盘为模型提供在环自我感知，对应设计 §5.1。
 *
 * 每轮活动尾追加一块固定格式的账目，包含治理周期编号、预算占用、五种驻留态计数、前三大持仓和
 * 待处理数量。模型据此判断上下文压力，并在阶段完成时调用 `context:distill` 请求一次治理周期。
 *
 * 仪表盘每轮都会变化，因此只能放在活动尾，不能进入稳定系统提示前缀，否则会击穿下游缓存。
 * 它使用用户角色，是因为部分提供方只允许系统消息连续出现在开头；尾块沿用保留上下文的形态，
 * 通过用户角色和显式方括号标签提供。
 */
import type { ModelMessage } from 'ai'

import { isEmpty } from '@velaros-ai/core'

import type { ContextRecord, ContextResidency } from './ContextRecord'
import { compareStableStrings } from './determinism'
import { residentChars, resolveEffectiveResidency } from './projection'
import type { ContextLedgerStats } from './ResidencyLedger'

/** 最大持仓榜的条数。 */
const TopHoldingCount = 3

const DashboardMarker = '[context-dashboard]'

export interface ContextDashboardInput {
  epoch: number
  stats: ContextLedgerStats
  records: readonly ContextRecord[]
  residency: ReadonlyMap<string, ContextResidency>
  projectedTokens: number
  budgetTokens: number
}

/** 渲染 dashboard 尾块；无记录时返回 null（空账本不值得占一条消息）。 */
export function buildContextDashboardMessage(
  input: ContextDashboardInput
): Nullable<ModelMessage> {
  if (input.stats.recordCount === 0) return null

  return { role: 'user', content: renderContextDashboardText(input) }
}

/** dashboard 文本。格式紧凑且**逐轮同形**——只有数字变，模型不必每轮重新学一遍读法。 */
export function renderContextDashboardText(input: ContextDashboardInput): string {
  const occupancy = input.budgetTokens > 0
    ? Math.round((input.projectedTokens / input.budgetTokens) * 1000) / 10
    : 0
  const holdings = collectHoldings(input)
  const byResidency = countByEffectiveResidency(holdings)
  const lines = [
    `${DashboardMarker} epoch=${input.epoch} used=${input.projectedTokens}/${input.budgetTokens}tok (${occupancy}%)`,
    `records=${input.stats.recordCount} inline=${byResidency.INLINE} excerpt=${byResidency.EXCERPT} summarized=${byResidency.SUMMARIZED} evicted=${byResidency.EVICTED} expired=${byResidency.EXPIRED} pendingEvict=${input.stats.pendingEvictCount} faults=${input.stats.totalFaults}`,
  ]

  const top = renderTopHoldings(holdings)
  if (top) lines.push(top)
  lines.push(
    'Non-inline records stay retrievable via context:recall; call context:distill when a phase is done to request one compaction epoch.'
  )

  return lines.join('\n')
}

/** dashboard 尾块的识别谓词（转录/调试面共用，避免各写各的前缀嗅探）。 */
export function isContextDashboardText(value: string): boolean {
  return value.trimStart().startsWith(DashboardMarker)
}

interface DashboardHolding {
  id: string
  label: string
  residency: ContextResidency
  chars: number
}

/**
 * 每条记录的**有效**驻留态与实际占用（与投影同一份 `resolveEffectiveResidency` + `residentChars`）。
 *
 * "有效"两个字是硬要求：dashboard 报的必须等于真发出去的字节，模型才谈得上据此判断自己撑不撑
 * 得住（审计 U21）。共用投影那一份判据就是唯一兑现方式 —— 尾保护已经不改渲染（v3 · R1），
 * 所以这里也不再需要知道谁在窗口里。
 */
function collectHoldings(input: ContextDashboardInput): DashboardHolding[] {
  return input.records.map((record) => {
    const declared = input.residency.get(record.id) ?? record.admittedResidency
    const residency = resolveEffectiveResidency(record, declared)
    return {
      id: record.id,
      label: record.toolName ?? record.kind,
      residency,
      chars: residentChars(record, residency),
    }
  })
}

function countByEffectiveResidency(
  holdings: readonly DashboardHolding[]
): Record<ContextResidency, number> {
  const counts: Record<ContextResidency, number> = {
    INLINE: 0,
    EXCERPT: 0,
    SUMMARIZED: 0,
    EVICTED: 0,
    EXPIRED: 0,
  }
  for (const holding of holdings) counts[holding.residency] += 1
  return counts
}

function renderTopHoldings(holdings: readonly DashboardHolding[]): Nullable<string> {
  const top = [...holdings]
    .filter((holding) => holding.chars > 0)
    .sort((left, right) => right.chars - left.chars || compareStableStrings(left.id, right.id))
    .slice(0, TopHoldingCount)

  if (isEmpty(top)) return null

  return `top: ${top
    .map((holding) => `${holding.id}/${holding.label}=${Math.round(holding.chars / 1000)}k`)
    .join(' ')}`
}
