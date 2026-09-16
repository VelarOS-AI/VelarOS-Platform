/**
 * 自适应战役：选下一批最小有用的用例，以及一条失败账的状态机。
 * 未修完的失败挡住新采样，修完之后证明任务优先；语义重复的用例不给额外覆盖信用。
 * 纯测量：不碰 Node 模块、不发请求。
 */
import type { CampaignFailureState, CampaignRootCauseClass } from '../../contract/constants.js'
import type {
  AdaptiveCampaignInput,
  AdaptiveCampaignSelection,
  CampaignEvidence,
  CampaignFailureRecord,
  RealTaskCase,
  RecordCampaignFailureInput,
  TransitionCampaignFailureInput,
} from '../../types/agent-lab.js'
import { AgentLabTuning } from '../tuning.js'

/** 失败账允许的状态流转；不在表里的一律拒绝。 */
const FailureTransitions: Readonly<Record<CampaignFailureState, readonly CampaignFailureState[]>> = {
  open: ['diagnosed'],
  diagnosed: ['fixed'],
  fixed: ['fixed', 'proving'],
  proving: ['fixed', 'closed'],
  closed: ['open'],
}

/** 去重并保持顺序。 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** 一条用例覆盖到的那几个维度钥匙。 */
function dimensionKeys(task: RealTaskCase): string[] {
  const coverage = task.coverage
  return [
    `archetype:${coverage.archetype}`,
    ...coverage.dataShapes.map((value) => `data:${value}`),
    `risk:${coverage.risk}`,
    `lifecycle:${coverage.lifecycle}`,
    `path:${coverage.path}`,
    `interaction:${coverage.interaction}`,
    `model:${coverage.modelRequirement}`,
  ]
}

/** 语义签名：换个说法的同一件事拿不到额外的覆盖信用。 */
export function realTaskSemanticSignature(task: RealTaskCase): string {
  const coverage = task.coverage
  return [
    task.surface,
    coverage.capability,
    coverage.objective.trim().toLocaleLowerCase('en-US'),
    coverage.archetype,
    [...coverage.dataShapes].sort().join(','),
    coverage.risk,
    coverage.lifecycle,
    coverage.path,
    coverage.interaction,
    coverage.modelRequirement,
  ].join('|')
}

/** 取每条用例在当前修订版下的最新证据；修订版对不上的证据不算数。 */
function currentEvidenceByTask(
  evidence: readonly CampaignEvidence[],
  revisions: ReadonlyMap<string, string>,
): Map<string, CampaignEvidence> {
  const result = new Map<string, CampaignEvidence>()
  for (const entry of evidence) {
    if (revisions.get(entry.taskId) !== entry.taskRevision) continue
    const previous = result.get(entry.taskId)
    if (!previous || previous.updatedAt < entry.updatedAt) result.set(entry.taskId, entry)
  }
  return result
}

/**
 * 选出最小有用的下一批。open / diagnosed 的失败会挡住一切新采样；
 * 修完之后证明任务排最前面；当前已经通过的证据直接复用，语义重复的用例去掉而不是当成额外信心。
 */
export function selectAdaptiveCampaignTasks(input: AdaptiveCampaignInput): AdaptiveCampaignSelection {
  const revisions = new Map(input.revisions.map((entry) => [entry.taskId, entry.revision]))
  if (revisions.size !== input.cases.length) throw new Error('每条战役用例必须且只能有一个修订版')
  const ids = new Set(input.cases.map((task) => task.id))
  if (ids.size !== input.cases.length) throw new Error('战役用例的 id 必须唯一')
  for (const id of ids) {
    if (!revisions.has(id)) throw new Error(`这条用例没有登记修订版: ${id}`)
  }

  const blockedFailureKeys = input.failures
    .filter((failure) => failure.state === 'open' || failure.state === 'diagnosed')
    .map((failure) => failure.key)
    .sort()
  if (blockedFailureKeys.length > 0) return { selected: [], reusedTaskIds: [], duplicateTaskIds: [], blockedFailureKeys, scores: {} }

  const current = currentEvidenceByTask(input.evidence, revisions)
  const reusedTaskIds = [...current.values()]
    .filter((entry) => entry.outcome === 'pass')
    .map((entry) => entry.taskId)
    .sort()
  const coveredDimensions = new Set(
    input.cases.filter((task) => current.get(task.id)?.outcome === 'pass').flatMap(dimensionKeys),
  )
  const provingTaskIds = new Set(
    input.failures
      .filter((failure) => failure.state === 'fixed' || failure.state === 'proving')
      .flatMap((failure) =>
        failure.proofTaskIds.filter((taskId) => !failure.passedProofTaskIds.includes(taskId)),
      ),
  )

  const duplicateTaskIds: string[] = []
  const bySignature = new Map<string, RealTaskCase>()
  for (const task of input.cases) {
    const signature = realTaskSemanticSignature(task)
    const previous = bySignature.get(signature)
    if (!previous) {
      bySignature.set(signature, task)
      continue
    }
    const keep = task.coverage.dailyWeight > previous.coverage.dailyWeight ? task : previous
    const drop = keep === task ? previous : task
    bySignature.set(signature, keep)
    duplicateTaskIds.push(drop.id)
  }

  const scoring = AgentLabTuning.campaign
  const scores: Record<string, number> = {}
  const candidates = [...bySignature.values()].filter((task) => {
    if (provingTaskIds.has(task.id)) return true
    return current.get(task.id)?.outcome !== 'pass'
  })
  const selected: RealTaskCase[] = []
  const selectionDimensions = new Set(coveredDimensions)
  while (selected.length < Math.max(0, input.limit) && candidates.length > 0) {
    for (const task of candidates) {
      const previous = current.get(task.id)
      const novelDimensions = dimensionKeys(task).filter(
        (dimension) => !selectionDimensions.has(dimension),
      ).length
      scores[task.id] =
        (provingTaskIds.has(task.id) ? scoring.provingScore : 0) +
        (previous?.outcome === 'fail'
          ? scoring.failedScore
          : previous?.outcome === 'void'
            ? scoring.voidScore
            : scoring.freshScore) +
        novelDimensions * scoring.novelDimensionScore +
        task.coverage.dailyWeight * scoring.dailyWeightScore +
        (task.coverage.path === 'boundary' || task.coverage.path === 'failure-recovery' ? scoring.hardPathScore : 0)
    }
    candidates.sort(
      (left, right) => (scores[right.id] ?? 0) - (scores[left.id] ?? 0) || left.id.localeCompare(right.id),
    )
    const next = candidates.shift()
    if (!next) break
    selected.push(next)
    dimensionKeys(next).forEach((dimension) => selectionDimensions.add(dimension))
  }

  return { selected, reusedTaskIds, duplicateTaskIds: duplicateTaskIds.sort(), blockedFailureKeys, scores }
}

