import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { isEmpty, isNumber } from '@velaros-ai/core'
import {
  readBoolean,
  readNumber,
  readRecord as readUnknownRecord,
  readRecordsArray,
  readString,
  readStringArray,
} from '@velaros-ai/core/utils/unknownJsonRecord'

import {
  type ContextAttentionReplayEvaluation,
  evaluateContextAttentionReplayRecords,
  loadContextAttentionReplayJsonl,
} from './ContextAttentionReplayHarness'
import type {
  ContextAttentionReplayDecisionRecord,
  ContextAttentionReplayRecord,
} from './ContextAttentionReplayRecorder'

export interface ContextAttentionBenchmarkThresholds {
  minTokenReduction: LooseOptional<number>
  maxFatalViolations: LooseOptional<number>
  maxWarnings: LooseOptional<number>
  maxHardRetentionViolations: LooseOptional<number>
  maxStaleEvidenceInlineBlocks: LooseOptional<number>
  minFailureEvidenceRetainedRate: LooseOptional<number>
  minLatestUserRetainedRate: LooseOptional<number>
  minPinnedEvidenceRetainedRate: LooseOptional<number>
  minStatefulToolRetainedRate: LooseOptional<number>
  minRecallToolResidentRate: LooseOptional<number>
}

export interface ContextAttentionBenchmarkExpectations {
  mustRetainBlockIds: string[]
  mustNotDowngradeBlockIds: string[]
  mustHandleBlockIds: string[]
  mustSummarizeBlockIds: string[]
  mustDropBlockIds: string[]
  requireRecallToolResident: boolean
  maxStaleEvidenceInlineBlocks: LooseOptional<number>
}

export interface ContextAttentionBenchmarkCase {
  id: string
  description: LooseOptional<string>
  routeIds: string[]
  inputs: string[]
  thresholds?: ContextAttentionBenchmarkThresholds
  expectations: ContextAttentionBenchmarkExpectations
}

export interface ContextAttentionBenchmarkManifest {
  schemaVersion: 1
  name: string
  inputs: string[]
  thresholds?: ContextAttentionBenchmarkThresholds
  cases: ContextAttentionBenchmarkCase[]
}

export interface LoadedContextAttentionBenchmarkManifest extends ContextAttentionBenchmarkManifest {
  filePath: string
  baseDir: string
  inputPaths: string[]
}

export interface ContextAttentionBenchmarkFailure {
  scope: 'benchmark' | 'case'
  caseId?: string
  routeId?: string
  metric: string
  expected: string
  actual: unknown
  message: string
}

export interface ContextAttentionBenchmarkCaseResult {
  id: string
  routeIds: string[]
  passed: boolean
  evaluation: ContextAttentionReplayEvaluation
  failures: ContextAttentionBenchmarkFailure[]
}

export interface ContextAttentionBenchmarkResult {
  schemaVersion: 1
  name: string
  passed: boolean
  inputFiles: string[]
  totalCases: number
  evaluatedCases: number
  evaluation: ContextAttentionReplayEvaluation
  failures: ContextAttentionBenchmarkFailure[]
  cases: ContextAttentionBenchmarkCaseResult[]
}

function resolveBenchmarkPath(baseDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath)
}

function readThresholds(value: unknown): ContextAttentionBenchmarkThresholds | undefined {
  const record = readUnknownRecord(value)
  if (!record) return undefined

  return {
    minTokenReduction: readNumber(record, 'minTokenReduction'),
    maxFatalViolations: readNumber(record, 'maxFatalViolations'),
    maxWarnings: readNumber(record, 'maxWarnings'),
    maxHardRetentionViolations: readNumber(record, 'maxHardRetentionViolations'),
    maxStaleEvidenceInlineBlocks: readNumber(record, 'maxStaleEvidenceInlineBlocks'),
    minFailureEvidenceRetainedRate: readNumber(record, 'minFailureEvidenceRetainedRate'),
    minLatestUserRetainedRate: readNumber(record, 'minLatestUserRetainedRate'),
    minPinnedEvidenceRetainedRate: readNumber(record, 'minPinnedEvidenceRetainedRate'),
    minStatefulToolRetainedRate: readNumber(record, 'minStatefulToolRetainedRate'),
    minRecallToolResidentRate: readNumber(record, 'minRecallToolResidentRate'),
  }
}

