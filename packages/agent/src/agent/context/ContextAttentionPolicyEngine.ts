import type { ModelMessage } from 'ai'

import { isArray, isEmpty, isNotNull, isNull,isRecord, isString, Log } from '@velaros-ai/core'
import type { ChatContextDebugTraceEntry } from '@velaros-ai/core/types'

import { readVerbatimString } from './providerRequest/messageScan'
import type { ContextEvidenceGraph } from './ContextEvidenceGraph'
import { type ContextLedgerEntry,type ContextWorkingSetBlock, hasFailureSignal } from './ContextLedger'
import { DefaultContextWorkingSetZonePolicies } from './ContextWorkingSetZones'
import { isStatefulToolResultName } from './StatefulToolResults'

export const ContextAttentionLongToolPayloadChars = 1_200
export const ContextAttentionLongMessageSummaryChars = 2_400
export const ContextAttentionInlineExcerptChars = 360

export type ContextAttentionRouterMode = 'shadow' | 'guarded' | 'active'
export type ContextAttentionTraceAction = ChatContextDebugTraceEntry['action']
export type ContextAttentionLedgerAction = ContextLedgerEntry['action']

export interface ContextAttentionFeatures {
  recency: number
  semanticSimilarity: number
  lexicalSimilarity: number
  pathSimilarity: number
  symbolSimilarity: number
  bm25Similarity: number
  embeddingSimilarity: Nullable<number>
  explicitlyMentioned: boolean
  currentTaskEvidence: boolean
  toolFailureReason: boolean
  statefulToolResult: boolean
  recoverable: boolean
  expired: boolean
  zonePriority: number
  tokenCost: number
}

export interface ContextAttentionScoreBreakdown {
  base: number
  weights: Record<string, number>
  contributions: Record<string, number>
  selectedReasons: string[]
  downgradedReasons: string[]
  thresholds: {
    handleBelow: number
    summarizeBelow: number
    dropBelow: number
  }
}

export interface ContextAttentionRoutingScores {
  needScore: number
  evidenceScore: number
  demotionSafetyScore: number
  exactnessRiskScore: number
  stalenessScore: number
  redundancyScore: number
  tokenPressureScore: number
}

export interface ContextAttentionActionCandidate {
  action: ContextAttentionTraceAction
  ledgerAction: ContextAttentionLedgerAction
  estimatedTokens: number
  utility: number
  risk: number
  expectedValue: number
  reason: string
}

/**
 * 查询侧单遍抽取结果：tokenize / mention / path / symbol / bm25 词表只依赖 query，路由内对同一
 * query 恒定。旧实现对 N 个 block 的每一个都在 resolveFeatures 里重算这五套词表；抽出到路由每轮
 * 算一次、N 个 block 复用。内容侧词表仍按 block 逐个算（每块内容不同，无法复用）。
 */
export interface ContextAttentionQueryAnalysis {
  tokens: Set<string>
  mentions: string[]
  paths: string[]
  symbols: string[]
  bm25Tokens: string[]
}

export interface ContextAttentionPolicyInput {
  block: ContextWorkingSetBlock
  message?: ModelMessage
  messageIndex: Nullable<number>
  latestUserIndex: number
  query: string
  /** 路由每轮预算一次的查询侧词表；缺省时按 query 现算（等价，仅失去复用）。 */
  queryAnalysis?: LooseOptional<ContextAttentionQueryAnalysis>
  messageCount: number
  evidenceGraph?: LooseOptional<ContextEvidenceGraph>
  queryEmbedding?: LooseOptional<readonly number[]>
}

export interface ContextAttentionDecision {
  blockId: string
  zone: ContextWorkingSetBlock['zone']
  chars: number
  action: ContextAttentionTraceAction
  ledgerAction: ContextAttentionLedgerAction
  reason: string
  score: number
  routingScores: ContextAttentionRoutingScores
  features: ContextAttentionFeatures
  breakdown: ContextAttentionScoreBreakdown
  actionCandidates?: ContextAttentionActionCandidate[]
  hardRetained: boolean
  messageIndex: Nullable<number>
}

