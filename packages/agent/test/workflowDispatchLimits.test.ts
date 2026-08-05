// 域：`agent:run_workflow` 的并发/总量**单源**回归（考古 P3）。
//
// 钉死的判决：workflow 没有自己的并发实现，上限一律取派发器给的运行时快照，
// `effective_limits` 回显的是真值而不是声明值。每条断言对应一个曾经真实存在的漂移。

import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { SubAgentDispatchLimitsSnapshot } from '../src/kernel/dispatch/concurrency'
import { Semaphore } from '../src/kernel/dispatch/concurrency'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import type { AgentWorkflowAgentResult, AgentWorkflowDefinition } from '../src/protocol/types/agentWorkflow'
import { AgentWorkflowRuntime } from '../src/workflow/AgentWorkflowRuntime'

/** 只喂 `describeExecutionLimits` 真正读到的那一格配置；其余依赖不参与本条判定。 */
function dispatcherWithConcurrency(maxConcurrentSubAgents?: number): SubAgentDispatcher {
  const configService = {
    systemConfig: { advancedRuntime: maxConcurrentSubAgents === undefined ? {} : { maxConcurrentSubAgents } },
  }
  return new SubAgentDispatcher(
    undefined as never,
    undefined as never,
    configService as never,
    undefined as never,
    undefined as never
  )
}

interface DispatchProbe {
  /** 同一时刻并发在跑的 call 峰值——runner 数是否真的按快照走，只有它能证明。 */
  peakConcurrency: number
  dispatched: string[]
}

function buildRuntime(
  limits: SubAgentDispatchLimitsSnapshot,
  options: { readonly failCallIds?: readonly string[] } = {}
): { runtime: AgentWorkflowRuntime; probe: DispatchProbe } {
  const probe: DispatchProbe = { peakConcurrency: 0, dispatched: [] }
  let inFlight = 0
  const failing = new Set(options.failCallIds ?? [])
  const runtime = new AgentWorkflowRuntime({
    limits,
    dispatch: async (context): Promise<AgentWorkflowAgentResult> => {
      inFlight += 1
      probe.peakConcurrency = Math.max(probe.peakConcurrency, inFlight)
      probe.dispatched.push(context.call.id)
      // 让所有已启动的 lane 有机会重叠：不 await 一个真的宏任务，峰值恒为 1。
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      if (failing.has(context.call.id)) return { call_id: context.call.id, status: 'failed', summary: 'probe failure' }
      return {
        call_id: context.call.id,
        status: 'completed',
        structured_output: { ok: true },
      }
    },
  })
  return { runtime, probe }
}

function parallelDefinition(
  callCount: number,
  overrides: Partial<AgentWorkflowDefinition> = {}
): AgentWorkflowDefinition {
  return {
    name: 'probe',
    steps: [
      {
        id: 'fan-out',
        operation: 'parallel',
        failure_policy: 'continue',
        calls: Array.from({ length: callCount }, (_, index) => ({
          id: `call-${index + 1}`,
          prompt: 'probe',
          output_schema: { type: 'object' },
        })),
      },
    ],
    ...overrides,
  } as AgentWorkflowDefinition
}