function readExpectations(value: unknown): ContextAttentionBenchmarkExpectations {
  const record = readUnknownRecord(value)

  return {
    mustRetainBlockIds: readStringArray(record, 'mustRetainBlockIds'),
    mustNotDowngradeBlockIds: readStringArray(record, 'mustNotDowngradeBlockIds'),
    mustHandleBlockIds: readStringArray(record, 'mustHandleBlockIds'),
    mustSummarizeBlockIds: readStringArray(record, 'mustSummarizeBlockIds'),
    mustDropBlockIds: readStringArray(record, 'mustDropBlockIds'),
    requireRecallToolResident: !!readBoolean(record, 'requireRecallToolResident'),
    maxStaleEvidenceInlineBlocks: readNumber(record, 'maxStaleEvidenceInlineBlocks'),
  }
}

function readBenchmarkCases(record: Record<string, unknown>): ContextAttentionBenchmarkCase[] {
  return readRecordsArray(record, 'cases').map((caseRecord, index) => {
    const id = readString(caseRecord, 'id') ?? `case-${index + 1}`

    return {
      id,
      description: readString(caseRecord, 'description'),
      routeIds: readStringArray(caseRecord, 'routeIds'),
      inputs: readStringArray(caseRecord, 'inputs'),
      thresholds: readThresholds(caseRecord.thresholds),
      expectations: readExpectations(caseRecord.expectations),
    }
  })
}

export function loadContextAttentionBenchmarkManifest(
  filePath: string
): LoadedContextAttentionBenchmarkManifest {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  const record = readUnknownRecord(raw)
  if (!record) throw new Error(`Context attention benchmark manifest must be a JSON object: ${filePath}`)
  if (record.schemaVersion !== 1) {
    throw new Error(`Unsupported context attention benchmark manifest schemaVersion: ${String(record.schemaVersion)}`)
  }

  const baseDir = dirname(filePath)
  const inputs = readStringArray(record, 'inputs')
  if (isEmpty(inputs)) throw new Error(`Context attention benchmark manifest requires at least one input: ${filePath}`)

  return {
    schemaVersion: 1,
    name: readString(record, 'name') ?? 'context-attention-benchmark',
    inputs,
    thresholds: readThresholds(record.thresholds),
    cases: readBenchmarkCases(record),
    filePath,
    baseDir,
    inputPaths: inputs.map((input) => resolveBenchmarkPath(baseDir, input)),
  }
}

function isInlineResidentAction(action: ContextAttentionReplayDecisionRecord['action']): boolean {
  return action === 'inline' || action === 'retain'
}

function isDowngradedAction(action: ContextAttentionReplayDecisionRecord['action']): boolean {
  return action === 'handle' || action === 'summarize' || action === 'drop' || action === 'skip'
}

function findDecision(
  records: readonly ContextAttentionReplayRecord[],
  blockId: string
): Nullable<ContextAttentionReplayDecisionRecord> {
  for (const record of records) {
    const decision = record.decisions.find((entry) => entry.blockId === blockId)
    if (decision) return decision
  }

  return null
}

function routeIdsForRecords(records: readonly ContextAttentionReplayRecord[]): string[] {
  return records.map((record) => record.routeId)
}

function appendFailure(
  failures: ContextAttentionBenchmarkFailure[],
  input: {
    scope: ContextAttentionBenchmarkFailure['scope']
    caseId?: string
    routeId?: string
    metric: string
    expected: string
    actual: unknown
    message: string
  }
): void {
  failures.push(input)
}

function checkMinimum(input: {
  failures: ContextAttentionBenchmarkFailure[]
    scope: ContextAttentionBenchmarkFailure['scope']
    caseId?: string
    metric: string
    actual: number
    expected: number
}): void {
  if (input.actual >= input.expected) return
  const { failures, ...failure } = input
  appendFailure(failures, {
    ...failure,
    expected: `>= ${input.expected}`,
    message: `${input.metric} expected >= ${input.expected}, actual ${input.actual}`,
  })
}

function checkMaximum(input: {
  failures: ContextAttentionBenchmarkFailure[]
    scope: ContextAttentionBenchmarkFailure['scope']
    caseId?: string
    metric: string
    actual: number
    expected: number
}): void {
  if (input.actual <= input.expected) return
  const { failures, ...failure } = input
  appendFailure(failures, {
    ...failure,
    expected: `<= ${input.expected}`,
    message: `${input.metric} expected <= ${input.expected}, actual ${input.actual}`,
  })
}

