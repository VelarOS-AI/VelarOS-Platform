/**
 * 统计：Wilson 区间、完成度、可比性核对与簇 bootstrap 的成对比较。
 * 纯测量：不碰 Node 模块、不发请求；随机数用固定种子，同样的输入给同样的区间。
 */
import type { ComparisonDecision, FailureClass } from '../../contract/constants.js'
import type {
  ComparabilityResult,
  FailureDistribution,
  IntervalEstimate,
  PairedComparison,
  PairedComparisonOptions,
  ReliabilityEstimate,
  RunArchive,
} from '../../types/agent-lab.js'
import type { CompletionPair, MatchedCompletionPairs } from '../../types/internal.js'
import { canonicalJson } from '../canonical-json.js'
import { AgentLabTuning } from '../tuning.js'

/** 一份归档的完成度：按段权重加权的得分；有丢弃时没有完成度（`null`），不按 0 算。 */
export function archiveCompletion(archive: RunArchive): number | null {
  if (archive.drops.length > 0) return null
  let weighted = 0
  let weight = 0
  for (const leg of archive.legs) {
    if (leg.score === null) continue
    const definition = archive.journey.legs.find((item) => item.id === leg.legId)
    if (!definition) continue
    weighted += leg.score * definition.weight
    weight += definition.weight
  }
  return weight > 0 ? weighted / weight : null
}

/** 比例的 Wilson 95% 区间；一次尝试都没有时三项都是 `null`。 */
export function wilsonInterval(successes: number, attempts: number): IntervalEstimate {
  if (attempts <= 0) return { estimate: null, lower95: null, upper95: null, observations: 0 }
  // 标准正态分布 95% 双侧分位数：算法里的常数，写死比每次算快也更稳。
  const z = 1.959963984540054
  const proportion = successes / attempts
  const denominator = 1 + (z * z) / attempts
  const center = (proportion + (z * z) / (2 * attempts)) / denominator
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion)) / attempts + (z * z) / (4 * attempts * attempts))
  return {
    estimate: proportion,
    lower95: Math.max(0, center - margin),
    upper95: Math.min(1, center + margin),
    observations: attempts,
  }
}

/** 单次可靠性：完成度满分才算成功，被丢弃的既不进分子也不进分母，只单列。 */
export function estimateReliability(archives: readonly RunArchive[]): ReliabilityEstimate {
  const values = archives.map((archive) => archiveCompletion(archive))
  const attempts = values.filter((value) => value !== null).length
  const successes = values.filter((value) => value === 1).length
  return {
    ...wilsonInterval(successes, attempts),
    successes,
    attempts,
    dropped: values.length - attempts,
  }
}

/** 失败形态分布：`unclassified` 单独数，不并进其它类。 */
export function failureDistribution(archives: readonly RunArchive[]): FailureDistribution {
  const byClass: Partial<Record<FailureClass, number>> = {}
  let classified = 0
  let unclassified = 0
  const record = (failureClass: FailureClass): void => {
    if (failureClass === 'unclassified') unclassified += 1
    else classified += 1
    byClass[failureClass] = (byClass[failureClass] ?? 0) + 1
  }
  for (const archive of archives) {
    for (const finding of archive.findings) record(finding.failureClass)
    for (const leg of archive.legs) {
      for (const criterion of leg.criteria) {
        if (criterion.outcome.kind === 'fail') record(criterion.outcome.failureClass)
      }
    }
  }
  return { classified, unclassified, byClass }
}

/** 核对几份归档能不能放在一起比：任务、探测器集合、评测策略、预算与调用方提交号都得一样。 */
export function checkComparability(archives: readonly RunArchive[]): ComparabilityResult {
  if (archives.length < 2) return { comparable: false, reasons: ['至少要有两次运行才谈得上比较'] }
  const reasons = new Set<string>()
  const groups = new Map<string, RunArchive[]>()
  for (const archive of archives) {
    const key = `${archive.journey.id}@${archive.journey.version}:${archive.manifest.trial.arm ?? 'default'}`
    const group = groups.get(key) ?? []
    group.push(archive)
    groups.set(key, group)
    if (archive.manifest.capabilities.preservesNativeExecution !== true) {
      reasons.add(`${archive.manifest.executor.executorId}: 没有保留执行体原生行为`)
    }
  }
  for (const group of groups.values()) {
    const reference = group[0]
    for (const archive of group.slice(1)) {
      if (archive.manifest.harness.taskDigest !== reference.manifest.harness.taskDigest) {
        reasons.add(`${reference.journey.id}: 任务摘要不同`)
      }
      if (archive.manifest.harness.detectorDigest !== reference.manifest.harness.detectorDigest) {
        reasons.add(`${reference.journey.id}: 探测器集合不同`)
      }
      if (archive.manifest.harness.policyDigest !== reference.manifest.harness.policyDigest) {
        reasons.add(`${reference.journey.id}: 评测策略不同`)
      }
      if (canonicalJson(archive.manifest.budget) !== canonicalJson(reference.manifest.budget)) {
        reasons.add(`${reference.journey.id}: 预算不同`)
      }
      if (archive.manifest.harness.consumerCommit !== reference.manifest.harness.consumerCommit) {
        reasons.add(`${reference.journey.id}: 调用方源码提交不同`)
      }
    }
  }
  return { comparable: reasons.size === 0, reasons: [...reasons].sort() }
}