const ContextAttentionDecisionThresholds = Object.freeze({
  handleBelow: 0.72,
  summarizeBelow: 0.5,
  dropBelow: 0.35,
})

const ContextAttentionFeatureWeights = Object.freeze({
  base: 0.08,
  needScore: 0.43,
  evidenceScore: 0.28,
  exactnessRiskScore: 0.22,
  demotionSafetyScore: -0.08,
  stalenessScore: -0.17,
  redundancyScore: -0.07,
  tokenPressureScore: -0.08,
})

const log = Log.tag('ContextAttentionPolicyEngine')

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000
}

function roundContribution(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}

export function readContextAttentionMessageIndex(blockId: string): Nullable<number> {
  const match = /^message:(\d+)$/u.exec(blockId)
  if (!match) return null

  const index = Number(match[1])
  return Number.isInteger(index) ? index : null
}

function extractText(value: unknown): string {
  if (isString(value)) return value
  if (isArray(value)) return value.map(extractText).filter(Boolean).join('\n')
  if (!isRecord(value)) return ''

  const recordText = [recordString(value, 'text'), recordString(value, 'value')]
    .filter(Boolean)
    .join('\n')
  if (recordText.trim()) return recordText

  try {
    return JSON.stringify(value) ?? ''
  } catch (error) {
    log.debug('failed to stringify context attention value', { error: String(error) })
    return String(value)
  }
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return isString(value) ? value : ''
}

export function readContextAttentionMessageText(message?: ModelMessage): string {
  if (!message) return ''
  return extractText(message.content)
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .match(/[\p{L}\p{N}_]{2,}/gu)

  return new Set(tokens ?? [])
}

function tokenizeList(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? []
}

function extractMentionCandidates(text: string): string[] {
  const candidates = text.match(/[\p{L}\p{N}_./:-]{3,}/gu) ?? []
  return candidates
    .map((candidate) => candidate.toLowerCase())
    .filter((candidate) => candidate.includes('.') || candidate.includes('/') || candidate.includes(':'))
}

function extractSymbolCandidates(text: string): string[] {
  const symbols = text.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/gu) ?? []
  return [...new Set(symbols.map((symbol) => symbol.toLowerCase()).filter((symbol) => symbol.length >= 3))]
}

/** 查询侧词表单遍预算：五套 query-only 词表算一次，路由内 N 个 block 复用。 */
export function buildContextAttentionQueryAnalysis(query: string): ContextAttentionQueryAnalysis {
  const mentions = extractMentionCandidates(query)
  return {
    tokens: tokenize(query),
    mentions,
    // = extractPathCandidates(query)：extractPathCandidates 本就是 mention 候选的过滤子集。
    paths: mentions.filter((candidate) => candidate.includes('/') || /\.[\w]+$/u.test(candidate)),
    symbols: extractSymbolCandidates(query),
    bm25Tokens: [
      ...new Set(tokenizeList(query).flatMap((token) => token.split(/[./:-]/u).concat(token))),
    ]
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  }
}

function lexicalSimilarity(
  queryTokens: Set<string>,
  queryMentions: readonly string[],
  content: string
): number {
  if (queryTokens.size === 0) return 0

  const contentTokens = tokenize(content)
  if (contentTokens.size === 0) return 0

  let overlap = 0
  queryTokens.forEach((token) => {
    if (contentTokens.has(token)) overlap += 1
  })

  const tokenSimilarity = overlap / queryTokens.size
  if (isEmpty(queryMentions)) return tokenSimilarity

  const contentLower = content.toLowerCase()
  const mentionHits = queryMentions.filter((candidate) => contentLower.includes(candidate)).length
  const mentionSimilarity = mentionHits / queryMentions.length

  return Math.max(tokenSimilarity, mentionSimilarity)
}

function pathSimilarity(queryPaths: readonly string[], content: string): number {
  if (isEmpty(queryPaths)) return 0

  const contentLower = content.toLowerCase()
  const hits = queryPaths.filter((path) => contentLower.includes(path)).length
  return hits / queryPaths.length
}