function checkThresholds(input: {
  failures: ContextAttentionBenchmarkFailure[]
  scope: ContextAttentionBenchmarkFailure['scope']
  caseId?: string
  thresholds: LooseOptional<ContextAttentionBenchmarkThresholds>
  evaluation: ContextAttentionReplayEvaluation
}): void {
  const thresholds = input.thresholds
  if (!thresholds) return

  const { totals } = input.evaluation
  const base = {
    failures: input.failures,
    scope: input.scope,
    caseId: input.caseId,
  }

  if (isNumber(thresholds.minTokenReduction)) {
    checkMinimum({ ...base, metric: 'minTokenReduction', actual: totals.tokenReduction, expected: thresholds.minTokenReduction })
  }
  if (isNumber(thresholds.maxFatalViolations)) {
    checkMaximum({ ...base, metric: 'maxFatalViolations', actual: totals.fatalViolations, expected: thresholds.maxFatalViolations })
  }
  if (isNumber(thresholds.maxWarnings)) {
    checkMaximum({ ...base, metric: 'maxWarnings', actual: totals.warnings, expected: thresholds.maxWarnings })
  }
  if (isNumber(thresholds.maxHardRetentionViolations)) {
    checkMaximum({ ...base, metric: 'maxHardRetentionViolations', actual: totals.hardRetentionViolations, expected: thresholds.maxHardRetentionViolations })
  }
  if (isNumber(thresholds.maxStaleEvidenceInlineBlocks)) {
    checkMaximum({ ...base, metric: 'maxStaleEvidenceInlineBlocks', actual: totals.staleEvidenceInlineBlocks, expected: thresholds.maxStaleEvidenceInlineBlocks })
  }
  if (isNumber(thresholds.minFailureEvidenceRetainedRate)) {
    checkMinimum({ ...base, metric: 'minFailureEvidenceRetainedRate', actual: totals.failureEvidenceRetainedRate, expected: thresholds.minFailureEvidenceRetainedRate })
  }
  if (isNumber(thresholds.minLatestUserRetainedRate)) {
    checkMinimum({ ...base, metric: 'minLatestUserRetainedRate', actual: totals.latestUserRetainedRate, expected: thresholds.minLatestUserRetainedRate })
  }
  if (isNumber(thresholds.minPinnedEvidenceRetainedRate)) {
    checkMinimum({ ...base, metric: 'minPinnedEvidenceRetainedRate', actual: totals.pinnedEvidenceRetainedRate, expected: thresholds.minPinnedEvidenceRetainedRate })
  }
  if (isNumber(thresholds.minStatefulToolRetainedRate)) {
    checkMinimum({ ...base, metric: 'minStatefulToolRetainedRate', actual: totals.statefulToolRetainedRate, expected: thresholds.minStatefulToolRetainedRate })
  }
  if (isNumber(thresholds.minRecallToolResidentRate)) {
    checkMinimum({ ...base, metric: 'minRecallToolResidentRate', actual: totals.recallToolResidentRate, expected: thresholds.minRecallToolResidentRate })
  }
}

function checkBlockActionExpectation(input: {
  failures: ContextAttentionBenchmarkFailure[]
  caseId: string
  records: readonly ContextAttentionReplayRecord[]
  blockIds: readonly string[]
  metric: string
  expected: string
  predicate: (decision: ContextAttentionReplayDecisionRecord) => boolean
}): void {
  input.blockIds.forEach((blockId) => {
    const decision = findDecision(input.records, blockId)
    if (decision && input.predicate(decision)) return

    appendFailure(input.failures, {
      scope: 'case',
      caseId: input.caseId,
      metric: input.metric,
      expected: input.expected,
      actual: decision?.action ?? 'missing',
      message: `${input.caseId}: block ${blockId} expected ${input.expected}, actual ${decision?.action ?? 'missing'}`,
    })
  })
}

function checkCaseExpectations(input: {
  failures: ContextAttentionBenchmarkFailure[]
  benchmarkCase: ContextAttentionBenchmarkCase
  records: readonly ContextAttentionReplayRecord[]
  evaluation: ContextAttentionReplayEvaluation
}): void {
  const { expectations } = input.benchmarkCase
  checkBlockActionExpectation({
    failures: input.failures,
    caseId: input.benchmarkCase.id,
    records: input.records,
    blockIds: expectations.mustRetainBlockIds,
    metric: 'mustRetainBlockIds',
    expected: 'retain or inline',
    predicate: (decision) => isInlineResidentAction(decision.action),
  })
  checkBlockActionExpectation({
    failures: input.failures,
    caseId: input.benchmarkCase.id,
    records: input.records,
    blockIds: expectations.mustNotDowngradeBlockIds,
    metric: 'mustNotDowngradeBlockIds',
    expected: 'not downgraded',
    predicate: (decision) => !isDowngradedAction(decision.action),
  })
  checkBlockActionExpectation({
    failures: input.failures,
    caseId: input.benchmarkCase.id,
    records: input.records,
    blockIds: expectations.mustHandleBlockIds,
    metric: 'mustHandleBlockIds',
    expected: 'handle',
    predicate: (decision) => decision.action === 'handle',
  })
  checkBlockActionExpectation({
    failures: input.failures,
    caseId: input.benchmarkCase.id,
    records: input.records,
    blockIds: expectations.mustSummarizeBlockIds,
    metric: 'mustSummarizeBlockIds',
    expected: 'summarize',
    predicate: (decision) => decision.action === 'summarize',
  })
  checkBlockActionExpectation({
    failures: input.failures,
    caseId: input.benchmarkCase.id,
    records: input.records,
    blockIds: expectations.mustDropBlockIds,
    metric: 'mustDropBlockIds',
    expected: 'drop',
    predicate: (decision) => decision.action === 'drop',
  })

  if (expectations.requireRecallToolResident && input.evaluation.totals.recallToolResidentRate < 1) {
    appendFailure(input.failures, {
      scope: 'case',
      caseId: input.benchmarkCase.id,
      metric: 'requireRecallToolResident',
      expected: 'all selected routes with context refs expose recall_context',
      actual: input.evaluation.totals.recallToolResidentRate,
      message: `${input.benchmarkCase.id}: recall_context must be resident for all selected context refs`,
    })
  }
  if (isNumber(expectations.maxStaleEvidenceInlineBlocks)) {
    checkMaximum({
      failures: input.failures,
      scope: 'case',
      caseId: input.benchmarkCase.id,
      metric: 'maxStaleEvidenceInlineBlocks',
      actual: input.evaluation.totals.staleEvidenceInlineBlocks,
      expected: expectations.maxStaleEvidenceInlineBlocks,
    })
  }
}