/** 一个带种子的伪随机数发生器（mulberry32）：同一个种子给同一串数，bootstrap 因此可复现。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** 取一个已排序数组的分位数，落在两点之间时线性插值。 */
function percentile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const fraction = position - lower
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction
}

/** 算术平均。 */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 配对钥匙：同一条旅程、同一组、同一次重复、同一个种子的两次运行才配成一对。 */
function pairedKey(archive: RunArchive): string {
  const replicate = archive.manifest.trial.replicate
  return `${archive.journey.id}@${archive.journey.version}:${replicate.groupId}:${replicate.index}:${replicate.seed}`
}

/** 簇钥匙：同一条旅程加同一个实验臂算一簇，bootstrap 按簇重抽。 */
function clusterKey(archive: RunArchive): string {
  return `${archive.journey.id}@${archive.journey.version}:${archive.manifest.trial.arm ?? 'default'}`
}

/** 把两组归档按配对钥匙配成对；任一边没有完成度就整对丢掉，并记下是哪一边缺。 */
export function matchCompletionPairs(
  archivesA: readonly RunArchive[],
  archivesB: readonly RunArchive[]
): MatchedCompletionPairs {
  const a = new Map(archivesA.map((archive) => [pairedKey(archive), archive]))
  const b = new Map(archivesB.map((archive) => [pairedKey(archive), archive]))
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  const pairs: CompletionPair[] = []
  let droppedA = 0
  let droppedB = 0
  let droppedEither = 0
  for (const key of keys) {
    const archiveA = a.get(key)
    const archiveB = b.get(key)
    const valueA = archiveA ? archiveCompletion(archiveA) : null
    const valueB = archiveB ? archiveCompletion(archiveB) : null
    if (valueA === null) droppedA += 1
    if (valueB === null) droppedB += 1
    if (valueA === null || valueB === null || !archiveA || !archiveB) {
      droppedEither += 1
      continue
    }
    pairs.push({ cluster: clusterKey(archiveA), a: valueA, b: valueB })
  }
  return { pairs, droppedA, droppedB, droppedEither }
}

/** 按簇重抽算完成度差的 95% 区间；只有一个簇时只给点估计，不编一个区间出来。 */
function clusterBootstrap(
  pairs: readonly CompletionPair[],
  samples: number,
  seed: number
): IntervalEstimate {
  if (pairs.length === 0) return { estimate: null, lower95: null, upper95: null, observations: 0 }
  const byCluster = new Map<string, CompletionPair[]>()
  for (const pair of pairs) {
    const cluster = byCluster.get(pair.cluster) ?? []
    cluster.push(pair)
    byCluster.set(pair.cluster, cluster)
  }
  const clusters = [...byCluster.values()]
  const estimate = mean(pairs.map((pair) => pair.a - pair.b))
  if (clusters.length < 2)
    return { estimate, lower95: null, upper95: null, observations: pairs.length }
  const random = seededRandom(seed)
  const distribution: number[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    const selected: CompletionPair[] = []
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...clusters[Math.floor(random() * clusters.length)])
    }
    distribution.push(mean(selected.map((pair) => pair.a - pair.b)))
  }
  distribution.sort((left, right) => left - right)
  return {
    estimate,
    // 2.5% 与 97.5% 分位就是 95% 区间的两端。
    lower95: percentile(distribution, 0.025),
    upper95: percentile(distribution, 0.975),
    observations: pairs.length,
  }
}

/**
 * 两个执行体的成对比较：先核对能不能比，再按配对钥匙配对、按簇 bootstrap 给完成度差的区间。
 * 不可比时结论一律是 `not-comparable`，不硬给一个方向。
 */
export function compareExecutors(
  archives: readonly RunArchive[],
  executorA: string,
  executorB: string,
  options: PairedComparisonOptions
): PairedComparison {
  const archivesA = archives.filter((archive) => archive.manifest.executor.executorId === executorA)
  const archivesB = archives.filter((archive) => archive.manifest.executor.executorId === executorB)
  const comparability = checkComparability([...archivesA, ...archivesB])
  const matched = matchCompletionPairs(archivesA, archivesB)
  const minimumEffect = options.minimumEffect ?? 0
  const completionDifference = clusterBootstrap(
    matched.pairs,
    options.bootstrapSamples ?? AgentLabTuning.statistics.bootstrapSamples,
    options.seed ?? 1
  )
  let decision: ComparisonDecision = 'inconclusive'
  if (!comparability.comparable) decision = 'not-comparable'
  else if (completionDifference.lower95 !== null && completionDifference.lower95 > minimumEffect)
    decision = 'a-better'
  else if (completionDifference.upper95 !== null && completionDifference.upper95 < -minimumEffect)
    decision = 'b-better'
  return {
    executorA,
    executorB,
    completionDifference,
    decision,
    minimumEffect,
    matchedPairs: matched.pairs.length,
    clusters: new Set(matched.pairs.map((pair) => pair.cluster)).size,
    attrition: { a: matched.droppedA, b: matched.droppedB, either: matched.droppedEither },
    failureA: failureDistribution(archivesA),
    failureB: failureDistribution(archivesB),
    comparability,
  }
}
