// 域：mod 拦截 seam 的「工具缝」端到端探针（批 A2）。
//
// 批 A 把 tool-call:before / tool-result:after 的派发点接进了 ToolExecutor，但装配链上
// SoloStreamLoop 建 ToolExecutor 时没透传派发器——注册进来的钩子在工具缝上永远收不到派发。
// 本探针从**装配面**（构造 SoloStreamLoop 时注入派发器）出发跑完整一轮，逼真到工具真被执行，
// 断言两个钩子都被派发、改写生效；再跑一遍不注入的对照组，断言零扰动。
import { describe, expect, test } from 'bun:test'

import { logRuntime } from '@velaros-ai/core/logger'

import { AgentModSeamDispatcher, SoloStreamLoop } from '../src'

const ProbeToolName = 'probe_echo'
const ProbeSessionId = 'session-probe'

interface ProbeRun {
  status: string
  /** 工具实体真正收到的入参（用于验证 before 钩子的改写确实过了完整校验管线）。 */
  executedArgs: Array<Record<string, unknown>>
  /** 本轮 ToolExecutor 收敛出的结果（模型面看到的东西）。 */
  results: Array<{ toolName: string; result: unknown; error?: string }>
}

function createProbeSchema() {
  // ToolSchema 是鸭子类型（只要 safeParse），探针不引 zod，避免探针跟着校验库版本漂。
  return {
    safeParse: (input: unknown) => ({
      success: true as const,
      data: (input ?? {}) as Record<string, unknown>,
    }),
  }
}

function createProbeToolRegistry(executedArgs: Array<Record<string, unknown>>) {
  const tool = {
    schema: createProbeSchema(),
    execute: (input: Record<string, unknown>) => {
      executedArgs.push({ ...input })
      return { ok: true, echo: input }
    },
  }
  return {
    names: [ProbeToolName],
    get: (name: string) => (name === ProbeToolName ? tool : null),
    listAvailable: () => [{ name: ProbeToolName }],
    getDescriptor: (name: string) =>
      name === ProbeToolName ? { role: 'act', categoryId: undefined } : null,
    listCategories: () => [],
    buildAiTools: () => ({}),
    estimateToolsSerializedChars: () => 0,
  }
}

function createProbeToolContext(abortController: AbortController) {
  const codingSession = {
    recordToolResult: () => undefined,
    getRedundantToolCallMessage: () => null,
    consumePendingAutoApprovalNotice: () => null,
    hasSessionToolCategoryApproval: () => true,
    getToolSurfaceProfile: () => 'full',
    setToolSurfaceProfile: (profile: string) => profile,
    getRunProfile: () => 'auto',
    setRunProfile: (profile: string) => profile,
    getActiveCapabilityScope: () => 'default',
    enableToolCategories: (categories: unknown[]) => categories,
    enableToolNames: (names: unknown[]) => names,
    getEnabledToolCategories: () => [],
    getBudgetOverrideToolCategories: () => [],
    getBudgetOverrideToolNames: () => [],
    isToolCategoryAllowed: () => true,
  }
  let visibleToolNames: string[] = [ProbeToolName]
  let supportedModelInputModalities: string[] = ['text']
  return {
    sessionId: ProbeSessionId,
    abortSignal: abortController.signal,
    log: logRuntime.tag('SeamProbe'),
    role: { id: 'assistant' },
    execution: null,
    codingSession,
    activeContext: {
      listActiveContextArtifacts: async () => [],
      upsertActiveContextArtifact: async (input: unknown) => input,
    },
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolNames: () => visibleToolNames,
    setCurrentVisibleToolNames: (names: string[]) => {
      visibleToolNames = names
    },
    getSupportedModelInputModalities: () => supportedModelInputModalities,
    setSupportedModelInputModalities: (modalities: string[]) => {
      supportedModelInputModalities = [...modalities]
    },
    listToolCategories: () => [],
  }
}

function createProbeEvents() {
  return {
    emitRuntime: () => undefined,
    emitNotice: () => undefined,
    emitToolStart: () => undefined,
    emitToolProgress: () => undefined,
    emitToolMetadata: () => undefined,
    emitToolDone: () => undefined,
    emitTurnContext: () => undefined,
    emitTextDelta: () => undefined,
    emitReasoningDelta: () => undefined,
  }
}

/**
 * 跑一轮完整 SoloStreamLoop。
 *
 * 桩只替掉「模型那一段」：`executeStreamTurn` 拿到真 ToolExecutor，塞一次工具调用、等它收敛，
 * 然后中止并抛错让 loop 就地收口——工具执行本体、策略门、结果收敛全走真代码。
 */
