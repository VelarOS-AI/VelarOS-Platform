/**
 * 认证判定：按策略一项一项核对，判不了的一律记 `unknown`，不拿「没有证据」当通过。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import type { CertificationCheckStatus, CertificationStatus, ObservationCoverage, ObservationFace } from '../../contract/constants.js'
import type {
  CertificationCheck,
  RunArchive,
} from '../../types/agent-lab.js'
import type { CertificationInput } from '../../types/options.js'

import { checkComparability, compareExecutors, estimateReliability } from './statistics.js'

/** 造一项检查结论。 */
function check(
  id: string,
  status: CertificationCheckStatus,
  summary: string,
  evidence: CertificationCheck['evidence'] = {},
): CertificationCheck {
  return { id, status, summary, evidence }
}

/** 观测覆盖度的高低次序：full > partial > none。 */
function coverageRank(value: ObservationCoverage): number {
  if (value === 'full') return 2
  if (value === 'partial') return 1
  return 0
}

/** 每条必跑旅程的重复次数与单次可靠性下界。 */
export function journeyChecks(
  policy: CertificationInput['policy'],
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const checks: CertificationCheck[] = []
  for (const journeyId of policy.requiredJourneyIds) {
    const runs = archives.filter((archive) => archive.journey.id === journeyId)
    if (runs.length < policy.minimumReplicatesPerJourney) {
      checks.push(
        check(`journey:${journeyId}:replicates`, 'unknown', `旅程 ${journeyId} 的重复试验不足`, {
          observed: runs.length,
          required: policy.minimumReplicatesPerJourney,
        }),
      )
      continue
    }
    const reliability = estimateReliability(runs)
    const lower = reliability.lower95
    checks.push(
      check(
        `journey:${journeyId}:reliability`,
        lower === null ? 'unknown' : lower >= policy.minimumReliability ? 'pass' : 'fail',
        `旅程 ${journeyId} 的单次可靠性下界`,
        {
          estimate: reliability.estimate,
          lower95: lower,
          required: policy.minimumReliability,
          attempts: reliability.attempts,
          dropped: reliability.dropped,
        },
      ),
    )
  }
  return checks
}

/** 策略要求的每个观测面够不够；不够只能是 `unknown`，不是失败也不是通过。 */
export function coverageChecks(
  policy: CertificationInput['policy'],
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const checks: CertificationCheck[] = []
  for (const [face, required] of Object.entries(policy.requiredObservationCoverage)) {
    if (!required) continue
    const missing = archives.filter(
      (archive) =>
        coverageRank(archive.manifest.capabilities.observes[face as ObservationFace]) < coverageRank(required),
    )
    checks.push(
      check(
        `coverage:${face}`,
        missing.length === 0 ? 'pass' : 'unknown',
        missing.length === 0 ? `观测面 ${face} 满足要求` : `观测面 ${face} 不足，不能据此判健康`,
        { insufficientRuns: missing.length, totalRuns: archives.length },
      ),
    )
  }
  return checks
}

/** 完整性三项：验证器完整性、验证器隔离、是否保留执行体原生行为。 */
export function integrityChecks(
  policy: CertificationInput['policy'],
  archives: readonly RunArchive[],
): readonly CertificationCheck[] {
  const integrityFailures = archives.reduce(
    (count, archive) =>
      count +
      archive.findings.filter((finding) => finding.failureClass === 'integrity' && finding.severity === 'fail').length,
    0,
  )
  const sharedVerifiers = archives.filter(
    (archive) => archive.manifest.capabilities.verifierIsolation !== 'separate',
  ).length
  const nonNative = archives.filter((archive) => !archive.manifest.capabilities.preservesNativeExecution).length
  return [
    check(
      'integrity-findings',
      integrityFailures === 0 ? 'pass' : 'fail',
      integrityFailures === 0 ? '未发现验证器完整性失败' : '发现验证器完整性失败',
      { failures: integrityFailures },
    ),
    check(
      'verifier-isolation',
      !policy.requireSeparateVerifier ? 'pass' : sharedVerifiers === 0 ? 'pass' : 'unknown',
      sharedVerifiers === 0 ? '验证器与被测执行环境隔离' : '验证器隔离能力不足',
      { insufficientRuns: sharedVerifiers },
    ),
    check(
      'native-execution',
      !policy.requireNativeExecution ? 'pass' : nonNative === 0 ? 'pass' : 'fail',
      nonNative === 0 ? '保留执行体原生行为' : '部分运行没有保留执行体原生行为',
      { nonNativeRuns: nonNative },
    ),
  ]
}

/** 环境与基础设施丢弃率有没有超过策略允许的上限。 */
export function attritionCheck(
  policy: CertificationInput['policy'],
  archives: readonly RunArchive[],
): CertificationCheck {
  if (archives.length === 0) return check('attrition', 'unknown', '没有可用运行')
  const dropped = archives.filter((archive) => archive.drops.length > 0).length
  const rate = dropped / archives.length
  return check('attrition', rate <= policy.maximumAttritionRate ? 'pass' : 'fail', '环境与基础设施丢弃率', {
    rate,
    maximum: policy.maximumAttritionRate,
    dropped,
    total: archives.length,
  })
}

/** 相对基线的完成度回归下界；缺基线、不可比、样本簇不够时都只能是 `unknown`。 */
export function baselineCheck(input: CertificationInput): CertificationCheck {
  const baseline = input.baselineArchives ?? []
  if (!input.policy.requireBaseline && baseline.length === 0) return check('baseline', 'pass', '本策略不要求基线对照')
  if (baseline.length === 0 || !input.baselineExecutorId) return check('baseline', 'unknown', '缺少成对基线，不能判断增益或回归')
  const all = [...input.archives, ...baseline]
  const comparable = checkComparability(all)
  if (!comparable.comparable) return check('baseline', 'unknown', `基线不可比: ${comparable.reasons.join('; ')}`)
  const comparison = compareExecutors(all, input.subjectExecutorId, input.baselineExecutorId, {
    minimumEffect: input.policy.maximumBaselineRegression,
  })
  if (comparison.completionDifference.lower95 === null) return check('baseline', 'unknown', '成对样本簇不足，不能给出区间判断', {
      pairs: comparison.matchedPairs,
      clusters: comparison.clusters,
    })
  const lower = comparison.completionDifference.lower95
  return check(
    'baseline',
    lower >= -input.policy.maximumBaselineRegression ? 'pass' : 'fail',
    '相对基线的完成度回归下界',
    {
      estimate: comparison.completionDifference.estimate,
      lower95: lower,
      maximumRegression: input.policy.maximumBaselineRegression,
      pairs: comparison.matchedPairs,
      clusters: comparison.clusters,
    },
  )
}

/** 全部检查合成一个结论：有 fail 就是 `rejected`，有 unknown 就是 `inconclusive`，都过才是 `certified`。 */
export function certificationStatus(checks: readonly CertificationCheck[]): CertificationStatus {
  if (checks.some((item) => item.status === 'fail')) return 'rejected'
  if (checks.some((item) => item.status === 'unknown')) return 'inconclusive'
  return 'certified'
}
