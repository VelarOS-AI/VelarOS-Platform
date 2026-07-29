import type { ModelMessage } from 'ai'

import { isString } from '@velaros-ai/core'

import {
  CompactionSummaryMarker,
  DynamicHandlesInstruction,
  DynamicHandlesMarker,
  isContextOSGeneratedAssistantMessage,
} from '../history/contextOSMessage'
import {
  enforceConversationScopedToolResultBudget,
  enforceOversizedUserTextSafetyValve,
  MinRecentToolResultsPerConversation,
} from '../history/microCompaction'

import type { ProviderRequestZoneDiagnostic } from './ProviderRequestCompiler'

export interface ProviderRequestReclaimState {
  referenceBudgetChars: number
  recentToolResultsPerConversation: number
  maxUserMessageInlineChars: number
  stripRetrievalIndex: boolean
  stripSemanticSummary: boolean
  /**
   * 已应用的回收阶梯档位游标；-1 = 仅基态未进阶。
   *
   * 显式携带游标取代旧的「按字段等值反查档位」——阶梯步是稀疏 partial（未设字段为 undefined），
   * 对全字段合并后的 current 做等值 findIndex 恒 -1 → nextIndex 恒 0 → 永远返回「合并第 0 级」的
   * 同一状态,回收永不前进。诊断驱动的微调不推进游标（它们与阶梯正交）。
   */
  ladderCursor: number
}

export const DefaultProviderRequestReclaimState: ProviderRequestReclaimState = {
  referenceBudgetChars: 8_000,
  recentToolResultsPerConversation: MinRecentToolResultsPerConversation,
  maxUserMessageInlineChars: 48_000,
  stripRetrievalIndex: false,
  stripSemanticSummary: false,
  ladderCursor: -1,
}

const ReclaimLadder: Array<Partial<ProviderRequestReclaimState>> = [
  { referenceBudgetChars: 4_000 },
  { referenceBudgetChars: 2_000, recentToolResultsPerConversation: 4 },
  { referenceBudgetChars: 1_000, recentToolResultsPerConversation: 3 },
  { referenceBudgetChars: 500, maxUserMessageInlineChars: 24_000 },
  {
    referenceBudgetChars: 0,
    recentToolResultsPerConversation: 2,
    maxUserMessageInlineChars: 12_000,
    stripRetrievalIndex: true,
  },
  {
    referenceBudgetChars: 0,
    recentToolResultsPerConversation: 1,
    maxUserMessageInlineChars: 8_000,
    stripRetrievalIndex: true,
    stripSemanticSummary: true,
  },
]

function mergeReclaimState(
  base: ProviderRequestReclaimState,
  patch: Partial<ProviderRequestReclaimState>
): ProviderRequestReclaimState {
  return {
    referenceBudgetChars: patch.referenceBudgetChars ?? base.referenceBudgetChars,
    recentToolResultsPerConversation:
      patch.recentToolResultsPerConversation ?? base.recentToolResultsPerConversation,
    maxUserMessageInlineChars: patch.maxUserMessageInlineChars ?? base.maxUserMessageInlineChars,
    stripRetrievalIndex: patch.stripRetrievalIndex ?? base.stripRetrievalIndex,
    stripSemanticSummary: patch.stripSemanticSummary ?? base.stripSemanticSummary,
    ladderCursor: patch.ladderCursor ?? base.ladderCursor,
  }
}

/** 两个回收态的**策略面**是否等值（游标是控制元数据，不参与等值——回收进展看策略字段）。 */
export function reclaimPolicyEquals(
  left: ProviderRequestReclaimState,
  right: ProviderRequestReclaimState
): boolean {
  return (
    left.referenceBudgetChars === right.referenceBudgetChars &&
    left.recentToolResultsPerConversation === right.recentToolResultsPerConversation &&
    left.maxUserMessageInlineChars === right.maxUserMessageInlineChars &&
    left.stripRetrievalIndex === right.stripRetrievalIndex &&
    left.stripSemanticSummary === right.stripSemanticSummary
  )
}

/**
 * 按游标沿阶梯前进一档，跳过对当前态无收紧效果的空档（合并只单调收紧：字符预算取 min、
 * strip 标记取 OR），保证每次返回都是策略真前进的态；阶梯耗尽返回 null。
 */
function advanceReclaimLadder(
  current: ProviderRequestReclaimState
): Nullable<ProviderRequestReclaimState> {
  for (let index = current.ladderCursor + 1; index < ReclaimLadder.length; index += 1) {
    const step = ReclaimLadder[index]!
    const next: ProviderRequestReclaimState = {
      referenceBudgetChars: Math.min(
        current.referenceBudgetChars,
        step.referenceBudgetChars ?? current.referenceBudgetChars
      ),
      recentToolResultsPerConversation: Math.min(
        current.recentToolResultsPerConversation,
        step.recentToolResultsPerConversation ?? current.recentToolResultsPerConversation
      ),
      maxUserMessageInlineChars: Math.min(
        current.maxUserMessageInlineChars,
        step.maxUserMessageInlineChars ?? current.maxUserMessageInlineChars
      ),
      stripRetrievalIndex: current.stripRetrievalIndex || Boolean(step.stripRetrievalIndex),
      stripSemanticSummary: current.stripSemanticSummary || Boolean(step.stripSemanticSummary),
      ladderCursor: index,
    }
    if (!reclaimPolicyEquals(next, current)) return next
  }

  return null
}

