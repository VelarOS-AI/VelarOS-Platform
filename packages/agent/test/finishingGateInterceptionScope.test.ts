// 用途：锁定收尾门的拦截边界，避免把提示词层工作流重新变成运行时强制门。
//
// 收尾门只许拦「不可逆的伤害」或「已证明的空转」，永远不许拦「我希望模型按某个流程走」。
// 两条已移除的流程门在这里防止回归：
//  ① `execution-plan-required`——计划步骤没收束就不许收尾（连拦三轮把会话判 error）；
//  ② 模型自建 goal 反向锁死会话——收尾门只在用户**显式**开启目标模式时才生效。
// 已移除的方案模式也不得通过执行模式注册表复活。
import { describe, expect, test } from 'bun:test'

import { runSoloFinishingGate } from '../src/agent/SoloFinishingGate'
import { listExecutionModes, resolveExecutionModeForPromptFeature } from '../src/execution-modes'

function createFinishingGateHarness(options: {
  unresolvedPlanSteps?: boolean
  goalExists?: boolean
}) {
  const history: unknown[] = []
  const toolContext = {
    execution: {
      getCurrentPlan: () =>
        options.unresolvedPlanSteps
          ? [
              { id: 'step-1', title: '改造认证层', status: 'pending' },
              { id: 'step-2', title: '迁移调用方', status: 'in_progress' },
            ]
          : [],
    },
    codingSession: {
      // 计划特性开着：旧门的准入条件，用来证明「不是因为没权限才没拦」。
      hasPromptFeatureAccess: () => true,
    },
  }

  return {
    history,
    input: {
      turn: 1,
      history: history as never,
      toolContext,
      events: { emitRuntime: () => undefined },
      abortSignal: new AbortController().signal,
      emitAbort: () => undefined,
      tickLoopReminders: async () => [],
      runAutomaticVerification: async () => ({}) as never,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      },
    },
  }
}

void describe('finishing gate no longer intercepts workflow discipline', () => {
  void test('missing runtime evidence cannot block an actionable request from finishing', async () => {
    const harness = createFinishingGateHarness({})
    harness.history.push({
      role: 'user',
      content:
        '你在当前会话中写入一个长期偏好：需要动手时先向我提交方案，得到批准后再执行。',
    })

    const result = await runSoloFinishingGate(harness.input)

    expect(result.status).toBe('completed')
    expect(harness.history).toHaveLength(1)
  })

  void test('unresolved execution plan steps do not block the turn from completing', async () => {
    const harness = createFinishingGateHarness({ unresolvedPlanSteps: true })
    const result = await runSoloFinishingGate(harness.input)

    expect(result.status).toBe('completed')
    // 不许改成「放行但仍塞一条系统提醒」：那仍然是运行时在替提示词说话。
    expect(harness.history).toHaveLength(0)
  })

  void test('a goal the model created itself cannot lock the session when goal mode is off', async () => {
    const harness = createFinishingGateHarness({})
    const result = await runSoloFinishingGate({
      ...harness.input,
      // 用户没开目标模式；模型自建的目标仍是 active（非终态）。
      goalMode: false,
      inspectGoalState: async () => ({
        exists: true,
        terminal: false,
        status: 'active' as const,
      }),
    })

    expect(result.status).toBe('completed')
  })

  void test('an explicitly requested goal mode still gates on goal status', async () => {
    const harness = createFinishingGateHarness({})
    const result = await runSoloFinishingGate({
      ...harness.input,
      goalMode: true,
      inspectGoalState: async () => ({
        exists: true,
        terminal: false,
        status: 'active' as const,
      }),
    })

    expect(result.status).toBe('continue')
    expect(result.status === 'continue' ? result.reason : null).toBe('goal-status-required')
  })

  void test('background completion boundary runs before runtime input sealing and goal completion', async () => {
    const harness = createFinishingGateHarness({})
    let takeOrSealCalls = 0
    let goalCompletionCalls = 0
    let goalInspectionCalls = 0
    const result = await runSoloFinishingGate({
      ...harness.input,
      runtimeInput: {
        take: () => null,
        takeOrSeal: () => {
          takeOrSealCalls += 1
          return { status: 'sealed' as const }
        },
        onInputAccepted: () => () => undefined,
      },
      settlePendingBackgroundJobs: async () => ({
        status: 'continue' as const,
        reason: 'background-terminal' as const,
      }),
      goalMode: true,
      completeGoalOnSuccessfulFinish: async () => {
        goalCompletionCalls += 1
      },
      inspectGoalState: async () => {
        goalInspectionCalls += 1
        return { exists: true, terminal: true, status: 'complete' as const }
      },
    })

    expect(result).toEqual({ status: 'continue', reason: 'background-task' })
    expect(takeOrSealCalls).toBe(0)
    expect(goalCompletionCalls).toBe(0)
    expect(goalInspectionCalls).toBe(0)
  })

  void test('goal completion is committed once only after the background boundary reports ready', async () => {
    const harness = createFinishingGateHarness({})
    const order: string[] = []
    const result = await runSoloFinishingGate({
      ...harness.input,
      settlePendingBackgroundJobs: async () => {
        order.push('background-ready')
        return { status: 'ready' as const }
      },
      goalMode: true,
      completeGoalOnSuccessfulFinish: async () => {
        order.push('goal-complete')
      },
      inspectGoalState: async () => {
        order.push('goal-inspect')
        return { exists: true, terminal: true, status: 'complete' as const }
      },
    })

    expect(result).toEqual({ status: 'completed' })
    expect(order).toEqual(['background-ready', 'goal-complete', 'goal-inspect'])
  })

  void test('execution abort during background park settles as aborted, never completed', async () => {
    const harness = createFinishingGateHarness({})
    const controller = new AbortController()
    let abortEvents = 0
    controller.abort('stop')
    const result = await runSoloFinishingGate({
      ...harness.input,
      abortSignal: controller.signal,
      emitAbort: () => {
        abortEvents += 1
      },
      settlePendingBackgroundJobs: async () => ({ status: 'interrupted' as const }),
    })

    expect(result).toEqual({ status: 'aborted' })
    expect(abortEvents).toBe(1)
  })
})

void describe('proposal is no longer an execution mode', () => {
  void test('registry exposes only goal and plan', () => {
    expect(listExecutionModes().map((descriptor) => descriptor.id)).toEqual(['goal', 'plan'])
  })

  void test('the retired prompt feature resolves to no mode', () => {
    expect(resolveExecutionModeForPromptFeature('proposal')).toBeNull()
  })
})
