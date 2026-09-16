/**
 * 跑一条旅程时用得到的纯计算：结局折算、判据打分、用量与产物合并、矩阵试验展开。
 * 这里不认驱动、不写盘，只把数据折成数据。
 */
import type { ObservationCoverage, ObservationFace } from '../contract/constants.js'
import { ObservationFaces } from '../contract/constants.js'
import type {
  ArtifactReference,
  ContextResidencyEvent,
  CriterionResult,
  DriverCapabilities,
  DropRecord,
  ExecutorIdentity,
  JobSpec,
  LegResult,
  LegSpec,
  MatrixJobInput,
  RunArchiveContext,
  SettleOutcome,
  TrialSpec,
  UsageAccount,
  VerificationOutcome,
} from '../types/agent-lab.js'
import type { LegScore, VerifyLegInput } from '../types/internal.js'

/** 一次收敛结局折成共享的验证结局；正常收敛与等待输入不折，交给验证器自己判。 */
export function settleOutcomeToVerification(outcome: SettleOutcome): VerificationOutcome | null {
  if (outcome.kind === 'settled' || outcome.kind === 'awaiting-input') return null
  if (outcome.kind === 'unavailable') return { kind: 'void', cause: outcome.cause, detail: outcome.detail, evidence: {} }
  if (outcome.kind === 'timeout') return { kind: 'fail', credit: 0, failureClass: 'timeout', reason: '执行体没有在时限内收敛', evidence: {} }
  if (outcome.kind === 'budget-exhausted') return {
      kind: 'fail',
      credit: 0,
      failureClass: 'budget-exhausted',
      reason: `预算耗尽: ${outcome.limit}`,
      evidence: { limit: outcome.limit },
    }
  return {
    kind: 'fail',
    credit: 0,
    failureClass: 'loop',
    reason: outcome.reason,
    evidence: { detectorId: outcome.detectorId },
  }
}

/** 按权重给一段打分：判不了（`void`）的判据不进分母；门判据没通过就整段不通过，门判不了整段就是未知。 */
export function scoreCriteria(leg: LegSpec, criteria: readonly CriterionResult[]): LegScore {
  let weightedCredit = 0
  let weight = 0
  let hasVoidGate = false
  let gateFailed = false
  for (const result of criteria) {
    const criterion = leg.criteria.find((item) => item.id === result.criterionId)
    if (!criterion) continue
    if (result.outcome.kind === 'void') {
      if (criterion.gate) hasVoidGate = true
      continue
    }
    weightedCredit += result.outcome.credit * criterion.weight
    weight += criterion.weight
    if (criterion.gate && result.outcome.kind !== 'pass') gateFailed = true
  }
  return { score: weight > 0 ? weightedCredit / weight : null, passed: hasVoidGate ? null : !gateFailed }
}

/** 取整程的 token 与费用账：以最后一次观测到的为准，没观测到就是未知。 */
export function mergeLegUsage(legs: readonly LegResult[]): UsageAccount | null {
  const observed = legs.map((leg) => leg.observation.usage).filter((usage) => usage !== null)
  if (observed.length === 0) return null
  return { ...observed[observed.length - 1] }
}

/** 合并整程的上下文账；一段都没观测到上下文驻留时是未知（不是空账）。 */
export function contextAccount(legs: readonly LegResult[]): RunArchiveContext | null {
  const observations = legs.map((leg) => leg.observation)
  const hasContext = observations.some((observation) => observation.coverage['context-residency'] !== 'none')
  if (!hasContext) return null
  const events = new Map<string, ContextResidencyEvent>()
  let peakTokens: number | null = null
  let windowLimit: number | null = null
  for (const observation of observations) {
    for (const event of observation.contextResidency) events.set(event.id, event)
    const tokens = observation.runtime?.contextTokens ?? null
    if (tokens !== null) peakTokens = Math.max(peakTokens ?? 0, tokens)
    const window = observation.runtime?.contextWindow ?? null
    if (window !== null) windowLimit = window
  }
  return {
    peakTokens,
    windowLimit,
    epochs: [...events.values()].sort((left, right) => left.epoch - right.epoch || left.id.localeCompare(right.id)),
  }
}

/** 合并整程的产物引用，按 id 去重并排序。 */
export function collectArtifacts(legs: readonly LegResult[]): readonly ArtifactReference[] {
  const artifacts = new Map<string, ArtifactReference>()
  for (const leg of legs) {
    for (const artifact of leg.observation.artifacts) artifacts.set(artifact.id, artifact)
  }
  return [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id))
}