function stripContextOSBlocks(
  history: ModelMessage[],
  options: { stripRetrievalIndex: boolean; stripSemanticSummary: boolean }
): ModelMessage[] {
  if (!options.stripRetrievalIndex && !options.stripSemanticSummary) return history

  const filtered = history.filter((message) => {
    if (message.role !== 'assistant' || !isString(message.content)) return true

    if (!isContextOSGeneratedAssistantMessage(message)) return true

    const content = message.content
    if (options.stripRetrievalIndex && content.includes(DynamicHandlesMarker)) return false

    if (options.stripSemanticSummary && content.includes(CompactionSummaryMarker)) return false

    return true
  })

  return filtered.length === history.length ? history : filtered
}

function trimEmbeddedRetrievalIndex(content: string): string {
  const markerIndex = content.indexOf(DynamicHandlesMarker)
  if (markerIndex < 0) return content

  const before = content.slice(0, markerIndex).trimEnd()
  const afterMarker = content.slice(markerIndex)
  const instructionEnd = afterMarker.indexOf(DynamicHandlesInstruction)
  if (instructionEnd < 0) return before

  const remainder = afterMarker.slice(instructionEnd + DynamicHandlesInstruction.length).trimStart()
  const nextSection = remainder.indexOf('\n\n[')
  const tail = nextSection >= 0 ? remainder.slice(nextSection).trimStart() : ''

  return [before, tail].filter(Boolean).join('\n\n')
}

function applyContextOSBlockReclaim(
  history: ModelMessage[],
  state: ProviderRequestReclaimState
): ModelMessage[] {
  let nextHistory = stripContextOSBlocks(history, state)
  if (!state.stripRetrievalIndex || nextHistory === history) return nextHistory

  nextHistory = nextHistory.map((message) => {
    if (message.role !== 'assistant' || !isString(message.content)) return message

    if (!message.content.includes(DynamicHandlesMarker)) return message

    const trimmed = trimEmbeddedRetrievalIndex(message.content)
    if (trimmed === message.content) return message

    if (!trimmed) return message

    return {
      ...message,
      content: trimmed,
    } as ModelMessage
  })

  return nextHistory
}

export function applyProviderRequestReclaimState(
  messages: ModelMessage[],
  state: ProviderRequestReclaimState
): ModelMessage[] {
  let working = applyContextOSBlockReclaim(messages, state)
  const userText = enforceOversizedUserTextSafetyValve(working, state.maxUserMessageInlineChars)
  if (userText.changedMessages > 0) {
    working = userText.history
  }

  const microCompact = enforceConversationScopedToolResultBudget(
    working,
    state.recentToolResultsPerConversation
  )
  if (microCompact.changedMessages > 0) {
    working = microCompact.history
  }

  return working
}

export function resolveNextReclaimState(
  current: ProviderRequestReclaimState,
  zoneDiagnostics: readonly ProviderRequestZoneDiagnostic[]
): Nullable<ProviderRequestReclaimState> {
  if (!zoneDiagnostics.length) return advanceReclaimLadder(current)

  for (const diagnostic of zoneDiagnostics) {
    for (const action of diagnostic.reclaimOrder) {
      if (action === 'keep') continue

      if (action === 'reference') {
        if (current.referenceBudgetChars > 0) return mergeReclaimState(current, {
            referenceBudgetChars: Math.max(0, Math.floor(current.referenceBudgetChars / 2)),
            recentToolResultsPerConversation: Math.max(
              1,
              current.recentToolResultsPerConversation - 1
            ),
          })
      }

      if (action === 'summarize') {
        if (current.maxUserMessageInlineChars > 8_000) return mergeReclaimState(current, {
            maxUserMessageInlineChars: Math.max(8_000, Math.floor(current.maxUserMessageInlineChars / 2)),
            recentToolResultsPerConversation: Math.max(
              1,
              current.recentToolResultsPerConversation - 1
            ),
          })
      }

      if (action === 'evict') {
        if (!current.stripRetrievalIndex) return mergeReclaimState(current, { stripRetrievalIndex: true })

        if (!current.stripSemanticSummary) return mergeReclaimState(current, { stripSemanticSummary: true })
      }

      if (action === 'page-out') {
        if (current.referenceBudgetChars > 0) return mergeReclaimState(current, { referenceBudgetChars: 0 })
      }
    }
  }

  // 诊断存在但各 zone 的 reclaimOrder 已到底（微调全部被守卫挡下）→ 继续沿阶梯前进。
  return advanceReclaimLadder(current)
}

export function buildInitialReclaimState(
  referenceBudgetChars?: LooseOptional<number>
): ProviderRequestReclaimState {
  return {
    ...DefaultProviderRequestReclaimState,
    referenceBudgetChars: Math.max(
      0,
      Math.floor(referenceBudgetChars ?? DefaultProviderRequestReclaimState.referenceBudgetChars)
    ),
  }
}
