import { readFileSync } from 'node:fs'

import { isArray, isString, isTrue } from '@velaros-ai/core'
import {
  readNumberScalar,
  readRecord as readUnknownRecord,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ContextAttentionRouterMode } from './ContextAttentionPolicyEngine'
import type {
  ContextAttentionReplayDecisionRecord,
  ContextAttentionReplayRecord,
} from './ContextAttentionReplayRecorder'

export interface ContextAttentionReplayRouteMetrics {
  routeId: string
  mode: ContextAttentionRouterMode
  budgetTokens: Nullable<number>
  originalTokens: number
  routedTokens: number
  tokenReduction: number
  downgradedBlocks: number
  handleBlocks: number
  summaryBlocks: number
  droppedBlocks: number
  fatalViolations: number
  warnings: number
  hardRetentionViolations: number
  failureEvidenceRetained: boolean
  latestUserRetained: boolean
  pinnedEvidenceRetained: boolean
  statefulToolRetained: boolean
  recallToolResident: boolean
  staleEvidenceInlineBlocks: number
}

export interface ContextAttentionReplayTotals {
  originalTokens: number
  routedTokens: number
  tokenReduction: number
  downgradedBlocks: number
  handleBlocks: number
  summaryBlocks: number
  droppedBlocks: number
  fatalViolations: number
  warnings: number
  hardRetentionViolations: number
  failureEvidenceRetainedRate: number
  latestUserRetainedRate: number
  pinnedEvidenceRetainedRate: number
  statefulToolRetainedRate: number
  recallToolResidentRate: number
  staleEvidenceInlineBlocks: number
}

export interface ContextAttentionReplayEvaluation {
  schemaVersion: 1
  totalRecords: number
  modes: ContextAttentionRouterMode[]
  totals: ContextAttentionReplayTotals
  routes: ContextAttentionReplayRouteMetrics[]
}

type ReplayAction = ContextAttentionReplayDecisionRecord['action']

function readNestedRecord(value: unknown, key: string): Nullable<Record<string, unknown>> {
  const record = readUnknownRecord(value)
  if (!record) return null
  const next = record[key]
  return readUnknownRecord(next)
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}

function safeRate(numerator: number, denominator: number): number {
  return denominator <= 0 ? 1 : roundMetric(numerator / denominator)
}

function estimateActionTokens(action: ReplayAction, chars: number): number {
  switch (action) {
    case 'drop':
    case 'skip':
      return 0
    case 'handle':
      return 180
    case 'summarize':
      return Math.min(Math.max(1, Math.ceil(chars / 12)), 220)
    default:
      return Math.max(1, Math.ceil(chars / 4))
  }
}

function isInlineResidentAction(action: ReplayAction): boolean {
  return action === 'inline' || action === 'retain'
}

function isDowngradedAction(action: ReplayAction): boolean {
  return action === 'handle' || action === 'summarize' || action === 'drop'
}

function readDecisionMetadata(
  decision: ContextAttentionReplayDecisionRecord
): Record<string, unknown> {
  return decision.metadata ?? {}
}

function readDecisionZone(decision: ContextAttentionReplayDecisionRecord): string {
  const zone = readDecisionMetadata(decision).zone
  return isString(zone) ? zone : ''
}

function readDecisionChars(decision: ContextAttentionReplayDecisionRecord): number {
  const chars = readNumberScalar(readDecisionMetadata(decision).chars)
  return Math.max(0, chars ?? 0)
}

function readDecisionFeatures(
  decision: ContextAttentionReplayDecisionRecord
): Record<string, unknown> {
  return readNestedRecord(readDecisionMetadata(decision), 'features') ?? {}
}

function readDecisionEvidence(
  decision: ContextAttentionReplayDecisionRecord
): Record<string, unknown> {
  return readNestedRecord(readDecisionMetadata(decision), 'evidence') ?? {}
}

function readFirstMetadataRecord(
  record: ContextAttentionReplayRecord,
  key: string
): Nullable<Record<string, unknown>> {
  for (const decision of record.decisions) {
    const value = readNestedRecord(readDecisionMetadata(decision), key)
    if (value) return value
  }

  return null
}

function readRouteOptimizationEstimatedTokens(record: ContextAttentionReplayRecord): Nullable<number> {
  const optimization = readFirstMetadataRecord(record, 'routeOptimization')
  return readNumberScalar(optimization?.estimatedTokens)
}

function readRouteValidation(record: ContextAttentionReplayRecord): Record<string, unknown> {
  return readFirstMetadataRecord(record, 'routeValidation') ?? {}
}

