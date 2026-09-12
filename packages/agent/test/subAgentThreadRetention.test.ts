// 域：子 Agent 线程跨执行保留与续跑的回归。
//
// 钉死的判决：主 Agent 续跑一个已派过的子 Agent 时，子 Agent 带着之前读过的上下文接着干——线程在
// 执行结束后按父会话有限保留（TTL / 条数 / 体积），续跑挂到新执行上；查无此线程时明确失败，
// 绝不静默新建一个空白 worker。模型面的引导（工具描述、thread_id 参数、运行时提示词、失败引导）
// 同步写明「优先复用，只在需要独立上下文时新派」。
import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import type { AgentExecutionLimitOverrides } from '../src/agent/ExecutionLimits'
import { SubAgentGuidanceRelayRegistry } from '../src/execution'
import type { SubAgentDispatchInput, SubAgentQueryOptions } from '../src/kernel/dispatch/host-ports'
import { formatSubAgentFailureRedispatchGuidance } from '../src/kernel/dispatch/result-format'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import { createRuntimePromptSegments, type RuntimePromptSnapshot } from '../src/prompts'
import type { SubAgentSessionStatus, SubAgentTaskResult } from '../src/protocol'
import {
  parseSubAgentToolResult,
  SubAgentSessionStore,
  type SubAgentThreadRetentionLimits,
  type SubAgentTypeDescriptor,
} from '../src/sub-agent'
import { TeamModelRouter, WriteLeaseCoordinator } from '../src/team'
import { dispatchAgentSchema } from '../src/tool-library/builtin/DispatchAgent'
import { dispatchAgentTools } from '../src/tool-library/builtin/DispatchAgent.tool'

interface WorkerCall {
  task: string
  initialHistory: ModelMessage[]
  options: SubAgentQueryOptions
}

type WorkerBehavior = (call: WorkerCall) => Promise<string>

interface DispatchTarget {
  sessionId?: string
  resourceId?: string
}

function parse(text: string): SubAgentTaskResult {
  const result = parseSubAgentToolResult(text)
  if (!result) throw new Error(`missing <subagent-result> envelope:\n${text}`)
  return result
}

/** 像真实 QueryLoop 一样在收尾时回写历史：旧历史 + 本次指令 + 本次回答。 */
function answer(call: WorkerCall, text: string): string {
  call.options.onHistoryUpdate?.([
    ...call.initialHistory,
    { role: 'user', content: call.task },
    { role: 'assistant', content: text },
  ])
  return text
}