function symbolSimilarity(querySymbols: readonly string[], content: string): number {
  if (isEmpty(querySymbols)) return 0

  const contentSymbols = new Set(extractSymbolCandidates(content))
  const hits = querySymbols.filter((symbol) => contentSymbols.has(symbol)).length
  return hits / querySymbols.length
}

function bm25LikeSimilarity(queryTokens: readonly string[], content: string): number {
  if (isEmpty(queryTokens)) return 0

  const contentTokens = tokenizeList(content)
  if (isEmpty(contentTokens)) return 0

  const frequencies = new Map<string, number>()
  contentTokens.forEach((token) => {
    token.split(/[./:-]/u).concat(token).forEach((part) => {
      const normalized = part.trim()
      if (normalized.length < 3) return
      frequencies.set(normalized, (frequencies.get(normalized) ?? 0) + 1)
    })
  })

  const k1 = 1.2
  const b = 0.75
  const averageLength = 800
  const lengthNorm = 1 - b + b * (contentTokens.length / averageLength)
  const rawScore = queryTokens.reduce((score, token) => {
    const frequency = frequencies.get(token) ?? 0
    if (frequency === 0) return score
    return score + ((frequency * (k1 + 1)) / (frequency + k1 * lengthNorm))
  }, 0)

  return rawScore / (rawScore + queryTokens.length)
}

function cosineSimilarity(left?: LooseOptional<readonly number[]>, right?: LooseOptional<readonly number[]>): Nullable<number> {
  if (!left || !right || left.length === 0 || left.length !== right.length) return null

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (leftNorm <= 0 || rightNorm <= 0) return null
  return clamp01((dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) + 1) / 2)
}

function hybridSemanticSimilarity(input: {
  lexical: number
  path: number
  symbol: number
  bm25: number
  embedding: Nullable<number>
}): number {
  const weighted: Array<{ value: number; weight: number }> = [
    { value: input.lexical, weight: 0.42 },
    { value: input.path, weight: 0.22 },
    { value: input.symbol, weight: 0.2 },
    { value: input.bm25, weight: 0.16 },
  ]
  if (isNotNull(input.embedding)) weighted.push({ value: input.embedding, weight: 0.2 })

  const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0)
  const weightedScore =
    weighted.reduce((total, entry) => total + entry.value * entry.weight, 0) / Math.max(0.01, totalWeight)

  return Math.max(input.lexical, input.path, input.symbol, input.bm25, input.embedding ?? 0, weightedScore)
}

function hasExplicitMention(
  queryMentions: readonly string[],
  queryTokens: ReadonlySet<string>,
  content: string
): boolean {
  const contentLower = content.toLowerCase()
  if (queryMentions.some((candidate) => contentLower.includes(candidate))) return true

  const contentTokens = tokenize(content)
  return [...queryTokens].some((token) => token.length >= 8 && contentTokens.has(token))
}

function isHardRetainedBlock(
  block: ContextWorkingSetBlock,
  messageIndex: Nullable<number>,
  latestUserIndex: number
): boolean {
  if (block.zone === 'kernel' || block.zone === 'active-task' || block.zone === 'pinned-evidence') return true

  if (block.lifecycle?.pinned || block.lifecycle?.activeTask) return true

  return messageIndex === latestUserIndex
}

function messageHasStatefulToolResult(message?: ModelMessage): boolean {
  if (!message || message.role !== 'tool' || !isArray(message.content)) return false

  return (message.content as unknown[]).some((part) => {
    if (!isRecord(part) || part.type !== 'tool-result') return false
    const toolName = readVerbatimString(part.toolName)
    return Boolean(toolName && isStatefulToolResultName(toolName))
  })
}