function selectCaseRecords(
  records: readonly ContextAttentionReplayRecord[],
  benchmarkCase: ContextAttentionBenchmarkCase,
  failures: ContextAttentionBenchmarkFailure[]
): ContextAttentionReplayRecord[] {
  if (isEmpty(benchmarkCase.routeIds)) return [...records]

  const selected = records.filter((record) => benchmarkCase.routeIds.includes(record.routeId))
  benchmarkCase.routeIds.forEach((routeId) => {
    if (selected.some((record) => record.routeId === routeId)) return
    appendFailure(failures, {
      scope: 'case',
      caseId: benchmarkCase.id,
      routeId,
      metric: 'routeIds',
      expected: 'route exists in loaded replay inputs',
      actual: 'missing',
      message: `${benchmarkCase.id}: route ${routeId} was not found in loaded replay inputs`,
    })
  })

  return selected
}

function loadBenchmarkRecords(manifest: ContextAttentionBenchmarkManifest): ContextAttentionReplayRecord[] {
  const loaded = manifest as Partial<LoadedContextAttentionBenchmarkManifest>
  const baseDir = loaded.baseDir ?? process.cwd()
  const inputPaths = loaded.inputPaths ?? manifest.inputs.map((input) => resolveBenchmarkPath(baseDir, input))
  return loadContextAttentionReplayJsonl(inputPaths)
}

export function evaluateContextAttentionReplayBenchmark(
  manifest: ContextAttentionBenchmarkManifest
): ContextAttentionBenchmarkResult {
  const records = loadBenchmarkRecords(manifest)
  const evaluation = evaluateContextAttentionReplayRecords(records)
  const failures: ContextAttentionBenchmarkFailure[] = []
  const caseResults: ContextAttentionBenchmarkCaseResult[] = []

  checkThresholds({
    failures,
    scope: 'benchmark',
    thresholds: manifest.thresholds,
    evaluation,
  })

  manifest.cases.forEach((benchmarkCase) => {
    const caseFailures: ContextAttentionBenchmarkFailure[] = []
    const selectedRecords = selectCaseRecords(records, benchmarkCase, caseFailures)
    const caseEvaluation = evaluateContextAttentionReplayRecords(selectedRecords)
    checkThresholds({
      failures: caseFailures,
      scope: 'case',
      caseId: benchmarkCase.id,
      thresholds: benchmarkCase.thresholds,
      evaluation: caseEvaluation,
    })
    checkCaseExpectations({
      failures: caseFailures,
      benchmarkCase,
      records: selectedRecords,
      evaluation: caseEvaluation,
    })
    failures.push(...caseFailures)
    caseResults.push({
      id: benchmarkCase.id,
      routeIds: !isEmpty(benchmarkCase.routeIds) ? benchmarkCase.routeIds : routeIdsForRecords(selectedRecords),
      passed: isEmpty(caseFailures),
      evaluation: caseEvaluation,
      failures: caseFailures,
    })
  })

  return {
    schemaVersion: 1,
    name: manifest.name,
    passed: isEmpty(failures),
    inputFiles:
      (manifest as Partial<LoadedContextAttentionBenchmarkManifest>).inputPaths ??
      manifest.inputs,
    totalCases: manifest.cases.length,
    evaluatedCases: caseResults.length,
    evaluation,
    failures,
    cases: caseResults,
  }
}