function waitForAbort(signal: LooseOptional<AbortSignal>): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new AppError('EXECUTION_ABORTED', '子 Agent 运行被终止。')),
      { once: true }
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createHarness(options: { limits?: AgentExecutionLimitOverrides } = {}) {
  const descriptor: SubAgentTypeDescriptor = {
    id: 'general',
    workerType: 'general',
    roleId: 'operator',
    routeCategory: 'general',
    workerPhase: 'implementation',
    toolCategories: ['general'],
    toolNames: [],
    resourceLeaseScope: null,
    readonlyDefault: false,
    promptAppend: null,
  }
  const relay = new SubAgentGuidanceRelayRegistry()
  const dispatcher = new SubAgentDispatcher(
    new TeamModelRouter({
      resolve: () => ({
        runtimeOverride: { provider: (() => undefined) as never, providerId: 'probe', model: 'probe' },
        trace: null,
      }),
    }),
    new WriteLeaseCoordinator(),
    {
      systemConfig: {
        thinkingDepth: 'balanced',
        disabledToolNames: [],
        prompt: { segmentOverrides: [] },
        advancedRuntime: {},
        modelRuntimeContext: { host: 'probe' },
      },
      chatConfig: { modelSelection: { hostModel: 'probe' }, systemPromptAppend: '' },
    },
    relay,
    {
      defaultTypeId: 'general',
      getDescriptor: (id) => (id === 'general' ? descriptor : null),
      listDescriptors: () => [descriptor],
    },
    undefined,
    undefined,
    undefined,
    options.limits ?? {}
  )
  const calls: WorkerCall[] = []
  let behavior: WorkerBehavior = async (call) => answer(call, `worker answer ${calls.length}`)
  dispatcher.bindAgentRunner({
    query: async (task, _parentCtx, queryOptions) => {
      const call: WorkerCall = {
        task,
        initialHistory: queryOptions.initialHistory ?? [],
        options: queryOptions,
      }
      calls.push(call)
      return behavior(call)
    },
  })

  const run = (
    executionId: string,
    input: SubAgentDispatchInput,
    target: DispatchTarget = {}
  ): Promise<string> =>
    dispatcher.dispatch({
      input,
      parentCtx: {
        abortSignal: new AbortController().signal,
        sessionId: target.sessionId ?? 'parent-session',
        resourceId: target.resourceId,
        codingSession: {
          getEnabledToolCategories: () => ['general'],
          enableToolCategories: (categories) => categories,
        },
        execution: null,
      },
      events: new ExecutionEventBus(),
      config: { execution: { executionId } } as never,
    })

  return {
    dispatcher,
    relay,
    calls,
    behave: (next: WorkerBehavior) => {
      behavior = next
    },
    /** 与 agent:dispatch 新建线程时补的默认值一致。 */
    spawn: (
      executionId: string,
      prompt: string,
      target: DispatchTarget & Partial<SubAgentDispatchInput> = {}
    ) => {
      const { sessionId, resourceId, ...input } = target
      return run(
        executionId,
        {
          agentName: 'Scout',
          subagentType: 'general',
          toolScope: 'type_default',
          toolCategories: [],
          prompt,
          ...input,
        },
        { sessionId, resourceId }
      )
    },
    /** 与 agent:dispatch 续跑时一致：只带 thread_id 与追加任务，其余从线程继承。 */
    resume: (
      executionId: string,
      threadId: string,
      prompt: string,
      target: DispatchTarget & Partial<SubAgentDispatchInput> = {}
    ) => {
      const { sessionId, resourceId, ...input } = target
      return run(executionId, { threadId, prompt, ...input }, { sessionId, resourceId })
    },
    interrupt: (executionId: string, threadId: string) =>
      run(executionId, { threadId, prompt: '', interrupt: true }),
  }
}