function resolveFeatures(
  input: ContextAttentionPolicyInput,
  queryAnalysis: ContextAttentionQueryAnalysis
): ContextAttentionFeatures {
  const { block, message, messageIndex, latestUserIndex, messageCount } = input
  // 文本抽取单遍：message block 的正文在 classify 阶段已抽成 block.contentText，且
  // extractBlockText(message.content) 与本处 readContextAttentionMessageText(message) 逐字节等价
  // （同一抽取算法），直接复用免去每块一次全量 stringify；非 message block 仍按块内容抽取。
  const content = message
    ? block.contentText ?? readContextAttentionMessageText(message)
    : extractText(block.content)
  const evidenceNode = input.evidenceGraph?.nodesByBlockId.get(block.id)
  const lexical = roundScore(lexicalSimilarity(queryAnalysis.tokens, queryAnalysis.mentions, content))
  const path = roundScore(pathSimilarity(queryAnalysis.paths, content))
  const symbol = roundScore(symbolSimilarity(queryAnalysis.symbols, content))
  const bm25 = roundScore(bm25LikeSimilarity(queryAnalysis.bm25Tokens, content))
  const embedding = cosineSimilarity(input.queryEmbedding, block.embedding)
  const semanticSimilarity = roundScore(
    hybridSemanticSimilarity({
      lexical,
      path,
      symbol,
      bm25,
      embedding,
    })
  )
  const distanceFromLatest =
    isNull(messageIndex) ? messageCount : Math.max(0, latestUserIndex - messageIndex)
  const recency = isNull(messageIndex)
    ? 0.35
    : 1 - distanceFromLatest / Math.max(1, messageCount - 1)
  const oldRelativeToLatestUser =
    isNotNull(messageIndex) && messageIndex < Math.max(0, latestUserIndex - 1)
  const zonePolicy = DefaultContextWorkingSetZonePolicies[block.zone]
  const toolFailureReason =
    Boolean(block.safety?.containsFailureCause) ||
    (block.zone === 'tool-payloads' || message?.role === 'tool') && hasFailureSignal(content)
  const statefulToolResult =
    Boolean(block.safety?.statefulToolResult) || messageHasStatefulToolResult(message)
  const recoverable =
    Boolean(block.lifecycle?.recoverable) ||
    Boolean(block.payloadRef) ||
    block.zone === 'tool-payloads' ||
    block.zone === 'retrieval-index' ||
    block.zone === 'recall'

  return {
    recency: roundScore(recency),
    semanticSimilarity,
    lexicalSimilarity: lexical,
    pathSimilarity: path,
    symbolSimilarity: symbol,
    bm25Similarity: bm25,
    embeddingSimilarity: isNull(embedding) ? null : roundScore(embedding),
    explicitlyMentioned: hasExplicitMention(queryAnalysis.mentions, queryAnalysis.tokens, content),
    currentTaskEvidence:
      Boolean(block.lifecycle?.activeTask) ||
      isNotNull(messageIndex) && messageIndex >= Math.max(0, latestUserIndex - 1),
    toolFailureReason,
    statefulToolResult,
    recoverable,
    expired:
      Boolean(block.lifecycle?.expired) ||
      Boolean(block.lifecycle?.stale) ||
      Boolean(block.stale) ||
      Boolean(evidenceNode?.stale) ||
      (oldRelativeToLatestUser &&
        (block.zone === 'tool-payloads' || block.zone === 'diagnostics' || distanceFromLatest >= 4)),
    zonePriority: roundScore(zonePolicy.priority / 100),
    tokenCost: roundScore(Math.max(0, block.chars - 1_200) / 10_000),
  }
}

function buildSelectedReasons(features: ContextAttentionFeatures): string[] {
  const reasons: string[] = []
  if (features.explicitlyMentioned) reasons.push('explicitly mentioned')
  if (features.currentTaskEvidence) reasons.push('current task evidence')
  if (features.toolFailureReason) reasons.push('tool failure evidence')
  if (features.semanticSimilarity >= 0.5) reasons.push('strong semantic match')
  if (features.recency >= 0.75) reasons.push('recent context')
  if (features.zonePriority >= 0.85) reasons.push('high-priority zone')
  if (features.expired) reasons.push('stale or expired')
  if (features.recoverable) reasons.push('recoverable payload')

  return reasons
}

function buildDowngradedReasons(features: ContextAttentionFeatures): string[] {
  const reasons: string[] = []
  if (features.semanticSimilarity < 0.2 && !features.explicitlyMentioned) reasons.push('weak relevance')
  if (features.expired) reasons.push('stale or expired')
  if (features.recoverable) reasons.push('recoverable payload')
  if (features.tokenCost >= 0.2) reasons.push('high token cost')
  if (features.zonePriority <= 0.3) reasons.push('low-priority zone')

  return reasons
}