/** 一条修完的失败要几个证明任务通过才关；模型与运行时这类容易反复的要更多。 */
export function requiredProofCount(classification: CampaignRootCauseClass): number {
  return classification === 'model' || classification === 'runtime'
    ? AgentLabTuning.campaign.proofTasksVolatile
    : AgentLabTuning.campaign.proofTasksDefault
}

/** 记一次失败：同一把钥匙的账合成一条，重新打开时已有的证明作废。 */
export function recordCampaignFailure(input: RecordCampaignFailureInput): CampaignFailureRecord[] {
  const existing = input.failures.find((failure) => failure.key === input.key)
  const next: CampaignFailureRecord = existing
    ? {
        ...existing,
        state: 'open',
        affectedTaskIds: unique([...existing.affectedTaskIds, input.taskId]),
        occurrences: existing.occurrences + 1,
        lastSeenAt: input.now,
        detail: input.detail,
        passedProofTaskIds: [],
      }
    : {
        key: input.key,
        classification: input.classification,
        state: 'open',
        capability: input.capability,
        affectedTaskIds: [input.taskId],
        proofTaskIds: [],
        passedProofTaskIds: [],
        occurrences: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        detail: input.detail,
        rootCause: null,
        fixReference: null,
      }
  return [...input.failures.filter((failure) => failure.key !== input.key), next].sort((left, right) =>
    left.key.localeCompare(right.key),
  )
}

/** 让一条失败账换状态：状态机不许的流转、没写根因的诊断、没写修复引用或证明任务不够的修复，一律当场报错。 */
export function transitionCampaignFailure(input: TransitionCampaignFailureInput): CampaignFailureRecord {
  if (!FailureTransitions[input.failure.state].includes(input.state)) {
    throw new Error(`失败账不允许这样流转: ${input.failure.state} -> ${input.state}`)
  }
  if (input.state === 'diagnosed' && !input.rootCause?.trim()) throw new Error('标为已诊断必须写清根因')
  if (input.state === 'fixed' && !input.fixReference?.trim()) throw new Error('标为已修复必须给出修复引用')
  const classification = input.classification ?? input.failure.classification
  const proofTaskIds = unique(input.proofTaskIds ?? input.failure.proofTaskIds)
  if (input.state === 'fixed' && proofTaskIds.length < requiredProofCount(classification)) {
    throw new Error(`${classification} 类失败标为已修复，至少要 ${requiredProofCount(classification)} 个互不相同的证明任务`)
  }
  return {
    ...input.failure,
    classification,
    state: input.state,
    rootCause: input.rootCause?.trim() || input.failure.rootCause,
    fixReference: input.fixReference?.trim() || input.failure.fixReference,
    proofTaskIds,
    passedProofTaskIds: input.state === 'fixed' ? [] : input.failure.passedProofTaskIds,
  }
}

/** 记一个证明任务通过；数够了就关账。 */
export function recordCampaignProof(failure: CampaignFailureRecord, taskId: string): CampaignFailureRecord {
  if (failure.state !== 'fixed' && failure.state !== 'proving') return failure
  if (!failure.proofTaskIds.includes(taskId)) return failure
  const passedProofTaskIds = unique([...failure.passedProofTaskIds, taskId])
  const enough = passedProofTaskIds.length >= requiredProofCount(failure.classification)
  return { ...failure, state: enough ? 'closed' : 'proving', passedProofTaskIds }
}

/**
 * 战役账本才是证明的权威，笔记本只是缓存了「哪些证明任务通过过」。
 * 用例被改过或运行时换了底，缓存的证明要能被撤销，但不能因此假装那次修复没发生过。
 */
export function reconcileCampaignProof(
  failure: CampaignFailureRecord,
  currentPassingTaskIds: ReadonlySet<string>,
): CampaignFailureRecord {
  if (failure.state === 'open' || failure.state === 'diagnosed') return failure.passedProofTaskIds.length === 0 ? failure : { ...failure, passedProofTaskIds: [] }
  const passedProofTaskIds = failure.proofTaskIds.filter((taskId) => currentPassingTaskIds.has(taskId))
  const enough = passedProofTaskIds.length >= requiredProofCount(failure.classification)
  return {
    ...failure,
    state: enough ? 'closed' : passedProofTaskIds.length > 0 ? 'proving' : 'fixed',
    passedProofTaskIds,
  }
}