describe('sub-agent threads survive the execution that dispatched them', () => {
  test('continues a finished worker in the next execution of the same parent session', async () => {
    const harness = createHarness()
    const first = parse(await harness.spawn('exec-1', 'Inspect src/auth and report the risks.'))
    expect(first.status).toBe('completed')
    expect(first.resumable).toBe(true)
    expect(first.retained_until).toBeGreaterThan(Date.now())
    // Desktop 的 AgentRunner 在每轮结束的 finally 里就这么调。
    harness.dispatcher.clearExecution('exec-1')

    // 新一轮先派一个别的 worker，它收尾后本执行的进展账本里就有「已知上下文」可注入。
    await harness.spawn('exec-2', 'Summarize the session refresh module.')
    let attachedToResumingExecution = false
    harness.behave(async (call) => {
      attachedToResumingExecution = harness.relay
        .listActiveWorkers('exec-2')
        .some((worker) => worker.threadId === first.thread_id)
      return answer(call, 'refresh path checked')
    })
    const resumed = parse(
      await harness.resume('exec-2', first.thread_id, 'Also check the token refresh path.')
    )
    expect(resumed).toMatchObject({ status: 'completed', thread_id: first.thread_id, resumable: true })
    expect(attachedToResumingExecution).toBe(true)

    const followUp = harness.calls[2]!
    expect(followUp.initialHistory).toHaveLength(2)
    expect(followUp.task).toContain('Also check the token refresh path.')
    expect(followUp.task).toContain('自上次运行后文件可能已变化，修改前先重新读取')
    // 续跑不重复首次派发的外壳，也不注入「已知上下文」前缀——它们都在线程历史里。
    expect(followUp.task).not.toContain('子任务：')
    expect(followUp.task).not.toContain('初始授权工具分类')
    expect(followUp.task).not.toContain('【已知上下文')
    // 同一时刻新派的 worker 照常拿到「已知上下文」前缀：上面没拿到是续跑刻意不给。
    harness.behave(async (call) => answer(call, 'fresh worker'))
    await harness.spawn('exec-2', 'Review the logout flow.')
    expect(harness.calls[3]!.task).toContain('【已知上下文')

    // 线程已挂到 exec-2：它收尾后照样保留，下一轮还能接着续。
    harness.dispatcher.clearExecution('exec-2')
    expect(parse(await harness.resume('exec-3', first.thread_id, 'One last check.')).status).toBe(
      'completed'
    )
    expect(harness.calls[4]!.initialHistory).toHaveLength(4)
  })

  test('a resumed worker is interruptible through the execution that resumed it', async () => {
    const harness = createHarness()
    const first = parse(await harness.spawn('exec-1', 'Inspect the build scripts.'))
    harness.dispatcher.clearExecution('exec-1')

    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    harness.behave(async (call) => {
      markStarted()
      return waitForAbort(call.options.workerAbortSignal)
    })
    const running = harness.resume('exec-2', first.thread_id, 'Run the slow verification.')
    await started
    // 原执行已经摸不到它。
    expect(parse(await harness.interrupt('exec-1', first.thread_id)).summary).toContain('不在运行中')
    expect(parse(await harness.interrupt('exec-2', first.thread_id)).status).toBe('aborted')
    expect(parse(await running)).toMatchObject({ status: 'aborted', resumable: true })
  })

  test('a host without an execution port keys each run with the request executionId', async () => {
    const harness = createHarness()
    let registeredUnderRun = false
    harness.behave(async (call) => {
      registeredUnderRun = harness.relay.listActiveWorkers('run-1').length === 1
      return answer(call, 'done')
    })
    const text = await harness.dispatcher.dispatch({
      input: {
        agentName: 'Forge',
        subagentType: 'general',
        toolScope: 'type_default',
        toolCategories: [],
        prompt: 'Inspect the project.',
      },
      parentCtx: {
        abortSignal: new AbortController().signal,
        sessionId: 'portless-session',
        codingSession: { getEnabledToolCategories: () => [], enableToolCategories: (c) => c },
        execution: null,
      },
      events: new ExecutionEventBus(),
      config: {},
      executionId: 'run-1',
    })
    expect(registeredUnderRun).toBe(true)
    expect(harness.dispatcher.describeExecutionLimits({ executionId: 'run-1', sessionId: 'portless-session' }))
      .toMatchObject({ remainingDispatchBudget: 31 })
    harness.dispatcher.clearExecution('run-1')
    expect(harness.dispatcher.describeExecutionLimits({ executionId: 'run-1', sessionId: 'portless-session' }))
      .toMatchObject({ remainingDispatchBudget: 32 })
    const resumed = await harness.dispatcher.dispatch({
      input: { threadId: parse(text).thread_id, prompt: 'Continue.' },
      parentCtx: {
        abortSignal: new AbortController().signal,
        sessionId: 'portless-session',
        codingSession: { getEnabledToolCategories: () => [], enableToolCategories: (c) => c },
        execution: null,
      },
      events: new ExecutionEventBus(),
      config: {},
      executionId: 'run-2',
    })
    expect(parse(resumed).status).toBe('completed')
  })
})