function resolveRoutingScores(
  features: ContextAttentionFeatures,
  hardRetained: boolean
): ContextAttentionRoutingScores {
  const needScore = hardRetained
    ? 1
    : clamp01(
        features.semanticSimilarity * 0.42 +
          features.recency * 0.18 +
          features.zonePriority * 0.12 +
          (features.explicitlyMentioned ? 0.14 : 0) +
          (features.currentTaskEvidence ? 0.14 : 0) +
          (features.toolFailureReason ? 0.12 : 0)
      )
  const evidenceScore = hardRetained
    ? 1
    : clamp01(
        (features.toolFailureReason ? 1 : 0) +
          (features.currentTaskEvidence ? 0.65 : 0) +
          (features.statefulToolResult ? 0.65 : 0) +
          (features.explicitlyMentioned ? 0.55 : 0) +
          Math.max(0, features.zonePriority - 0.72) * 0.5
      )
  const exactnessRiskScore = hardRetained
    ? 1
    : clamp01(
        (features.toolFailureReason ? 1 : 0) +
          (features.statefulToolResult ? 0.82 : 0) +
          (features.explicitlyMentioned ? 0.55 : 0) +
          (features.currentTaskEvidence ? 0.32 : 0)
      )
  const stalenessScore = features.expired ? 1 : 0
  const tokenPressureScore = features.tokenCost
  const redundancyScore = clamp01(
    (features.expired ? 0.45 : 0) +
      (features.recoverable ? 0.25 : 0) +
      (features.semanticSimilarity < 0.15 ? 0.2 : 0) -
      exactnessRiskScore * 0.3
  )
  const demotionSafetyScore = hardRetained
    ? 0
    : clamp01(
        (features.recoverable ? 0.52 : 0) +
          (features.expired ? 0.18 : 0) +
          tokenPressureScore * 0.2 +
          (features.semanticSimilarity < 0.2 ? 0.12 : 0) -
          evidenceScore * 0.32 -
          exactnessRiskScore * 0.45
      )

  return {
    needScore: roundScore(needScore),
    evidenceScore: roundScore(evidenceScore),
    demotionSafetyScore: roundScore(demotionSafetyScore),
    exactnessRiskScore: roundScore(exactnessRiskScore),
    stalenessScore: roundScore(stalenessScore),
    redundancyScore: roundScore(redundancyScore),
    tokenPressureScore: roundScore(tokenPressureScore),
  }
}

function scoreFeatures(
  features: ContextAttentionFeatures,
  hardRetained: boolean,
  routingScores: ContextAttentionRoutingScores
): { score: number; breakdown: ContextAttentionScoreBreakdown } {
  const weights = ContextAttentionFeatureWeights
  const contributions = {
    base: weights.base,
    needScore: routingScores.needScore * weights.needScore,
    evidenceScore: routingScores.evidenceScore * weights.evidenceScore,
    exactnessRiskScore: routingScores.exactnessRiskScore * weights.exactnessRiskScore,
    demotionSafetyScore: routingScores.demotionSafetyScore * weights.demotionSafetyScore,
    stalenessScore: routingScores.stalenessScore * weights.stalenessScore,
    redundancyScore: routingScores.redundancyScore * weights.redundancyScore,
    tokenPressureScore: routingScores.tokenPressureScore * weights.tokenPressureScore,
  }
  const rawScore = hardRetained
    ? 1
    : Object.values(contributions).reduce((total, contribution) => total + contribution, 0)

  return {
    score: roundScore(rawScore),
    breakdown: {
      base: weights.base,
      weights: { ...weights },
      contributions: Object.fromEntries(
        Object.entries(contributions).map(([key, value]) => [key, roundContribution(value)])
      ),
      selectedReasons: buildSelectedReasons(features),
      downgradedReasons: buildDowngradedReasons(features),
      thresholds: ContextAttentionDecisionThresholds,
    },
  }
}

