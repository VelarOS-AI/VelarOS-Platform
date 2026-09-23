/**
 * 真实任务覆盖：加权统计、归档结局折算，以及工具输入效率。
 * 缺证据一律留成缺口，不折成通过。纯测量：不碰 Node 模块、不发请求。
 */
import type { RealTaskCoverageOutcome } from '../../contract/constants.js'
import type {
  RealTaskCase,
  RealTaskCoverageResult,
  RealTaskSurfaceCoverageSummary,
  RunArchive,
  RunArchiveOutcome,
  ToolAttemptReceiptRecord,
  ToolInputEfficiency,
} from '../../types/agent-lab.js'

/** 工具尝试回执的工具名：只有它才带输入效率的度量。 */
const ToolAttemptOutcomeName = '__tool_attempt_outcome__'

/** 回执里允许出现的三种结局。 */
const ToolAttemptOutcomes = new Set(['completed', 'not-applied', 'unknown'])

/** 分母是 0 时给 0，不给 NaN。 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * 按产品面汇总加权覆盖。重复结果与指向未知用例的结果一律报错：
 * 这两种情况都会悄悄改掉对外声称覆盖率的分母。
 */
export function summarizeRealTaskCoverage(
  cases: readonly RealTaskCase[],
  results: readonly RealTaskCoverageResult[]
): readonly RealTaskSurfaceCoverageSummary[] {
  const byId = new Map(cases.map((taskCase) => [taskCase.id, taskCase]))
  if (byId.size !== cases.length) throw new Error('真实任务用例的 id 必须唯一')

  const outcomes = new Map<string, RealTaskCoverageOutcome>()
  for (const result of results) {
    if (!byId.has(result.caseId)) throw new Error(`覆盖结果指向了不存在的用例: ${result.caseId}`)
    if (outcomes.has(result.caseId))
      throw new Error(`同一个用例出现了两份覆盖结果: ${result.caseId}`)
    outcomes.set(result.caseId, result.outcome)
  }

  const surfaces = new Map<string, RealTaskCase[]>()
  for (const taskCase of cases) {
    const entries = surfaces.get(taskCase.surface) ?? []
    entries.push(taskCase)
    surfaces.set(taskCase.surface, entries)
  }

  return [...surfaces.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([surface, surfaceCases]) => {
      let passed = 0
      let failed = 0
      let voided = 0
      let notRun = 0
      let plannedWeight = 0
      let executedWeight = 0
      let passedWeight = 0

      for (const taskCase of surfaceCases) {
        const weight = taskCase.coverage.dailyWeight
        const outcome = outcomes.get(taskCase.id) ?? 'not-run'
        plannedWeight += weight
        if (outcome === 'pass') {
          passed += 1
          executedWeight += weight
          passedWeight += weight
        } else if (outcome === 'fail') {
          failed += 1
          executedWeight += weight
        } else if (outcome === 'void') voided += 1
        else notRun += 1
      }

      return {
        surface,
        cases: surfaceCases.length,
        passed,
        failed,
        voided,
        notRun,
        plannedWeight,
        executedWeight,
        passedWeight,
        verifiedCoverage: ratio(passedWeight, plannedWeight),
        conclusivePassRate: executedWeight === 0 ? null : ratio(passedWeight, executedWeight),
      }
    })
}

/**
 * 把一份不可变归档折成真实任务覆盖认的那一种结局。
 * 宿主不许自己重新解释验证器失败或丢弃，否则两边的分母就对不上了。
 */
export function classifyRunArchiveOutcome(archive: RunArchive): RunArchiveOutcome {
  if (archive.drops.length > 0)
    return {
      outcome: 'void',
      detail: archive.drops.map((drop) => `${drop.cause}: ${drop.detail}`).join('; '),
    }

  const failedCriteria = archive.legs.flatMap((leg) =>
    leg.criteria.flatMap((criterion) =>
      criterion.outcome.kind === 'fail'
        ? [`${criterion.criterionId}: ${criterion.outcome.reason}`]
        : []
    )
  )
  if (failedCriteria.length > 0 || archive.legs.some((leg) => leg.passed === false))
    return { outcome: 'fail', detail: failedCriteria.join('; ') || archive.manifest.exitReason }

  if (archive.legs.length > 0 && archive.legs.every((leg) => leg.passed === true))
    return { outcome: 'pass', detail: '执行门与外部真相门全部通过' }

  return { outcome: 'void', detail: archive.manifest.exitReason }
}

/** 消费实际执行回执，计算模型重复输入减少量；字符数不是 token 估算，内部尝试仍计入分母。 */
export function summarizeToolInputEfficiency(
  records: readonly ToolAttemptReceiptRecord[]
): ToolInputEfficiency {
  let attempts = 0
  let completed = 0
  let notApplied = 0
  let unknown = 0
  let reusedAttempts = 0
  let completedReusedAttempts = 0
  let requestedChars = 0
  let effectiveChars = 0
  let avoidedRepeatChars = 0
  let corruptReceipts = 0
  const seen = new Set<string>()
  for (const record of records) {
    const identity = JSON.stringify([record.sessionId, record.toolCallId])
    if (record.toolName !== ToolAttemptOutcomeName || seen.has(identity)) continue
    seen.add(identity)
    try {
      const value = JSON.parse(record.serializedResult)
      if (value?.kind !== 'tool-attempt-outcome' || !ToolAttemptOutcomes.has(value.outcome)) {
        throw new Error('回执信封不合法')
      }
      const metrics = value.metrics
      if (
        metrics &&
        (!Number.isSafeInteger(metrics.requestedChars) ||
          metrics.requestedChars < 0 ||
          !Number.isSafeInteger(metrics.effectiveChars) ||
          metrics.effectiveChars < 0 ||
          typeof metrics.reused !== 'boolean')
      ) {
        throw new Error('回执里的度量不合法')
      }
      attempts += 1
      if (value.outcome === 'completed') completed += 1
      else if (value.outcome === 'not-applied') notApplied += 1
      else unknown += 1
      if (!metrics) continue
      requestedChars += metrics.requestedChars
      effectiveChars += metrics.effectiveChars
      if (metrics.reused) {
        reusedAttempts += 1
        if (value.outcome === 'completed') completedReusedAttempts += 1
        avoidedRepeatChars += Math.max(0, metrics.effectiveChars - metrics.requestedChars)
      }
    } catch {
      corruptReceipts += 1
    }
  }
  return {
    attempts,
    completed,
    notApplied,
    unknown,
    reusedAttempts,
    completedReusedAttempts,
    requestedChars,
    effectiveChars,
    avoidedRepeatChars,
    corruptReceipts,
  }
}
