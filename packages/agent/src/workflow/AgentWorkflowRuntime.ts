// 域：声明式多 Agent Workflow 的 **IR 解释器**。输入是一份已通过 schema 校验的
// `AgentWorkflowDefinition`，输出是逐步骤结果树；唯一的对外副作用是注入的 `dispatch` 端口。
//
// ## 安全不变量（有门守着，改前先看）
// 解释器**没有通用代码执行能力**：无 fs / net / process / require / import / Electron，
// 表达式只有 `valueAtPath` 取值与 `comparePredicate` 六个比较算子。`check:agent-schemas` 防线②
// 按正则扫本文件源码来钉死这条——加一个动态导入或 require 调用会当场喊红。**该门连注释一起扫**，
// 所以连"举个反例"都不能把那些调用形状写进本文件。这不是洁癖：Workflow 的 IR 由模型生成，
// 任何"顺手加个求值"都等于把任意代码执行交给模型。
//
// ## 控制流与状态
// `run` 顺序执行 steps，输出以 stepId 存进 `outputs` 供后续 reducer 引用（`validateDefinition`
// 保证只能引用**更早**的 step，因此不存在环）。六种 operation 分两族：
//  - **派发族**（parallel / pipeline / repeat）——会真的派子 Agent，受三条预算约束；
//  - **归约族**（filter / dedupe / majority_vote）——纯函数，只读 `outputs`，不派任何 Agent。
// 步骤状态三态 completed / partial / failed，`resolveRunStatus` 按 aborted > budget_exhausted >
// failed > partial 的**严重度**归并成 run 状态（不是取最后一步）。
//
// ## 三条预算与两种终止
// `maxAgents`（整次上限）在 `dispatch` 处逐次扣减并抛 `WorkflowBudgetExhaustedError`；
// `maxConcurrency` 由 `mapWithConcurrency` 的固定 runner 数实现；`maxRounds` 限 repeat 轮次。
// 三者都先与模块常量取 `min` 再用——**声明值只能调小不能调大**，模型写 `max_agents: 999` 会被
// 钳到 8 并在结果的 `effective_limits` 里如实回报（静默钳制会让模型以为自己拿到了 999）。
// 中断（`WorkflowAbortedError`）与预算耗尽是两种不同终止：前者是外部信号，后者是自限，
// 二者都在 `run` 的 catch 里落成该步骤的终态并**停止后续步骤**，不重试。
//
// ## 一条必须成对维护的约定
// `parallel` 与 `pipeline` 在 fail_fast 或中断时，都为**未启动**的条目补一条 `status:'skipped'`
// 的占位（前者按 call、后者按 item），带上跳过原因。缺了占位，模型无法区分"这条没跑"与
// "这条不存在"，也就无从判断要不要重跑。给两者之一加新的提前退出路径时，占位要一起补。
// 注意占位也会进 `outputs`：下游 filter / dedupe / majority_vote 读到的数组里含 skipped 条目，
// 需要时按 `status` 自行滤除。

import {
  isArray,
  isFalse,
  isNotUndefined,
  isNumber,
  isPresent,
  isRecord,
  isUndefined,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  AgentWorkflowAgentCall,
  AgentWorkflowAgentResult,
  AgentWorkflowDedupeStep,
  AgentWorkflowDefinition,
  AgentWorkflowMajorityVoteStep,
  AgentWorkflowPredicate,
  AgentWorkflowRepeatConvergence,
  AgentWorkflowRunResult,
  AgentWorkflowStep,
  AgentWorkflowStepResult,
  AgentWorkflowValuePath,
  AgentWorkflowValueRef,
} from '@velaros-ai/core/types'

import { compareStableStrings } from '../agent/context/residency/determinism'

const MaxWorkflowAgents = 8
const MaxWorkflowConcurrency = 4
const MaxWorkflowRounds = 6
const MaxWorkflowValueBytes = 32 * 1024
const Utf8ByteCounter = new TextEncoder()

interface AgentWorkflowDispatchContext {
  stepId: string
  call: AgentWorkflowAgentCall
  input?: unknown
  itemIndex?: number
  round?: number
}

interface AgentWorkflowDispatchPort {
  dispatch: (context: AgentWorkflowDispatchContext) => Promise<AgentWorkflowAgentResult>
}

interface AgentWorkflowRunOptions {
  runId: string
  abortSignal?: AbortSignal
}

class WorkflowBudgetExhaustedError extends Error {}
class WorkflowAbortedError extends Error {}