function reasonFromReasons(prefix: string, breakdown: ContextAttentionScoreBreakdown): string {
  const selected = breakdown.selectedReasons.join(', ')
  const downgraded = breakdown.downgradedReasons.join(', ')
  const parts = [prefix]
  if (selected) parts.push(`selected: ${selected}`)
  if (downgraded) parts.push(`downgraded: ${downgraded}`)
  return parts.join('; ')
}

export class ContextAttentionPolicyEngine {
  public decide(input: ContextAttentionPolicyInput): ContextAttentionDecision {
    const { block, message, messageIndex, latestUserIndex } = input
    const hardRetained = isHardRetainedBlock(block, messageIndex, latestUserIndex)
    const queryAnalysis = input.queryAnalysis ?? buildContextAttentionQueryAnalysis(input.query)
    const features = resolveFeatures(input, queryAnalysis)
    const routingScores = resolveRoutingScores(features, hardRetained)
    const { score, breakdown } = scoreFeatures(features, hardRetained, routingScores)

    if (hardRetained) return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'retain',
        ledgerAction: 'inline',
        reason: 'kernel, active-task, pinned evidence, and latest user request are hard retained',
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    if (block.zone === 'tool-schemas') return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'skip',
        ledgerAction: 'inline',
        reason: 'tool schema exposure is out of scope for this router phase',
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    if (isNull(messageIndex)) {
      if (
        (block.zone === 'diagnostics' || block.zone === 'recall' || block.zone === 'retrieval-index') &&
        features.expired &&
        !features.explicitlyMentioned &&
        !features.currentTaskEvidence &&
        !features.toolFailureReason &&
        score < ContextAttentionDecisionThresholds.dropBelow
      ) return {
          blockId: block.id,
          zone: block.zone,
          chars: block.chars,
          action: 'drop',
          ledgerAction: 'drop',
          reason: reasonFromReasons('stale low-value non-message block is safe to drop', breakdown),
          score,
          routingScores,
          features,
          breakdown,
          hardRetained,
          messageIndex,
        }

      return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'inline',
        ledgerAction: 'inline',
        reason: reasonFromReasons('non-message block remains inline after attention scoring', breakdown),
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }
    }

    const oldRelativeToLatestUser = messageIndex < Math.max(0, latestUserIndex - 1)
    const statefulToolResult = messageHasStatefulToolResult(message)

    if (features.toolFailureReason) return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'inline',
        ledgerAction: 'inline',
        reason: reasonFromReasons('tool failure evidence remains inline', breakdown),
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    if (features.explicitlyMentioned) return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'inline',
        ledgerAction: 'inline',
        reason: reasonFromReasons('explicitly mentioned context remains inline', breakdown),
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    if (
      block.zone === 'tool-payloads' &&
      message?.role === 'tool' &&
      oldRelativeToLatestUser &&
      block.chars >= ContextAttentionLongToolPayloadChars &&
      features.recoverable &&
      !statefulToolResult &&
      score < ContextAttentionDecisionThresholds.handleBelow
    ) return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'handle',
        ledgerAction: 'reference',
        reason: reasonFromReasons(
          'old tool payload is recoverable and below the inline attention threshold',
          breakdown
        ),
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    if (
      block.zone === 'recent-turns' &&
      oldRelativeToLatestUser &&
      block.chars >= ContextAttentionLongMessageSummaryChars &&
      score < ContextAttentionDecisionThresholds.summarizeBelow
    ) return {
        blockId: block.id,
        zone: block.zone,
        chars: block.chars,
        action: 'summarize',
        ledgerAction: 'summary',
        reason: reasonFromReasons(
          'old conversation turn is long and weakly related to the latest request',
          breakdown
        ),
        score,
        routingScores,
        features,
        breakdown,
        hardRetained,
        messageIndex,
      }

    return {
      blockId: block.id,
      zone: block.zone,
      chars: block.chars,
      action: 'inline',
      ledgerAction: 'inline',
      reason: reasonFromReasons('block remains inline after attention scoring', breakdown),
      score,
      routingScores,
      features,
      breakdown,
      hardRetained,
      messageIndex,
    }
  }
}