void describe('workflow dispatch limits are single-sourced from the dispatcher', () => {
  void test('Semaphore exposes its limit as the one authority', () => {
    assert.equal(new Semaphore(3).maxConcurrency, 3)
  })

  void test('the dispatcher reports the same number its semaphore would be built with', () => {
    // 配置缺席 → 缺省 4；配置在场 → 用配置。两条都走 `resolveConcurrencyLimit` 这一个计算式。
    assert.equal(
      dispatcherWithConcurrency().describeExecutionLimits({ sessionId: 's1' }).maxConcurrentSubAgents,
      4
    )
    const configured = dispatcherWithConcurrency(7)
    const snapshot = configured.describeExecutionLimits({ sessionId: 's1' })
    assert.equal(snapshot.maxConcurrentSubAgents, 7)
    assert.equal(snapshot.maxSubAgentsPerExecution, 32)
    // 还没派过任何子 Agent：总量帽原样剩满，且**不因查询而建闸**。
    assert.equal(snapshot.remainingDispatchBudget, 32)
  })

  void test('omitted max_concurrency takes the dispatcher limit, not a workflow constant', async () => {
    // 宿主把并发调到 6：曾经 schema 默认值 4 + workflow 常量 4 会把它按死在 4。
    const { runtime, probe } = buildRuntime({
      maxConcurrentSubAgents: 6,
      maxSubAgentsPerExecution: 32,
      remainingDispatchBudget: 32,
    })
    const result = await runtime.run(parallelDefinition(6), { runId: 'run-1' })
    assert.equal(result.effective_limits.max_concurrency, 6)
    assert.equal(probe.peakConcurrency, 6)
  })

  void test('declared max_concurrency can only lower, never raise, the real limit', async () => {
    const { runtime, probe } = buildRuntime({
      maxConcurrentSubAgents: 2,
      maxSubAgentsPerExecution: 32,
      remainingDispatchBudget: 32,
    })
    // 模型申请 4，信号量只有 2——回显必须是 2（这正是考古里"写着 4 实际卡住"的那一格）。
    const result = await runtime.run(parallelDefinition(4, { max_concurrency: 4 }), { runId: 'run-2' })
    assert.equal(result.effective_limits.max_concurrency, 2)
    assert.ok(probe.peakConcurrency <= 2)

    const lowered = buildRuntime({
      maxConcurrentSubAgents: 8,
      maxSubAgentsPerExecution: 32,
      remainingDispatchBudget: 32,
    })
    const loweredResult = await lowered.runtime.run(parallelDefinition(4, { max_concurrency: 1 }), {
      runId: 'run-3',
    })
    assert.equal(loweredResult.effective_limits.max_concurrency, 1)
    assert.equal(lowered.probe.peakConcurrency, 1)
  })

  void test('max_agents is capped by the execution-level dispatch budget that is already spent', async () => {
    // 父 Agent 先派了后台子 Agent，总量帽只剩 3；workflow 的 8 名额预算必须跟着缩。
    const { runtime } = buildRuntime({
      maxConcurrentSubAgents: 4,
      maxSubAgentsPerExecution: 32,
      remainingDispatchBudget: 3,
    })
    const result = await runtime.run(parallelDefinition(6, { max_agents: 8 }), { runId: 'run-4' })
    assert.equal(result.effective_limits.max_agents, 3)
    // 预算耗尽是自限终止，落成 budget_exhausted 而不是一串"节点失败"。
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(result.agent_count, 3)
  })

  void test('an exhausted budget stops before the first dispatch instead of faking a node failure', async () => {
    const { runtime, probe } = buildRuntime({
      maxConcurrentSubAgents: 4,
      maxSubAgentsPerExecution: 32,
      remainingDispatchBudget: 0,
    })
    const result = await runtime.run(parallelDefinition(2), { runId: 'run-5' })
    assert.equal(result.effective_limits.max_agents, 0)
    assert.equal(result.status, 'budget_exhausted')
    assert.deepEqual(probe.dispatched, [])
  })

  void test('fail_fast still leaves skipped placeholders (runner scheduling was not replaced by unlimited lanes)', async () => {
    const { runtime } = buildRuntime(
      { maxConcurrentSubAgents: 1, maxSubAgentsPerExecution: 32, remainingDispatchBudget: 32 },
      { failCallIds: ['call-1'] }
    )
    const definition = parallelDefinition(3) as AgentWorkflowDefinition
    const step = definition.steps[0]!
    assert.equal(step.operation, 'parallel')
    ;(step as { failure_policy: string }).failure_policy = 'fail_fast'

    const result = await runtime.run(definition, { runId: 'run-6' })
    const calls = result.steps[0]?.output as readonly AgentWorkflowAgentResult[]
    assert.equal(calls.length, 3)
    assert.equal(calls[0]?.status, 'failed')
    // 未启动的条目必须留占位；无限 runner 会让这两条变成"跑过且失败"，模型无从判断要不要重跑。
    assert.equal(calls[1]?.status, 'skipped')
    assert.equal(calls[2]?.status, 'skipped')
  })
})