describe('continuing a thread that is not there', () => {
  test('an unknown thread id fails clearly and never spawns a blank worker', async () => {
    const harness = createHarness()
    const result = parse(await harness.resume('exec-1', 'subagent:missing', 'Keep going.'))
    expect(result).toMatchObject({
      status: 'failed',
      thread_id: 'subagent:missing',
      resumable: false,
    })
    expect(result.summary).toContain('已不存在')
    expect(result.summary).toContain('不带 thread_id 重新派发')
    expect(harness.calls).toHaveLength(0)

    const interrupt = parse(await harness.interrupt('exec-1', 'subagent:missing'))
    expect(interrupt.status).toBe('failed')
    expect(interrupt.summary).toContain('未找到子智能体线程 subagent:missing')
    expect(harness.calls).toHaveLength(0)
  })

  test('the idle TTL runs only after the execution ends, then the thread expires', async () => {
    const harness = createHarness({ limits: { subAgentRetainedThreadIdleTtlMs: 20 } })
    const first = parse(await harness.spawn('exec-1', 'Inspect the router.'))
    // 仍挂在进行中的执行上：不按空闲 TTL 过期。
    await sleep(40)
    expect(parse(await harness.resume('exec-1', first.thread_id, 'Follow up.')).status).toBe(
      'completed'
    )
    harness.dispatcher.clearExecution('exec-1')
    await sleep(40)
    const expired = parse(await harness.resume('exec-2', first.thread_id, 'Follow up again.'))
    expect(expired).toMatchObject({ status: 'failed', resumable: false })
    expect(expired.summary).toContain('已不存在')
    expect(harness.calls).toHaveLength(2)
  })

  test('only the most recently used threads of a parent session are retained', async () => {
    const harness = createHarness({ limits: { subAgentRetainedThreadsPerSession: 2 } })
    const a = parse(await harness.spawn('exec-1', 'Task A.'))
    const b = parse(await harness.spawn('exec-1', 'Task B.'))
    const c = parse(await harness.spawn('exec-1', 'Task C.'))
    // 续跑一次 A：B 成了最久未用的那条。
    await harness.resume('exec-1', a.thread_id, 'Refine A.')
    harness.dispatcher.clearExecution('exec-1')

    expect(parse(await harness.resume('exec-2', b.thread_id, 'Refine B.')).summary).toContain(
      '已不存在'
    )
    expect(parse(await harness.resume('exec-2', a.thread_id, 'Refine A again.')).status).toBe(
      'completed'
    )
    expect(parse(await harness.resume('exec-2', c.thread_id, 'Refine C.')).status).toBe(
      'completed'
    )
  })

  test('a history over the size cap is not resumable and not retained', async () => {
    const harness = createHarness({ limits: { subAgentRetainedHistoryMaxChars: 200 } })
    harness.behave(async (call) => answer(call, 'x'.repeat(500)))
    const big = parse(await harness.spawn('exec-1', 'Produce the long report.'))
    expect(big).toMatchObject({ status: 'completed', resumable: false })
    expect(big.retained_until).toBeUndefined()

    const sameExecution = parse(await harness.resume('exec-1', big.thread_id, 'Continue.'))
    expect(sameExecution).toMatchObject({ status: 'failed', resumable: false })
    expect(sameExecution.summary).toContain('上下文已经过大')

    harness.dispatcher.clearExecution('exec-1')
    expect(parse(await harness.resume('exec-2', big.thread_id, 'Continue.')).summary).toContain(
      '已不存在'
    )
    expect(harness.calls).toHaveLength(1)
  })

  test('a thread can only be continued from its own parent session and resource', async () => {
    const harness = createHarness()
    const first = parse(await harness.spawn('exec-1', 'Inspect.', { resourceId: '/work/app' }))
    harness.dispatcher.clearExecution('exec-1')

    const otherSession = parse(
      await harness.resume('exec-2', first.thread_id, 'Continue.', {
        sessionId: 'other-session',
        resourceId: '/work/app',
      })
    )
    expect(otherSession.status).toBe('failed')
    expect(otherSession.summary).toContain('parent session')
    const otherResource = parse(
      await harness.resume('exec-2', first.thread_id, 'Continue.', { resourceId: '/work/other' })
    )
    expect(otherResource.status).toBe('failed')
    expect(otherResource.summary).toContain('当前资源是 "/work/other"')
    expect(harness.calls).toHaveLength(1)

    // 被拒的续跑不消耗线程。
    expect(
      parse(await harness.resume('exec-2', first.thread_id, 'Continue.', { resourceId: '/work/app' }))
        .status
    ).toBe('completed')
  })
})