function countValidationEntries(validation: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = validation[key]
    if (isArray(value)) return value.length
  }

  return 0
}

function routeOriginalTokens(record: ContextAttentionReplayRecord): number {
  return record.decisions.reduce(
    (total, decision) => total + Math.max(0, Math.ceil(readDecisionChars(decision) / 4)),
    0
  )
}

function routeFallbackTokens(record: ContextAttentionReplayRecord): number {
  return record.decisions.reduce(
    (total, decision) => total + estimateActionTokens(decision.action, readDecisionChars(decision)),
    0
  )
}

function allMatchingDecisionsRetained(
  decisions: readonly ContextAttentionReplayDecisionRecord[],
  predicate: (decision: ContextAttentionReplayDecisionRecord) => boolean
): boolean {
  const matching = decisions.filter(predicate)
  return matching.every((decision) => isInlineResidentAction(decision.action))
}

function hasMatchingDecision(
  decisions: readonly ContextAttentionReplayDecisionRecord[],
  predicate: (decision: ContextAttentionReplayDecisionRecord) => boolean
): boolean {
  return decisions.some(predicate)
}

function countRoutesWithRetainedMatchingDecisions(
  records: readonly ContextAttentionReplayRecord[],
  predicate: (decision: ContextAttentionReplayDecisionRecord) => boolean
): number {
  return records.filter(
    (record) =>
      hasMatchingDecision(record.decisions, predicate) &&
      allMatchingDecisionsRetained(record.decisions, predicate)
  ).length
}

function decisionHasFeature(
  decision: ContextAttentionReplayDecisionRecord,
  key: string
): boolean {
  return isTrue(readDecisionFeatures(decision)[key])
}

function isLatestUserCandidate(decision: ContextAttentionReplayDecisionRecord): boolean {
  return (
    readDecisionZone(decision) === 'recent-turns' &&
    isTrue(readDecisionMetadata(decision).hardRetained)
  )
}

function isPinnedEvidenceDecision(decision: ContextAttentionReplayDecisionRecord): boolean {
  return readDecisionZone(decision) === 'pinned-evidence'
}

function isFailureEvidenceDecision(decision: ContextAttentionReplayDecisionRecord): boolean {
  return decisionHasFeature(decision, 'toolFailureReason')
}

function isStatefulToolDecision(decision: ContextAttentionReplayDecisionRecord): boolean {
  return decisionHasFeature(decision, 'statefulToolResult')
}

function isStaleEvidenceDecision(decision: ContextAttentionReplayDecisionRecord): boolean {
  return isTrue(readDecisionEvidence(decision).stale)
}

function routeRecallToolResident(record: ContextAttentionReplayRecord): boolean {
  const fingerprint = record.requestFingerprint
  if (!fingerprint || fingerprint.contextRefCount <= 0) return true
  return fingerprint.availableToolNames.includes('recall_context')
}

function routeHardRetentionViolations(record: ContextAttentionReplayRecord): number {
  return record.decisions.filter(
    (decision) =>
      isTrue(readDecisionMetadata(decision).hardRetained) &&
      !isInlineResidentAction(decision.action)
  ).length
}

function evaluateRecord(record: ContextAttentionReplayRecord): ContextAttentionReplayRouteMetrics {
  const originalTokens = routeOriginalTokens(record)
  const routedTokens =
    readRouteOptimizationEstimatedTokens(record) ?? routeFallbackTokens(record)
  const validation = readRouteValidation(record)
  const fatalViolations = countValidationEntries(validation, ['fatalViolations'])
  const warnings = countValidationEntries(validation, ['warningViolations', 'warnings'])
  const staleEvidenceInlineBlocks = record.decisions.filter(
    (decision) => isStaleEvidenceDecision(decision) && isInlineResidentAction(decision.action)
  ).length
  const tokenReduction =
    originalTokens <= 0 ? 0 : roundMetric((originalTokens - routedTokens) / originalTokens)

  return {
    routeId: record.routeId,
    mode: record.mode,
    budgetTokens: record.budgetTokens,
    originalTokens,
    routedTokens,
    tokenReduction,
    downgradedBlocks: record.decisions.filter((decision) => isDowngradedAction(decision.action)).length,
    handleBlocks: record.decisions.filter((decision) => decision.action === 'handle').length,
    summaryBlocks: record.decisions.filter((decision) => decision.action === 'summarize').length,
    droppedBlocks: record.decisions.filter((decision) => decision.action === 'drop').length,
    fatalViolations,
    warnings,
    hardRetentionViolations: routeHardRetentionViolations(record),
    failureEvidenceRetained: allMatchingDecisionsRetained(record.decisions, isFailureEvidenceDecision),
    latestUserRetained: allMatchingDecisionsRetained(record.decisions, isLatestUserCandidate),
    pinnedEvidenceRetained: allMatchingDecisionsRetained(record.decisions, isPinnedEvidenceDecision),
    statefulToolRetained: allMatchingDecisionsRetained(record.decisions, isStatefulToolDecision),
    recallToolResident: routeRecallToolResident(record),
    staleEvidenceInlineBlocks,
  }
}

