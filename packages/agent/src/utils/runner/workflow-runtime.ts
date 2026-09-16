import { isArray, isEmpty, isFalse, isNotUndefined, isNumber, isPresent, isRecord, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { AgentToolLimits } from '../../contract/constants.js'
import type { AgentWorkflowAgentResult, AgentWorkflowDedupeStep, AgentWorkflowDefinition, AgentWorkflowMajorityVoteStep, AgentWorkflowPredicate, AgentWorkflowRepeatConvergence, AgentWorkflowRunResult, AgentWorkflowStep, AgentWorkflowStepResult, AgentWorkflowValuePath, AgentWorkflowValueRef } from '../../types/agent.js'
import { compareStableStrings } from '../residency/determinism'

export const Utf8ByteCounter = new TextEncoder()

/** 工作流里单个值的字节上限；值在 `AgentToolLimits.workflow.maxValueBytes`。 */
export const MaxWorkflowValueBytes: number = AgentToolLimits.workflow.maxValueBytes

/**
 * 有界深拷贝：解释器**每一次跨步骤传值都经过这里**，包括步骤输出、管线条目、调用输入与种子值。
 *
 * 两件事一起做，缺一不可：**通过 `JSON` 往返序列化**把值收敛成纯数据，切断原型、闭包和引用共享；
 * 后续步骤必须拿到快照，否则归并器修改一处会回溯改掉上游步骤已记录的输出。
 * **字节上限**挡住"一个 step 返回 10MB 把后续全部撑爆"。字节数按 UTF-8 计而非 `.length`：
 * 中文 `JSON` 的字符数只有字节数的三分之一，按字符限制等于实际放宽三倍。
 */
export function boundedClone<T>(value: T, label: string): T {
  const serialized = JSON.stringify(value)
  if (isUndefined(serialized)) throw new AppError('VALIDATION', `${label} 不是可序列化 JSON。`)
  if (Utf8ByteCounter.encode(serialized).byteLength > MaxWorkflowValueBytes) {
    throw new AppError('VALIDATION', `${label} 超过 ${MaxWorkflowValueBytes} 字节上限。`)
  }
  return JSON.parse(serialized) as T
}

/** 路径取值：数字段只走数组、字符串段只走字典；类型对不上一律 `undefined`（而不是抛错）。 */
export function valueAtPath(value: unknown, path: AgentWorkflowValuePath = []): unknown {
  let current = value
  for (const segment of path) {
    if (!isPresent(current)) return undefined
    if (isNumber(segment)) {
      if (!isArray(current)) return undefined
      current = current[segment]
      continue
    }
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

/**
 * 结构等值的**规范文本**：dedupe 的分组键、majority_vote 的票面键、predicate 的 eq/in 比较全靠它。
 * 键排序钉死是硬要求——同一个对象字面量在两个 step 里键序不同会被判成两票，投票结果随之漂移。
 */
export function stableJson(value: unknown): string {
  if (isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * 对一个条目求 workflow 谓词的真假：先按 `path` 取值，再按 `op` 比较。
 *
 * eq/neq/in 一律走 {@link stableJson} 做结构等值（所以对象/数组按内容比，键序无关）；
 * gte/lte 要求两边都是数字，任一边不是就为假（而不是做隐式转换）；
 * `exists` 借 `value:false` 表达"断言不存在"。取不到的路径统一是 `undefined`，不会抛错。
 */
export function comparePredicate(item: unknown, predicate: AgentWorkflowPredicate): boolean {
  const actual = valueAtPath(item, predicate.path)
  switch (predicate.op) {
    case 'eq':
      return stableJson(actual) === stableJson(predicate.value)
    case 'neq':
      return stableJson(actual) !== stableJson(predicate.value)
    case 'in':
      return isArray(predicate.value) && predicate.value.some(
        (candidate) => stableJson(candidate) === stableJson(actual)
      )
    case 'exists':
      // value:false 是「断言不存在」的写法（`exists` 无第二个操作数可用）。
      return isFalse(predicate.value) ? isUndefined(actual) : isNotUndefined(actual)
    case 'gte':
      return isNumber(actual) && isNumber(predicate.value) && actual >= predicate.value
    case 'lte':
      return isNumber(actual) && isNumber(predicate.value) && actual <= predicate.value
  }
}

/**
 * 断言取到的值是数组并原样返回，不是数组就抛 `VALIDATION`（消息带 `label` 指明是哪一处）。
 * 归约族步骤的输入必须是数组，这里刻意**不**把单值包成 `[value]`——那样会把"IR 写错了路径"
 * 悄悄变成一次只有一个元素的归约，结果看着正常却是错的。
 */
export function asArray(value: unknown, label: string): unknown[] {
  if (!isArray(value)) throw new AppError('VALIDATION', `${label} 必须解析为数组。`)
  return value
}

/** 成功 = 收敛且**产出了结构化结果**：没有 structured_output 的"完成"下游 reducer 无从消费。 */
export function isSuccessful(result: AgentWorkflowAgentResult): boolean {
  return result.status === 'completed' && isNotUndefined(result.structured_output)
}

/**
 * 以固定并发跑 `count` 个下标任务，结果按下标原位回填（不是按完成顺序），并发数取 `min(concurrency, count)`。
 *
 * 共用一个游标分发下标，所以慢任务不会拖住整条队列。每次取下标前先问 `shouldStop()`：
 * 一旦为真，**在跑的不打断、剩下的不再启动**，对应下标保持 `undefined`——调用方据此区分"没跑"和"跑出了空结果"。
 */
export async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<T>,
  shouldStop: () => boolean
): Promise<Array<T | undefined>> {
  const results: Array<T | undefined> = Array.from({ length: count })
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      if (shouldStop()) return
      const index = cursor
      cursor += 1
      if (index >= count) return
      results[index] = await worker(index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * 声明值 → 生效值的钳制：`min(运行时可用额度, 声明值)`，下界由 `floor` 给。
 *
 * 缺省（模型没写）时取"运行时可用额度"而不是某个硬常量——不写等于"给我你能给的"，
 * 而能给多少由派发器说了算。
 *
 * `floor` 两种取法：并发数取 1（0 个 runner 等于什么都不跑，是死锁不是限流）；
 * agent 总量取 0（**总量帽真的可能已经用光**，此时正确行为是第一次 dispatch 就抛
 * `WorkflowBudgetExhaustedError`，让 run 状态落成 `budget_exhausted`，而不是硬塞一个名额
 * 进去、再由派发器回一段"节点失败"的文本把预算耗尽伪装成执行失败）。
 */
export function clampDeclaredLimit(
  declared: LooseOptional<number>,
  runtimeCeiling: number,
  floor: 0 | 1
): number {
  const ceiling = Math.max(floor, Math.floor(runtimeCeiling))
  if (isUndefined(declared) || !isNumber(declared)) return ceiling
  return Math.min(ceiling, Math.max(floor, Math.floor(declared)))
}

/** 归约族步骤（filter / dedupe / majority_vote）只许引用**更早**的 step；引用未来或不存在的 id 直接判定义非法，这条保证 outputs 不可能成环。 */
function validateSourceReference(step: AgentWorkflowStep, priorIds: ReadonlySet<string>): void {
  if (step.operation !== 'filter' && step.operation !== 'dedupe' && step.operation !== 'majority_vote') return
  if (priorIds.has(step.source.step_id)) return
  const available = [...priorIds]
  throw new AppError('VALIDATION',
    `step "${step.id}" 引用了尚不可用的 source "${step.source.step_id}"。可用 step id：${available.join(', ') || '（无）'}。`
  )
}

/**
 * 跑之前对 IR 做一次性校验：至少一个 step、step id 不重复、归约步骤只引更早的 step，最后整份 IR 过一次有界深拷贝
 * （既确认可序列化，也把超大 IR 挡在开跑之前）。任何一条不满足都抛 `VALIDATION`，调用方不必再做第二遍检查。
 */
export function validateWorkflowDefinition(definition: AgentWorkflowDefinition): void {
  if (isEmpty(definition.steps)) throw new AppError('VALIDATION', 'Workflow 至少需要一个 step。')
  const ids = new Set<string>()
  for (const step of definition.steps) {
    if (ids.has(step.id)) throw new AppError('VALIDATION', `Workflow step id 重复：${step.id}。`)
    validateSourceReference(step, ids)
    ids.add(step.id)
  }
  boundedClone(definition, 'Workflow IR')
}

/** 从已完成步骤的输出表里按 `step_id` + `path` 取归约族步骤的输入；step 没跑过或路径不存在都抛 `VALIDATION`（这类错是 IR 写错，不是数据为空）。 */
export function resolveWorkflowSource(
  outputs: ReadonlyMap<string, unknown>,
  source: AgentWorkflowValueRef,
  stepId: string
): unknown {
  if (!outputs.has(source.step_id)) {
    throw new AppError('VALIDATION', `step "${stepId}" 找不到 source "${source.step_id}"。`)
  }
  const value = valueAtPath(outputs.get(source.step_id), source.path)
  // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：null 是 workflow 数据面的合法值，只有 undefined 表示缺席。
  if (value === undefined) {
    throw new AppError('VALIDATION', `step "${stepId}" 的 source path 不存在：${source.path?.join('.') || '（根）'}。`)
  }
  return value
}

/**
 * 按 `key_paths` 组成的联合键去重，保持首次出现的顺序。
 *
 * `keep: 'highest_confidence'` 且给了 `confidence_path` 时，同键的后来者分数更高就顶掉先前那条（位置不变）；
 * 其余情况一律保留先到的那条。分数不是数字的条目视为没有分数，不参与顶替。
 */
export function dedupeWorkflowItems(items: unknown[], step: AgentWorkflowDedupeStep): unknown[] {
  const result: unknown[] = []
  const indexByKey = new Map<string, number>()
  for (const item of items) {
    const key = stableJson(step.key_paths.map((path) => valueAtPath(item, path)))
    const existingIndex = indexByKey.get(key)
    if (isUndefined(existingIndex)) {
      indexByKey.set(key, result.length)
      result.push(item)
      continue
    }
    if (step.keep !== 'highest_confidence' || !step.confidence_path) continue
    const existingScore = valueAtPath(result[existingIndex], step.confidence_path)
    const candidateScore = valueAtPath(item, step.confidence_path)
    if (isNumber(candidateScore) && (!isNumber(existingScore) || candidateScore > existingScore)) {
      result[existingIndex] = item
    }
  }
  return result
}

/**
 * 分组多数表决：按 `group_path` 分组（没给就全部算一组），组内按 `vote_path` 的值计票。
 *
 * 一组判 `decided` 要同时满足三条：总票数达到 `quorum`、票王不并列、票王占比不低于 `majority_threshold`；
 * 任一条不满足就是 `inconclusive`（并列一律不判，宁可不决也不随机挑一个）。整体状态在所有组都 decided 时才算 decided。
 */
export function resolveWorkflowMajorityVote(items: unknown[], step: AgentWorkflowMajorityVoteStep): unknown {
  const groups = new Map<string, { value: unknown; votes: Map<string, { value: unknown; count: number }> }>()
  for (const item of items) {
    const vote = valueAtPath(item, step.vote_path)
    if (!isPresent(vote)) continue
    const groupValue = !isEmpty(step.group_path ?? [])
      ? valueAtPath(item, step.group_path)
      : '__all__'
    const groupKey = stableJson(groupValue)
    const group = groups.get(groupKey) ?? { value: groupValue, votes: new Map() }
    const voteKey = stableJson(vote)
    const current = group.votes.get(voteKey)
    group.votes.set(voteKey, { value: vote, count: (current?.count ?? 0) + 1 })
    groups.set(groupKey, group)
  }

  const quorum = Math.max(1, step.quorum ?? AgentToolLimits.workflow.defaultQuorum)
  const threshold = Math.min(
    1,
    Math.max(
      AgentToolLimits.workflow.majorityThresholdFloor,
      step.majority_threshold ?? AgentToolLimits.workflow.majorityThresholdFloor
    )
  )
  const decisions = [...groups.values()].map((group) => {
    const votes = [...group.votes.values()].sort((left, right) => right.count - left.count)
    const totalVotes = votes.reduce((sum, vote) => sum + vote.count, 0)
    const top = votes[0]
    const tied = !!top && votes.filter((vote) => vote.count === top.count).length > 1
    const decided = !!top && totalVotes >= quorum && !tied && top.count / totalVotes >= threshold
    return {
      group: group.value,
      status: decided ? 'decided' : 'inconclusive',
      total_votes: totalVotes,
      quorum,
      counts: votes.map((vote) => ({ vote: vote.value, count: vote.count })),
      winner: decided ? top.value : undefined,
    }
  })
  const decided = !isEmpty(decisions) && decisions.every((decision) => decision.status === 'decided')
  return { status: decided ? 'decided' : 'inconclusive', groups: decisions }
}

/**
 * 判断 repeat 这一轮是否已经收敛，并把「连续多少轮没有新东西」的计数带到下一轮。
 *
 * 三种收敛判据：`predicate` 与 `count_at_least` 是一轮定输赢（计数归零）；`no_new_items` 要看耐心值——
 * 本轮没出现没见过的 key 才算一轮"无新增"，连续达到 `patience` 轮才收敛。`seenKeys` 由调用方跨轮持有，本函数就地写入。
 */
export function evaluateWorkflowConvergence(
  output: unknown,
  convergence: AgentWorkflowRepeatConvergence,
  seenKeys: Set<string>,
  previousNoNewRounds: number
): { converged: boolean; noNewRounds: number } {
  if (convergence.kind === 'predicate') return { converged: comparePredicate(output, convergence.predicate), noNewRounds: 0 }
  if (convergence.kind === 'count_at_least') {
    const value = valueAtPath(output, convergence.path)
    const count = isArray(value) ? value.length : isNumber(value) ? value : 0
    return { converged: count >= convergence.count, noNewRounds: 0 }
  }

  const items = asArray(valueAtPath(output, convergence.items_path), 'repeat no_new_items items')
  let newItems = 0
  for (const item of items) {
    const key = stableJson(valueAtPath(item, convergence.key_path))
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    newItems += 1
  }
  const noNewRounds = newItems === 0 ? previousNoNewRounds + 1 : 0
  return {
    converged: noNewRounds >= Math.max(1, convergence.patience ?? 1),
    noNewRounds,
  }
}

/** 把逐步骤状态按**严重度**归并成整次 run 的状态：aborted > budget_exhausted > failed > partial > completed。不是取最后一步——中间步骤的失败不能被后面的成功盖掉。 */
export function resolveWorkflowRunStatus(steps: AgentWorkflowStepResult[]): AgentWorkflowRunResult['status'] {
  if (steps.some((step) => step.status === 'aborted')) return 'aborted'
  if (steps.some((step) => step.status === 'budget_exhausted')) return 'budget_exhausted'
  if (steps.some((step) => step.status === 'failed')) return 'failed'
  if (steps.some((step) => step.status === 'partial')) return 'partial'
  return 'completed'
}