describe('abnormally ended threads', () => {
  test('a failed thread is resumable and the worker is told its last run failed', async () => {
    const harness = createHarness()
    harness.behave(async (call) => {
      call.options.onHistoryUpdate?.([
        { role: 'user', content: call.task },
        { role: 'assistant', content: 'Edited half of the files.' },
      ])
      throw new AppError('RUNTIME', 'provider exploded mid-run')
    })
    const failed = parse(await harness.spawn('exec-1', 'Refactor the auth module.'))
    expect(failed).toMatchObject({ status: 'failed', resumable: true })
    expect(failed.summary).toContain(`thread_id="${failed.thread_id}" 续跑`)
    harness.dispatcher.clearExecution('exec-1')

    harness.behave(async (call) => answer(call, 'Refactor finished.'))
    expect(parse(await harness.resume('exec-2', failed.thread_id, 'Finish the refactor.')).status).toBe(
      'completed'
    )
    const followUp = harness.calls[1]!
    expect(followUp.initialHistory).toHaveLength(2)
    expect(followUp.task).toContain('上次的运行异常结束')
    expect(followUp.task).toContain('provider exploded mid-run')
    expect(followUp.task).toContain('先核对当前实际状态')
    // 失败结果里给父 Agent 的重派引导不回灌给子 Agent。
    expect(followUp.task).not.toContain('下一步建议（按优先级）')
  })

  test('a worker stopped by the end of its execution can be continued in the next one', async () => {
    const harness = createHarness()
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    harness.behave(async (call) => {
      call.options.onHistoryUpdate?.([
        { role: 'user', content: call.task },
        { role: 'assistant', content: 'Migrated two of five loaders.' },
      ])
      markStarted()
      return waitForAbort(call.options.workerAbortSignal)
    })
    const running = harness.spawn('exec-1', 'Migrate the config loaders.')
    await started
    // 用户按了停止：执行收尾会中断仍在跑的 worker。
    harness.dispatcher.clearExecution('exec-1')
    const stopped = parse(await running)
    expect(stopped).toMatchObject({ status: 'aborted', resumable: true })

    harness.behave(async (call) => answer(call, 'All loaders migrated.'))
    expect(parse(await harness.resume('exec-2', stopped.thread_id, 'Go on.')).status).toBe(
      'completed'
    )
    expect(harness.calls[1]!.task).toContain('上次的运行被中断')
    expect(harness.calls[1]!.initialHistory).toHaveLength(2)
  })

  test('a thread that failed before its first turn has nothing to continue', async () => {
    const harness = createHarness()
    harness.behave(async () => {
      throw new AppError('RUNTIME', 'model route rejected the request')
    })
    const early = parse(await harness.spawn('exec-1', 'Scan the repository.'))
    expect(early).toMatchObject({ status: 'failed', resumable: false })
    expect(early.summary).toContain('没有可续跑的上下文')

    const retry = parse(await harness.resume('exec-1', early.thread_id, 'Try again.'))
    expect(retry).toMatchObject({ status: 'failed', resumable: false })
    expect(retry.summary).toContain('没有可续跑的上下文')
    expect(harness.calls).toHaveLength(1)
  })
})

describe('parent session release and inherited settings', () => {
  test('releasing a parent session drops its threads and stops its running workers', async () => {
    const harness = createHarness()
    const foreign = parse(await harness.spawn('exec-other', 'Other task.', { sessionId: 'other-session' }))
    const retained = parse(await harness.spawn('exec-1', 'Inspect.'))
    harness.dispatcher.clearExecution('exec-1')

    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    harness.behave(async (call) => {
      markStarted()
      return waitForAbort(call.options.workerAbortSignal)
    })
    const running = harness.spawn('exec-2', 'Long task.')
    await started
    harness.dispatcher.releaseParentSession('parent-session')
    expect(parse(await running)).toMatchObject({ status: 'aborted', resumable: false })

    expect(parse(await harness.resume('exec-3', retained.thread_id, 'Continue.')).summary).toContain(
      '已不存在'
    )
    harness.behave(async (call) => answer(call, 'still here'))
    expect(
      parse(await harness.resume('exec-other', foreign.thread_id, 'Continue.', { sessionId: 'other-session' }))
        .status
    ).toBe('completed')
  })

  test('a resumed worker keeps its effort unless the resume overrides it', async () => {
    const harness = createHarness()
    const first = parse(await harness.spawn('exec-1', 'Deep analysis.', { effort: 'deep' }))
    await harness.resume('exec-1', first.thread_id, 'Continue.')
    await harness.resume('exec-1', first.thread_id, 'Quick follow-up.', { effort: 'fast' })
    await harness.resume('exec-1', first.thread_id, 'Another follow-up.')
    expect(harness.calls.map((call) => call.options.runtimeOverride?.thinkingDepth)).toEqual([
      'deep',
      'deep',
      'fast',
      'fast',
    ])
  })
})

