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
// `maxConcurrency` 是 `mapWithConcurrency` 的 runner 数；`maxRounds` 限 repeat 轮次。
// 三者都先取 `min` 再用——**声明值只能调小不能调大**，模型写 `max_agents: 999` 会被钳到实际
// 可用额度并在结果的 `effective_limits` 里如实回报（静默钳制会让模型以为自己拿到了 999）。
// 中断（`WorkflowAbortedError`）与预算耗尽是两种不同终止：前者是外部信号，后者是自限，
// 二者都在 `run` 的 catch 里落成该步骤的终态并**停止后续步骤**，不重试。
//
// ## 并发/总量的权威在派发器，不在本文件（2026-08-06 P3 判决）
// 本解释器**没有自己的并发实现**。`maxConcurrency` 与 `maxAgents` 的上界由注入的
// `AgentWorkflowDispatchPort.limits` 给出，也就是 `SubAgentDispatcher` 的信号量上限与该执行
// 剩余的派发总量帽——同一把闸，同一本账。
//
// 曾经这里有第二本账：`MaxWorkflowConcurrency = 4` 的固定 runner 数与信号量互不知情，而
// `effective_limits.max_concurrency` 把这个声明值当"真实上限"回显给模型。父 Agent 先
// `agent:dispatch` 起 3 个后台子 Agent 再 `run_workflow(max_concurrency: 4)`，结果里白纸黑字
// 写着 4、实际每次只有 1 个 runner 能拿到槽位，模型据此估算耗时全错且无从发现自己被卡住。
//
// **为什么不干脆"无限 runner，全靠信号量排队"**（那是考古给的另一个选项）：会当场破掉下面
// 那条 skipped 占位约定。一次性把所有 lane 都投出去，就不存在"未启动"的条目，`fail_fast`
// 什么也停不住、占位分支变成死代码；而且派发器的总量帽 `dispatchCountByExecution` 是在
// `acquire()` **之前**扣的，等于把用户想放弃的那些 call 的配额也一起烧掉。
// 因此保留 runner 调度器，只是把 runner 数从"自带常量"改成"读派发器真值"——单源与
// fail_fast 语义两者都要。
//
// ## 一条必须成对维护的约定
// `parallel` 与 `pipeline` 在 fail_fast 或中断时，都为**未启动**的条目补一条 `status:'skipped'`
// 的占位（前者按 call、后者按 item），带上跳过原因。缺了占位，模型无法区分"这条没跑"与
// "这条不存在"，也就无从判断要不要重跑。给两者之一加新的提前退出路径时，占位要一起补。
// 注意占位也会进 `outputs`：下游 filter / dedupe / majority_vote 读到的数组里含 skipped 条目，
// 需要时按 `status` 自行滤除。

import {
  isArray,
  isEmpty,
  isNumber,
  isPresent,
  isUndefined,
  Log,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentWorkflowAgentCall, AgentWorkflowAgentResult, AgentWorkflowDedupeStep, AgentWorkflowDefinition, AgentWorkflowMajorityVoteStep, AgentWorkflowRepeatConvergence, AgentWorkflowRunResult, AgentWorkflowStep, AgentWorkflowStepResult, AgentWorkflowValueRef } from '../../types/agent.js'
import type { AgentWorkflowDispatchPort, AgentWorkflowRunOptions } from '../../types/runner.js'
import { asArray, boundedClone, clampDeclaredLimit, comparePredicate, isSuccessful, mapWithConcurrency, MaxWorkflowValueBytes, stableJson, valueAtPath } from '../../utils/runner/workflow-runtime'
import { WorkflowAbortedError } from '../errors/WorkflowAbortedError'
import { WorkflowBudgetExhaustedError } from '../errors/WorkflowBudgetExhaustedError'

const MaxWorkflowAgents = 8
const MaxWorkflowRounds = 6


const log = Log.tag('AgentWorkflowRuntime')



















class AgentWorkflowRuntime {
  private agentCount = 0
  private maxAgents = MaxWorkflowAgents
  private maxConcurrency = 1
  private abortSignal?: AbortSignal

  constructor(private readonly port: AgentWorkflowDispatchPort) {}

  public async run(
    definition: AgentWorkflowDefinition,
    options: AgentWorkflowRunOptions
  ): Promise<AgentWorkflowRunResult> {
    this.agentCount = 0
    // 两条上限都以派发器的运行时真值封顶：`maxAgents` 不许超过该执行剩余的派发总量帽
    // （超了只会在派发器那边变成一串 `status:'failed'` 的文本，而 workflow 的预算还剩一大截，
    // 模型看到的是"节点失败"而不是"预算到顶"）；`maxConcurrency` 不许超过信号量上限。
    this.maxAgents = clampDeclaredLimit(
      definition.max_agents,
      Math.min(MaxWorkflowAgents, this.port.limits.remainingDispatchBudget),
      0
    )
    this.maxConcurrency = clampDeclaredLimit(
      definition.max_concurrency,
      this.port.limits.maxConcurrentSubAgents,
      1
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
        log.caught(`workflow step「${step.id}」执行失败（status: ${status}）`, error)
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
      // 回显的是**运行时真值**：`max_concurrency` 就是派发器信号量的上限（钳制后），
      // `max_agents` 已经把该执行剩余的派发总量帽算进去了。模型据此估算耗时才不会全错。
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
    if (isEmpty(definition.steps)) throw new AppError('VALIDATION', 'Workflow 至少需要一个 step。')
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
    // @arch-guard:suspend code-style/forbid-redundant-strict-literal-comparison 理由：null 是 workflow 数据面的合法值，只有 undefined 表示缺席。
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
    const decided = !isEmpty(decisions) && decisions.every((decision) => decision.status === 'decided')
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
  MaxWorkflowRounds,
  MaxWorkflowValueBytes,
}