async function runProbeLoop(seams: Nullable<AgentModSeamDispatcher>): Promise<ProbeRun> {
  const executedArgs: Array<Record<string, unknown>> = []
  const results: ProbeRun['results'] = []
  const abortController = new AbortController()
  const toolRegistry = createProbeToolRegistry(executedArgs)
  const toolContext = createProbeToolContext(abortController)
  const events = createProbeEvents()

  const runtimeHelper = {
    resolveRoleRuntime: async () => ({
      provider: (() => ({})) as never,
      providerId: 'probe-provider',
      model: 'probe-model',
      contextWindow: 128_000,
      supportedInputModalities: ['text'],
      resolutionSource: 'probe',
      resolutionTrace: [],
    }),
    handleStreamError: () => undefined,
    emitAbort: () => undefined,
    createAgentProvider: () => ({}) as never,
  }

  const turnHelper = {
    executeStreamTurn: async (args: {
      executor: {
        enqueue: (
          toolCallId: string,
          toolName: string,
          toolArgs: Record<string, unknown>,
          isConcurrencySafe: boolean
        ) => void
        collectAll: () => Promise<
          Array<{ toolName: string; result: unknown; error?: string }>
        >
      }
    }) => {
      args.executor.enqueue('call-1', ProbeToolName, { value: 'original' }, true)
      for (const result of await args.executor.collectAll()) {
        results.push({
          toolName: result.toolName,
          result: result.result,
          ...(result.error ? { error: result.error } : {}),
        })
      }
      // 工具已收敛：中止 + 抛错，让 loop 走确定性收口分支，探针不依赖收尾门的行为。
      abortController.abort()
      throw new Error('probe: turn finished after tool settlement')
    },
    appendToolResultsToHistory: async () => undefined,
  }

  const noopUsage = { percent: 0, estimatedTokens: 0, usableContextWindow: 128_000 }
  const historyHelper = {
    sanitizeHistory: (history: unknown[]) => ({
      history: [...history],
      removedMessages: 0,
      changedMessages: 0,
      issues: [],
    }),
    estimateContextUsage: () => noopUsage,
    getHighWatermarkPercent: () => 100,
    compactHistory: (_model: string, _systemPrompt: string, history: unknown[]) => ({
      compacted: false,
      history: [...history],
      removedMessages: 0,
      passes: 0,
      keptRecentTurns: 0,
      targetPercent: 0,
      estimatedBefore: noopUsage,
      estimatedAfter: noopUsage,
    }),
  }

  const runContextHelper = {
    buildPrimaryAgentSystemPrompt: async () => ({
      systemPrompt: 'probe system prompt',
      devEnvironmentContext: null,
      stableCutoff: 0,
      promptSegments: [],
      skippedPromptSegments: [],
    }),
    buildTurnContextPayload: () => ({}) as never,
  }

  const loop = new SoloStreamLoop(
    runtimeHelper as never,
    turnHelper as never,
    historyHelper as never,
    runContextHelper as never,
    toolRegistry as never,
    null,
    {},
    seams
  )

  const outcome = await loop.execute({
    history: [{ role: 'user', content: '跑一次探针工具' }],
    config: {} as never,
    chatConfig: {} as never,
    systemConfig: {} as never,
    abortController,
    toolContext: toolContext as never,
    resolution: { id: 'assistant', allowedTools: [ProbeToolName] } as never,
    events: events as never,
  })

  return { status: outcome.status, executedArgs, results }
}

describe('mod seam tool chain', () => {
  test('SoloLoop 装配面注入的派发器能到达每轮 ToolExecutor：调用前/结果后两缝都被派发', async () => {
    const seams = new AgentModSeamDispatcher()
    const seen: string[] = []
    seams.beginRegistration()
    seams.register({
      modId: 'probe.mod',
      id: 'before',
      seam: 'tool-call:before',
      handler: (event) => {
        seen.push(`before:${event.toolName}:${event.sessionId ?? 'null'}`)
        return { args: { ...event.args, value: 'rewritten' } }
      },
    })
    seams.register({
      modId: 'probe.mod',
      id: 'after',
      seam: 'tool-result:after',
      handler: (event) => {
        seen.push(`after:${event.toolName}`)
        return { result: { rewritten: true, from: event.result } }
      },
    })
    seams.seal()

    const run = await runProbeLoop(seams)

    // ① 两缝都被派发，且事件带上了会话身份。
    expect(seen).toEqual([
      `before:${ProbeToolName}:${ProbeSessionId}`,
      `after:${ProbeToolName}`,
    ])
    // ② before 的入参改写真的落到了工具实体（说明改写发生在策略门/校验之前，不是旁路）。
    expect(run.executedArgs).toHaveLength(1)
    expect(run.executedArgs[0]?.value).toBe('rewritten')
    // ③ after 的结果改写落在物化之前，模型面拿到的就是改写后的结果。
    expect(run.results).toHaveLength(1)
    expect(JSON.stringify(run.results[0]?.result)).toContain('rewritten')
  })

  test('未注入派发器时同一条链零扰动：工具入参与结果都保持原样', async () => {
    const run = await runProbeLoop(null)

    expect(run.executedArgs).toHaveLength(1)
    expect(run.executedArgs[0]?.value).toBe('original')
    expect(run.results).toHaveLength(1)
    expect(run.results[0]?.error).toBeUndefined()
    expect(JSON.stringify(run.results[0]?.result)).not.toContain('rewritten')
  })

  test('注册了别的 seam 不会连带唤醒工具缝（快路径判定按 kind 收敛）', async () => {
    const seams = new AgentModSeamDispatcher()
    let sessionHookCalls = 0
    seams.beginRegistration()
    seams.register({
      modId: 'probe.mod',
      id: 'lifecycle-only',
      seam: 'session:start',
      handler: () => {
        sessionHookCalls += 1
      },
    })
    seams.seal()

    const run = await runProbeLoop(seams)

    expect(sessionHookCalls).toBe(0)
    expect(run.executedArgs[0]?.value).toBe('original')
  })
})