export function evaluateContextAttentionReplayRecords(
  records: readonly ContextAttentionReplayRecord[]
): ContextAttentionReplayEvaluation {
  const routes = records.map(evaluateRecord)
  const modes = [...new Set(routes.map((route) => route.mode))]
  const originalTokens = routes.reduce((total, route) => total + route.originalTokens, 0)
  const routedTokens = routes.reduce((total, route) => total + route.routedTokens, 0)
  const routesWithFailureEvidence = records.filter((record) =>
    hasMatchingDecision(record.decisions, isFailureEvidenceDecision)
  ).length
  const routesWithLatestUser = records.filter((record) =>
    hasMatchingDecision(record.decisions, isLatestUserCandidate)
  ).length
  const routesWithPinnedEvidence = records.filter((record) =>
    hasMatchingDecision(record.decisions, isPinnedEvidenceDecision)
  ).length
  const routesWithStatefulTools = records.filter((record) =>
    hasMatchingDecision(record.decisions, isStatefulToolDecision)
  ).length
  const routesWithContextRefs = records.filter(
    (record) => (record.requestFingerprint?.contextRefCount ?? 0) > 0
  ).length

  return {
    schemaVersion: 1,
    totalRecords: records.length,
    modes,
    routes,
    totals: {
      originalTokens,
      routedTokens,
      tokenReduction:
        originalTokens <= 0 ? 0 : roundMetric((originalTokens - routedTokens) / originalTokens),
      downgradedBlocks: routes.reduce((total, route) => total + route.downgradedBlocks, 0),
      handleBlocks: routes.reduce((total, route) => total + route.handleBlocks, 0),
      summaryBlocks: routes.reduce((total, route) => total + route.summaryBlocks, 0),
      droppedBlocks: routes.reduce((total, route) => total + route.droppedBlocks, 0),
      fatalViolations: routes.reduce((total, route) => total + route.fatalViolations, 0),
      warnings: routes.reduce((total, route) => total + route.warnings, 0),
      hardRetentionViolations: routes.reduce(
        (total, route) => total + route.hardRetentionViolations,
        0
      ),
      failureEvidenceRetainedRate: safeRate(
        countRoutesWithRetainedMatchingDecisions(records, isFailureEvidenceDecision),
        routesWithFailureEvidence
      ),
      latestUserRetainedRate: safeRate(
        countRoutesWithRetainedMatchingDecisions(records, isLatestUserCandidate),
        routesWithLatestUser
      ),
      pinnedEvidenceRetainedRate: safeRate(
        countRoutesWithRetainedMatchingDecisions(records, isPinnedEvidenceDecision),
        routesWithPinnedEvidence
      ),
      statefulToolRetainedRate: safeRate(
        countRoutesWithRetainedMatchingDecisions(records, isStatefulToolDecision),
        routesWithStatefulTools
      ),
      recallToolResidentRate: safeRate(
        records.filter(
          (record) =>
            (record.requestFingerprint?.contextRefCount ?? 0) > 0 &&
            routeRecallToolResident(record)
        ).length,
        routesWithContextRefs
      ),
      staleEvidenceInlineBlocks: routes.reduce(
        (total, route) => total + route.staleEvidenceInlineBlocks,
        0
      ),
    },
  }
}

function parseJsonlRecord(line: string, filePath: string, lineNumber: number): ContextAttentionReplayRecord {
  try {
    return JSON.parse(line) as ContextAttentionReplayRecord
  } catch (error) {
    throw new Error(
      `Failed to parse context attention replay JSONL at ${filePath}:${lineNumber}: ${String(error)}`
    )
  }
}

export function loadContextAttentionReplayJsonl(
  filePaths: readonly string[]
): ContextAttentionReplayRecord[] {
  const records: ContextAttentionReplayRecord[] = []

  filePaths.forEach((filePath) => {
    const text = readFileSync(filePath, 'utf8')
    text.split(/\r?\n/u).forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed) return
      records.push(parseJsonlRecord(trimmed, filePath, index + 1))
    })
  })

  return records
}