/** 把判不了的判据折成丢弃记录，同一个原因加说明只记一条。 */
export function dropRecords(
  trialId: string,
  legId: string,
  criteria: readonly CriterionResult[],
): readonly DropRecord[] {
  const unique = new Map<string, DropRecord>()
  for (const criterion of criteria) {
    if (criterion.outcome.kind !== 'void') continue
    const record: DropRecord = {
      trialId,
      legId,
      cause: criterion.outcome.cause,
      detail: criterion.outcome.detail,
    }
    unique.set(`${record.cause}|${record.detail}`, record)
  }
  return [...unique.values()]
}

/** 判完一段的每一条判据；驱动那边已经给出非收敛结局时，整段共用那个结局，不再去叫验证器。 */
export async function verifyLeg(input: VerifyLegInput): Promise<readonly CriterionResult[]> {
  const continued = input.settleOutcome.kind !== 'settled' && input.leg.continueOn.includes(input.settleOutcome.kind)
  const sharedOutcome = continued ? null : settleOutcomeToVerification(input.settleOutcome)
  const results: CriterionResult[] = []
  for (const criterion of input.leg.criteria) {
    const startedAt = input.now()
    let outcome: VerificationOutcome
    if (sharedOutcome) outcome = sharedOutcome
    else {
      const verifier = input.verifiers.get(criterion.verifierId)
      if (!verifier) {
        outcome = {
          kind: 'void',
          cause: 'verifier-unavailable',
          detail: `没有注册这个验证器: ${criterion.verifierId}`,
          evidence: {},
        }
      } else {
        try {
          outcome = await verifier({
            trial: input.trial,
            journey: input.journey,
            leg: input.leg,
            criterion,
            session: input.session,
            observation: input.observation,
            workspaceRoot:
              typeof input.session.metadata.workspaceRoot === 'string'
                ? input.session.metadata.workspaceRoot
                : input.workspaceRoot,
          })
        } catch (error) {
          outcome = {
            kind: 'fail',
            credit: 0,
            failureClass: 'verifier-failure',
            reason: error instanceof Error ? error.message : String(error),
            evidence: {},
          }
        }
      }
    }
    results.push({
      criterionId: criterion.id,
      verifierId: criterion.verifierId,
      outcome,
      durationMs: Math.max(0, input.now() - startedAt),
    })
  }
  return results
}

/** 驱动连能力都报不出来时用的「什么都看不到」能力表。 */
export function unavailableCapabilities(): DriverCapabilities {
  const observes = Object.fromEntries(
    ObservationFaces.map((face) => [face, 'none' as ObservationCoverage]),
  ) as Record<ObservationFace, ObservationCoverage>
  return {
    observes,
    settleSignal: 'custom',
    canApproveInline: false,
    canAbortMidRun: false,
    verifierIsolation: 'none',
    preservesNativeExecution: false,
  }
}

/** 驱动连身份都报不出来时用的占位身份：只留试验声明的执行体 id，其余都是未知。 */
export function unavailableExecutor(executorId: string): ExecutorIdentity {
  return {
    executorId,
    adapterVersion: 'unavailable',
    cliVersion: null,
    provider: null,
    model: null,
    modelRevision: null,
    contextWindow: null,
    reasoningProfile: null,
    configuration: {},
  }
}

/** 把「旅程 × 执行体 × 实验臂 × 重复次数」展开成一批试验。 */
export function createMatrixJob(input: MatrixJobInput): JobSpec {
  const arms = input.arms?.length ? input.arms : [null]
  const replicates = input.replicates ?? 1
  const seed = input.seed ?? 1
  const trials: TrialSpec[] = []
  for (const journey of input.journeyIds) {
    for (const executorId of input.executorIds) {
      for (const arm of arms) {
        const groupId = `${input.id}:${journey.id}:${arm ?? 'default'}`
        for (let index = 1; index <= replicates; index += 1) {
          trials.push({
            id: `${groupId}:${executorId}:r${index}`,
            journeyId: journey.id,
            journeyVersion: journey.version,
            executorId,
            arm,
            replicate: { groupId, index, ofK: replicates, seed: seed + index - 1 },
          })
        }
      }
    }
  }
  return {
    id: input.id,
    suiteId: input.suiteId,
    trials,
    concurrency: input.concurrency ?? 1,
    archiveDirectory: input.archiveDirectory,
  }
}