describe('SubAgentSessionStore retention bookkeeping', () => {
  function createStore(limits: Partial<SubAgentThreadRetentionLimits> = {}) {
    let now = 1_000
    const store = new SubAgentSessionStore({
      limits: {
        subAgentRetainedThreadsPerSession: 8,
        subAgentRetainedThreadsTotal: 64,
        subAgentRetainedThreadIdleTtlMs: 1_000,
        subAgentRetainedHistoryMaxChars: 10_000,
        ...limits,
      },
      now: () => now,
    })
    const addThread = (
      threadId: string,
      options: {
        executionId?: string
        parentSessionId?: string
        status?: SubAgentSessionStatus
        history?: ModelMessage[]
      } = {}
    ): void => {
      store.createSession({
        threadId,
        executionId: options.executionId ?? 'exec-1',
        parentSessionId: options.parentSessionId ?? 'parent',
        subagentType: 'general',
        prompt: `task ${threadId}`,
      })
      store.setHistory(
        threadId,
        options.history ?? [
          { role: 'user', content: `task ${threadId}` },
          { role: 'assistant', content: 'done' },
        ]
      )
      store.setStatus(threadId, options.status ?? 'completed')
    }
    return {
      store,
      addThread,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('the idle TTL starts when the thread leaves its execution', () => {
    const { store, addThread, advance } = createStore()
    addThread('t1')
    advance(5_000)
    store.prune()
    expect(store.getSession('t1')).not.toBeNull()

    store.clearExecution('exec-1')
    expect(store.describeRetention('t1')).toEqual({ resumable: true, retainedUntil: 7_000 })
    advance(1_000)
    store.prune()
    expect(store.getSession('t1')).not.toBeNull()
    advance(1)
    store.prune()
    expect(store.getSession('t1')).toBeNull()
  })

  test('evicts the least recently used detached threads per parent session, then in total', () => {
    const { store, addThread } = createStore({
      subAgentRetainedThreadsPerSession: 2,
      subAgentRetainedThreadsTotal: 3,
    })
    addThread('a1')
    addThread('a2')
    addThread('a3')
    addThread('b1', { parentSessionId: 'other' })
    addThread('b2', { parentSessionId: 'other' })
    // 续跑挂靠算一次使用：a1 成了 parent 里最近用过的。
    store.attachToExecution('a1', 'exec-1')
    store.clearExecution('exec-1')
    // 每父会话 2 条：parent 留 a1、a3；全局 3 条：再挤掉最久未用的 a3。
    expect(['a1', 'a2', 'a3', 'b1', 'b2'].filter((id) => store.getSession(id))).toEqual([
      'a1',
      'b1',
      'b2',
    ])
  })

  test('threads without resumable context are dropped when they leave the execution', () => {
    const { store, addThread } = createStore({ subAgentRetainedHistoryMaxChars: 50 })
    addThread('empty', { history: [], status: 'failed' })
    addThread('huge', { history: [{ role: 'user', content: 'x'.repeat(100) }] })
    addThread('fine')
    addThread('running', { history: [], status: 'running' })
    expect(store.describeRetention('empty')).toEqual({ resumable: false, reason: 'empty-history' })
    expect(store.describeRetention('huge')).toEqual({ resumable: false, reason: 'history-too-large' })
    expect(store.describeRetention('missing')).toEqual({ resumable: false, reason: 'not-found' })

    store.clearExecution('exec-1')
    expect(store.getSession('empty')).toBeNull()
    expect(store.getSession('huge')).toBeNull()
    expect(store.getSession('fine')).not.toBeNull()
    // 执行收尾时还在跑的线程等它收尾再判可续跑性。
    expect(store.getSession('running')).not.toBeNull()
    store.setHistory('running', [
      { role: 'user', content: 'task running' },
      { role: 'assistant', content: 'partial' },
    ])
    store.setStatus('running', 'aborted')
    store.prune()
    expect(store.describeRetention('running').resumable).toBe(true)
  })

  test('re-attaching moves a thread onto the resuming execution', () => {
    const { store, addThread } = createStore()
    addThread('t1')
    store.clearExecution('exec-1')
    expect(store.listByExecution('exec-1')).toEqual([])
    expect(store.attachToExecution('t1', 'exec-2')).toBe(true)
    expect(store.listByExecution('exec-2').map((session) => session.thread_id)).toEqual(['t1'])
    expect(store.getSession('t1')?.execution_id).toBe('exec-2')
    expect(store.attachToExecution('missing', 'exec-2')).toBe(false)
  })

  test('releasing a parent session reports where its live threads run and ignores late writes', () => {
    const { store, addThread } = createStore()
    addThread('old')
    store.clearExecution('exec-1')
    addThread('live', { executionId: 'exec-2' })
    addThread('foreign', { parentSessionId: 'other', executionId: 'exec-3' })

    expect(store.releaseParentSession('parent')).toEqual([
      { threadId: 'old', executionId: null },
      { threadId: 'live', executionId: 'exec-2' },
    ])
    expect(store.getSession('old')).toBeNull()
    expect(store.getSession('live')).toBeNull()
    expect(store.listByExecution('exec-2')).toEqual([])
    expect(store.getSession('foreign')).not.toBeNull()
    // 仍在收尾的 worker 晚到的回写不许把线程复活。
    store.setHistory('live', [{ role: 'user', content: 'late write' }])
    expect(store.getHistory('live')).toEqual([])
    expect(store.describeRetention('live')).toEqual({ resumable: false, reason: 'not-found' })
  })
})

describe('dispatch guidance prefers continuing a worker', () => {
  function renderSubAgentDispatchSegment(): string {
    const snapshot: RuntimePromptSnapshot = {
      locale: 'zh-CN',
      roleId: 'chat',
      roleLabel: 'Chat',
      workflowType: 'chat',
      thinkingDepth: 'balanced',
      developerContext: null,
      agentSurfaceId: 'chat',
      contextPhase: 'operational',
      activeCapabilityScope: 'system',
      toolCategories: ['agent-control'],
      toolSurfaceProfile: 'full',
      runProfile: 'balanced',
      toolCapabilityCategories: [
        {
          id: 'agent-control',
          label: 'Agent control',
          description: 'Sub-agent dispatch',
          enabled: true,
          toolOsDefaultState: 'resident',
          tools: [{ name: 'agent:dispatch', description: 'dispatch' }],
          hiddenToolCount: 0,
        },
      ],
      requestableToolCapabilityCategories: [],
      canUpdatePlan: false,
      userRequestedPlan: false,
      goalMode: false,
      selectedPromptFeatureLabels: [],
      enabledPromptFeatures: [],
      autoPromptFeatureLabels: [],
      availableSkills: [],
      customSubAgents: [],
      executionPlanPreview: null,
      currentExecutionAdvice: null,
      recentToolFailures: [],
      hasCompactedContext: false,
    }
    const segment = createRuntimePromptSegments(snapshot).find(
      (candidate) => candidate.id === 'runtime.sub-agent-dispatch'
    )
    expect(segment?.when?.() ?? true).toBe(true)
    return String(segment?.render({}))
  }

  test('every model-facing surface states reuse first and fresh only for independent context', () => {
    const description = dispatchAgentTools['agent:dispatch'].description
    expect(description).toContain('优先复用')
    expect(description).toContain('修复后复验')
    expect(description).toContain('复验就续跑原验证者')
    expect(description).toContain('不让产出者复核自己的产出')
    expect(description).toContain('默认不派')
    expect(description).toContain('resumable=true 可带 thread_id 续跑')

    const threadIdDescription = String(dispatchAgentSchema.shape.thread_id.description)
    expect(threadIdDescription).toContain('优先带它续跑')
    expect(threadIdDescription).toContain('过期后续跑会明确报错')

    const runtimeSegment = renderSubAgentDispatchSegment()
    expect(runtimeSegment).toContain('优先复用已派的子 Agent')
    expect(runtimeSegment).toContain('复验就续跑原来的验证者')
    expect(runtimeSegment).toContain('不要让产出者复核自己的产出')
    expect(runtimeSegment).toContain('过期续跑会明确报错')

    expect(formatSubAgentFailureRedispatchGuidance('subagent:t', true)).toContain(
      'thread_id="subagent:t" 续跑'
    )
    expect(formatSubAgentFailureRedispatchGuidance('subagent:t', false)).toContain(
      '没有可续跑的上下文'
    )
  })
})