/**
 * 有界深拷贝：解释器**每一次跨步骤传值都过这里**（step 输出、pipeline item、call input、seed）。
 *
 * 两件事一起做，缺一不可：**JSON round-trip** 把值收敛成纯数据（切断原型/闭包/引用共享——
 * 后续 step 拿到的必须是快照，否则 reducer 改一处会回溯改掉上游 step 已记录的输出），
 * **字节上限**挡住"一个 step 返回 10MB 把后续全部撑爆"。字节数按 UTF-8 计而非 `.length`：
 * 中文 JSON 的字符数只有字节数的三分之一，按字符卡等于实际放宽三倍。
 */
function boundedClone<T>(value: T, label: string): T {
  const serialized = JSON.stringify(value)
  if (isUndefined(serialized)) throw new AppError('VALIDATION', `${label} 不是可序列化 JSON。`)
  if (Utf8ByteCounter.encode(serialized).byteLength > MaxWorkflowValueBytes) {
    throw new AppError('VALIDATION', `${label} 超过 ${MaxWorkflowValueBytes} 字节上限。`)
  }
  return JSON.parse(serialized) as T
}

/** 路径取值：数字段只走数组、字符串段只走字典；类型对不上一律 `undefined`（而不是抛错）。 */
function valueAtPath(value: unknown, path: AgentWorkflowValuePath = []): unknown {
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
function stableJson(value: unknown): string {
  if (isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.entries(value)
      .sort(([left], [right]) => compareStableStrings(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function comparePredicate(item: unknown, predicate: AgentWorkflowPredicate): boolean {
  const actual = valueAtPath(item, predicate.path)
  switch (predicate.op) {
    case 'eq':
      return stableJson(actual) === stableJson(predicate.value)
    case 'neq':
      return stableJson(actual) !== stableJson(predicate.value)
    case 'in':
      return Array.isArray(predicate.value) && predicate.value.some(
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

function asArray(value: unknown, label: string): unknown[] {
  if (!isArray(value)) throw new AppError('VALIDATION', `${label} 必须解析为数组。`)
  return value
}

/** 成功 = 收敛且**产出了结构化结果**：没有 structured_output 的"完成"下游 reducer 无从消费。 */
function isSuccessful(result: AgentWorkflowAgentResult): boolean {
  return result.status === 'completed' && isNotUndefined(result.structured_output)
}

async function mapWithConcurrency<T>(
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

class AgentWorkflowRuntime {
  private agentCount = 0
  private maxAgents = MaxWorkflowAgents
  private maxConcurrency = MaxWorkflowConcurrency
  private abortSignal?: AbortSignal

  constructor(private readonly port: AgentWorkflowDispatchPort) {}

  public async run(
    definition: AgentWorkflowDefinition,
    options: AgentWorkflowRunOptions
  ): Promise<AgentWorkflowRunResult> {
    this.agentCount = 0
    this.maxAgents = Math.min(MaxWorkflowAgents, Math.max(1, definition.max_agents ?? MaxWorkflowAgents))
    this.maxConcurrency = Math.min(
      MaxWorkflowConcurrency,
      Math.max(1, definition.max_concurrency ?? MaxWorkflowConcurrency)
    )
    this.abortSignal = options.abortSignal
    this.validateDefinition(definition)

    const outputs = new Map<string, unknown>()
    const stepResults: AgentWorkflowStepResult[] = []
    for (const step of definition.steps) {
      try {
        this.assertCanContinue()
        const result = await this.executeStep(step, outputs)
        stepResults.push(result)
        outputs.set(step.id, result.output)
        if (result.status === 'failed') break
      } catch (error) {
        const status = error instanceof WorkflowBudgetExhaustedError
          ? 'budget_exhausted'
          : error instanceof WorkflowAbortedError
            ? 'aborted'
            : 'failed'
        const result: AgentWorkflowStepResult = {
          id: step.id,
          operation: step.operation,
          status,
          output: null,
          agent_count: this.agentCount,
          error: error instanceof Error ? error.message : String(error),
        }
        stepResults.push(result)
        break
      }
    }

    const last = stepResults.at(-1)
    const status = this.resolveRunStatus(stepResults)
    return {
      workflow_run_id: options.runId,
      name: definition.name,
      status,
      effective_limits: {
        max_concurrency: this.maxConcurrency,
        max_agents: this.maxAgents,
      },
      agent_count: this.agentCount,
      steps: stepResults,
      output: last ? last.output : null,
    }
  }

  private validateDefinition(definition: AgentWorkflowDefinition): void {
    if (definition.steps.length === 0) throw new AppError('VALIDATION', 'Workflow 至少需要一个 step。')
    const ids = new Set<string>()
    for (const step of definition.steps) {
      if (ids.has(step.id)) throw new AppError('VALIDATION', `Workflow step id 重复：${step.id}。`)
      this.validateSourceReference(step, ids)
      ids.add(step.id)
    }
    boundedClone(definition, 'Workflow IR')
  }

  private validateSourceReference(step: AgentWorkflowStep, priorIds: ReadonlySet<string>): void {
    if (step.operation !== 'filter' && step.operation !== 'dedupe' && step.operation !== 'majority_vote') return
    if (priorIds.has(step.source.step_id)) return
    const available = [...priorIds]
    throw new AppError('VALIDATION', 
      `step "${step.id}" 引用了尚不可用的 source "${step.source.step_id}"。可用 step id：${available.join(', ') || '（无）'}。`
    )
  }

  private async executeStep(
    step: AgentWorkflowStep,
    outputs: ReadonlyMap<string, unknown>
  ): Promise<AgentWorkflowStepResult> {
    const countBefore = this.agentCount
    let output: unknown
    let status: AgentWorkflowStepResult['status'] = 'completed'

    switch (step.operation) {
      case 'parallel': {
        let stop = false
        const results = await mapWithConcurrency(
          step.calls.length,
          this.maxConcurrency,
          async (index) => {
            const result = await this.dispatch(step.id, step.calls[index]!)
            if (!isSuccessful(result) && step.failure_policy === 'fail_fast') stop = true
            return result
          },
          () => stop || !!this.abortSignal?.aborted
        )
        const orderedResults = results.map((result, index) => result ?? ({
          call_id: step.calls[index]!.id,
          status: 'skipped',
          summary: stop ? '因 fail_fast 跳过。' : '因父执行中断跳过。',
        } satisfies AgentWorkflowAgentResult))
        this.assertCanContinue()
        output = orderedResults
        const completed = orderedResults.filter(isSuccessful).length
        status = completed === step.calls.length ? 'completed' : completed > 0 ? 'partial' : 'failed'
        break
      }
      case 'pipeline': {
        let stop = false
        const lanes = await mapWithConcurrency(
          step.items.length,
          this.maxConcurrency,
          async (itemIndex) => {
            const input = boundedClone(step.items[itemIndex], `pipeline item ${itemIndex + 1}`)
            let current: unknown = input
            const stages: AgentWorkflowAgentResult[] = []
            for (const stage of step.stages) {
              const result = await this.dispatch(step.id, stage, current, { itemIndex })
              stages.push(result)
              if (!isSuccessful(result)) {
                if (step.failure_policy === 'fail_fast') stop = true
                return { item_index: itemIndex, status: 'failed', input, stages }
              }
              current = result.structured_output
            }
            return { item_index: itemIndex, status: 'completed', input, output: current, stages }
          },
          () => stop || !!this.abortSignal?.aborted
        )
        // 未启动的 item 补 skipped 占位（与 parallel 同形）：直接丢弃的话，模型看结果时无法区分
        // "这个 item 因 fail_fast/中断没跑"与"这个 item 根本不存在"，也就无从判断要不要重跑。
        // items 整体已在 IR 校验时过 boundedClone，逐项再克隆不会新增超限失败。
        const laneResults = lanes.map((lane, itemIndex) => lane ?? {
          item_index: itemIndex,
          status: 'skipped',
          input: boundedClone(step.items[itemIndex], `pipeline item ${itemIndex + 1}`),
          stages: [],
          summary: stop ? '因 fail_fast 跳过。' : '因父执行中断跳过。',
        })
        this.assertCanContinue()
        output = laneResults
        const completed = laneResults.filter((lane) => lane.status === 'completed').length
        status = completed === step.items.length ? 'completed' : completed > 0 ? 'partial' : 'failed'
        break
      }
      case 'repeat': {
        const rounds: AgentWorkflowAgentResult[] = []
        let current = boundedClone(step.seed, 'repeat seed')
        let converged = false
        let noNewRounds = 0
        const seenKeys = new Set<string>()
        const maxRounds = Math.min(MaxWorkflowRounds, Math.max(1, step.max_rounds ?? MaxWorkflowRounds))
        for (let round = 1; round <= maxRounds; round += 1) {
          const result = await this.dispatch(step.id, step.call, current, { round })
          rounds.push(result)
          if (!isSuccessful(result)) break
          current = result.structured_output
          const convergence = this.evaluateConvergence(
            current,
            step.convergence,
            seenKeys,
            noNewRounds
          )
          noNewRounds = convergence.noNewRounds
          if (convergence.converged) {
            converged = true
            break
          }
        }
        output = { converged, rounds, output: current }
        status = rounds.some(isSuccessful) ? (converged ? 'completed' : 'partial') : 'failed'
        break
      }
      case 'filter': {
        const source = this.resolveSource(outputs, step.source, step.id)
        output = asArray(source, `filter step "${step.id}" source`).filter((item) =>
          comparePredicate(item, step.predicate)
        )
        break
      }
      case 'dedupe': {
        output = this.dedupe(asArray(this.resolveSource(outputs, step.source, step.id), `dedupe step "${step.id}" source`), step)
        break
      }
      case 'majority_vote': {
        output = this.majorityVote(
          asArray(this.resolveSource(outputs, step.source, step.id), `majority_vote step "${step.id}" source`),
          step
        )
        status = (output as { status: string }).status === 'decided' ? 'completed' : 'partial'
        break
      }
    }

    return {
      id: step.id,
      operation: step.operation,
      status,
      output: boundedClone(output, `step "${step.id}" output`),
      agent_count: this.agentCount - countBefore,
    }
  }

  private async dispatch(
    stepId: string,
    call: AgentWorkflowAgentCall,
    input?: unknown,
    position: { itemIndex?: number; round?: number } = {}
  ): Promise<AgentWorkflowAgentResult> {
    this.assertCanContinue()
    if (this.agentCount >= this.maxAgents) {
      throw new WorkflowBudgetExhaustedError(`Workflow 已达到单次 Agent 上限 ${this.maxAgents}。`)
    }
    this.agentCount += 1
    try {
      return await this.port.dispatch({
        stepId,
        call,
        input: isUndefined(input) ? undefined : boundedClone(input, `call "${call.id}" input`),
        ...position,
      })
    } catch (error) {
      if (this.abortSignal?.aborted) {
        throw new WorkflowAbortedError('Workflow 已随父执行中断。')
      }
      throw error
    }
  }

  private resolveSource(
    outputs: ReadonlyMap<string, unknown>,
    source: AgentWorkflowValueRef,
    stepId: string
  ): unknown {
    if (!outputs.has(source.step_id)) {
      throw new AppError('VALIDATION', `step "${stepId}" 找不到 source "${source.step_id}"。`)
    }
    const value = valueAtPath(outputs.get(source.step_id), source.path)
    if (value === undefined) {
      throw new AppError('VALIDATION', `step "${stepId}" 的 source path 不存在：${source.path?.join('.') || '（根）'}。`)
    }
    return value
  }

  private dedupe(items: unknown[], step: AgentWorkflowDedupeStep): unknown[] {
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

  private majorityVote(items: unknown[], step: AgentWorkflowMajorityVoteStep): unknown {
    const groups = new Map<string, { value: unknown; votes: Map<string, { value: unknown; count: number }> }>()
    for (const item of items) {
      const vote = valueAtPath(item, step.vote_path)
      if (!isPresent(vote)) continue
      const groupValue = step.group_path && step.group_path.length > 0
        ? valueAtPath(item, step.group_path)
        : '__all__'
      const groupKey = stableJson(groupValue)
      const group = groups.get(groupKey) ?? { value: groupValue, votes: new Map() }
      const voteKey = stableJson(vote)
      const current = group.votes.get(voteKey)
      group.votes.set(voteKey, { value: vote, count: (current?.count ?? 0) + 1 })
      groups.set(groupKey, group)
    }

    const quorum = Math.max(1, step.quorum ?? 2)
    const threshold = Math.min(1, Math.max(0.5, step.majority_threshold ?? 0.5))
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
    const decided = decisions.length > 0 && decisions.every((decision) => decision.status === 'decided')
    return { status: decided ? 'decided' : 'inconclusive', groups: decisions }
  }

  private evaluateConvergence(
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

  private assertCanContinue(): void {
    if (this.abortSignal?.aborted) throw new WorkflowAbortedError('Workflow 已随父执行中断。')
  }

  private resolveRunStatus(steps: AgentWorkflowStepResult[]): AgentWorkflowRunResult['status'] {
    if (steps.some((step) => step.status === 'aborted')) return 'aborted'
    if (steps.some((step) => step.status === 'budget_exhausted')) return 'budget_exhausted'
    if (steps.some((step) => step.status === 'failed')) return 'failed'
    if (steps.some((step) => step.status === 'partial')) return 'partial'
    return 'completed'
  }
}

export {
  AgentWorkflowRuntime,
  MaxWorkflowAgents,
  MaxWorkflowConcurrency,
  MaxWorkflowRounds,
  MaxWorkflowValueBytes,
}
export type { AgentWorkflowDispatchContext, AgentWorkflowDispatchPort, AgentWorkflowRunOptions }
