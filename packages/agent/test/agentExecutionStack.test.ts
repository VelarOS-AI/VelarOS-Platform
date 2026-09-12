import { type ModelMessage,simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { executeLoopTurnWithContextOverflowRecovery } from '../src/agent/AgentLoop'
import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { ContextBuilder } from '../src/agent/ContextBuilder'
import { resolveContextDegradeAction } from '../src/agent/ContextDegradeLadder'
import { AgentTurnHistoryHelper } from '../src/agent/history'
import { AgentLoopContextUsageManager } from '../src/agent/LoopContextUsage'
import { PrimaryAgentProfile } from '../src/agent/PrimaryAgentProfile'
import { QueryTurn } from '../src/agent/QueryTurn'
import { isContextOverflowReplayUnsafe } from '../src/agent/retry'
import { RunContext } from '../src/agent/run-context/RunContext'
import {
  type AgentExecutionStackToolContext,
  type AgentExecutionStackToolRegistry,
  createAgentExecutionStack,
} from '../src/agent/runner'
import type { AgentSystemRuntimeConfig } from '../src/agent/RuntimeConfiguration'
import { SubAgentGuidanceRelayRegistry } from '../src/execution'
import { SubAgentDispatcher } from '../src/kernel/dispatch/SubAgentDispatcher'
import { ExecutionEventBus } from '../src/kernel/execution/ExecutionEventBus'
import { AgentModSeamDispatcher } from '../src/mods/AgentModSeams'
import { createBuiltInPromptRegistry } from '../src/prompts'
import type { AgentEvent, AgentModelInputModality } from '../src/protocol'
import type { SubAgentTypeDescriptor } from '../src/sub-agent'
import { parseSubAgentToolResult } from '../src/sub-agent'
import { TeamModelRouter, WriteLeaseCoordinator } from '../src/team'
import { defaultRuntimePromptFeaturePolicy } from '../src/tools/prompt-feature-policy'

const systemConfig: AgentSystemRuntimeConfig = {
  thinkingDepth: 'balanced',
  disabledToolNames: [],
  prompt: { segmentOverrides: [] },
  advancedRuntime: {},
  modelRuntimeContext: { host: 'probe' },
}
const chatConfig = { modelSelection: { hostModel: 'probe' }, systemPromptAppend: '' }
type ProbeContext = AgentExecutionStackToolContext & { execution: null }

const toolRegistry: AgentExecutionStackToolRegistry<ProbeContext> = {
  names: [],
  get: () => null,
  getDescriptor: () => null,
  listAvailable: () => [],
  toAiTools: () => ({}),
}
const primaryAgentProfile = new PrimaryAgentProfile(
  { getSkillMarkdownForRole: () => '', listSkillsForRole: () => [] },
  { getToolCategoryId: () => 'probe' }
)
const resolution = primaryAgentProfile.resolve({ knownToolNames: [], allowSubAgents: false })

function createContext(sessionId: string, abortController = new AbortController()): ProbeContext {
  let visibleToolNames: string[] = []
  let modalities: readonly AgentModelInputModality[] = ['text']
  return {
    sessionId,
    locale: 'en-US',
    abortSignal: abortController.signal,
    log: logRuntime.tag('ExecutionStackProbe'),
    codingSession: new CodingSessionTracker([], []),
    role: { id: resolution.id, label: resolution.label, description: '', nextAllowedRoles: [] },
    execution: null,
    interaction: { getCurrentPlan: () => [], getCurrentExecutionAdvice: () => null },
    activeContext: {
      listActiveContextArtifacts: async () => [],
      upsertActiveContextArtifact: async () => {
        throw new Error('probe has no goal artifacts')
      },
    },
    listTools: () => [],
    listToolCategories: () => [],
    getEnabledToolCategories: () => [],
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolNames: () => visibleToolNames,
    setCurrentVisibleToolNames: (names) => {
      visibleToolNames = names
    },
    getSupportedModelInputModalities: () => modalities,
    setSupportedModelInputModalities: (next) => {
      modalities = next
    },
    query: async () => {
      throw new Error('nested delegation is not enabled')
    },
  }
}

function createModel(onStream: () => void = () => {}) {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  }
  const model = new MockLanguageModelV3({
    provider: 'probe',
    modelId: 'probe',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'model complete' }],
      usage,
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
    }),
    doStream: async () => {
      onStream()
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'model complete' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          ],
        }),
      }
    },
  })
  const requests: Array<{ selection: unknown; context: unknown }> = []
  const provider = () => model
  return {
    model,
    provider,
    requests,
    port: {
      createAgentProvider: () => provider,
      resolveRoleRuntime: async (selection: unknown, context?: unknown) => {
        requests.push({ selection, context })
        return {
          provider,
          providerId: 'probe',
          model: 'probe',
          providerModel: 'probe',
          contextWindow: 128_000,
          supportedInputModalities: ['text'] as const,
          resolutionSource: 'probe',
          resolutionTrace: [],
        }
      },
    },
  }
}

async function runSolo(stack: ReturnType<typeof createAgentExecutionStack>, sessionId: string) {
  const abortController = new AbortController()
  const history: ModelMessage[] = [{ role: 'user', content: 'say done' }]
  const outcome = await stack.executeSolo({
    history,
    config: { sessionId, modelSelection: chatConfig.modelSelection },
    chatConfig,
    systemConfig,
    abortController,
    toolContext: createContext(sessionId, abortController),
    resolution,
    events: new ExecutionEventBus(),
  })
  expect(outcome.status).toBe('completed')
  expect(JSON.stringify(history)).toContain('model complete')
}

describe('default Agent execution stack', () => {
  test('prompt-only context needs no fabricated session identity', async () => {
    const toolContext = {
      locale: 'en-US' as const,
      codingSession: new CodingSessionTracker([], []),
      interaction: { getCurrentPlan: () => [], getCurrentExecutionAdvice: () => null },
      listTools: () => [],
      listToolCategories: () => [],
    }
    const runContext = new RunContext<typeof toolContext>(
      new ContextBuilder(createBuiltInPromptRegistry()),
      defaultRuntimePromptFeaturePolicy
    )
    const prompt = await runContext.buildSystemPrompt({
      chatConfig,
      systemConfig,
      messages: [],
      roleResolution: resolution,
      toolContext,
    })
    expect(prompt.systemPrompt.length).toBeGreaterThan(0)
  })

  test('Solo-only host executes a real model stream without Query dependencies and can release its session', async () => {
    const model = createModel()
    const stack = createAgentExecutionStack({ model: model.port, toolRegistry })
    expect('executeQuery' in stack).toBe(false)
    expect('createRunner' in stack).toBe(false)
    await runSolo(stack, 'solo-only')
    expect(model.requests).toEqual([
      { selection: chatConfig.modelSelection, context: systemConfig.modelRuntimeContext },
    ])
    expect(stack.governanceSessions.peek('solo-only')).not.toBeNull()
    stack.clearSession('solo-only')
    expect(stack.governanceSessions.peek('solo-only')).toBeNull()
  })

  test('Solo and Query share the configured prompt seam and preserve independent session governance', async () => {
    let queryLedgerWasActive = false
    const model = createModel(() => {
      queryLedgerWasActive ||= stack.governanceSessions.peek('query') !== null
    })
    const seams = new AgentModSeamDispatcher()
    let assemblies = 0
    seams.beginRegistration()
    seams.register({
      modId: 'probe',
      id: 'context',
      event: 'turn-context:assemble',
      handler: () => {
        assemblies += 1
      },
    })
    seams.seal()
    const stack = createAgentExecutionStack({
      model: model.port,
      toolRegistry,
      seams,
      query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
    })
    await runSolo(stack, 'solo')
    const soloLedger = stack.governanceSessions.peek('solo')
    expect(
      await stack.executeQuery({
        task: 'say done',
        opts: { contextEpochScope: 'query' },
        parentCtx: createContext('query'),
        chatConfig,
        systemConfig,
        collectCapabilityContext: async () => null,
      })
    ).toBe('model complete')
    expect(assemblies).toBe(2)
    expect(model.model.doStreamCalls).toHaveLength(2)
    expect(model.model.doGenerateCalls).toHaveLength(0)
    expect(queryLedgerWasActive).toBe(true)
    expect(stack.governanceSessions.peek('query')).toBeNull()
    stack.clearSession('query')
    expect(stack.governanceSessions.peek('solo')).toBe(soloLedger)
  })

  test('createRunner binds the real dispatcher before dispatch reaches QueryLoop', async () => {
    const model = createModel()
    const { dispatcher } = createRunnerHarness(model)
    const result = await dispatcher.dispatch({
      input: { prompt: 'say done', mode: 'sync' },
      parentCtx: { ...createContext('parent'), execution: null },
      events: new ExecutionEventBus(),
      config: {},
    })
    expect(result).toContain('model complete')
    expect(result).not.toContain('failed')
    expect(model.model.doStreamCalls).toHaveLength(1)
    dispatcher.clearExecution('parent')
  })

  test('a worker resumed in a later execution continues its history with only the follow-up', async () => {
    const model = createModel()
    const { dispatcher } = createRunnerHarness(model)
    const dispatchIn = (executionId: string, input: { prompt: string; threadId?: string }) =>
      dispatcher.dispatch({
        input: { ...input, mode: 'sync' },
        parentCtx: { ...createContext('resume-parent'), execution: null },
        events: new ExecutionEventBus(),
        config: {},
        executionId,
      })

    const first = parseSubAgentToolResult(await dispatchIn('run-1', { prompt: 'say done' }))
    expect(first).toMatchObject({ status: 'completed', resumable: true })
    dispatcher.clearExecution('run-1')

    const resumed = parseSubAgentToolResult(
      await dispatchIn('run-2', { threadId: first!.thread_id, prompt: 'now say done again' })
    )
    expect(resumed).toMatchObject({ status: 'completed', thread_id: first!.thread_id })
    expect(model.model.doStreamCalls).toHaveLength(2)
    // 第二次请求带着第一次的完整历史；委派外壳只出现一次（首条消息），追加指令原样接在后面。
    const resumedPrompt = JSON.stringify(model.model.doStreamCalls[1]!.prompt)
    expect(resumedPrompt.split('这是一项由上游角色委派的固定子任务').length - 1).toBe(1)
    expect(resumedPrompt).toContain('model complete')
    expect(resumedPrompt).toContain('now say done again')
    expect(resumedPrompt).toContain('自上次运行后文件可能已变化，修改前先重新读取')
    dispatcher.clearExecution('run-2')
  })
})

test('host settlement is awaited, can continue with input, then stop without another request', async () => {
  let streams = 0
  const model = createModel(() => { streams++ })
  const stack = createAgentExecutionStack({ model: model.port, toolRegistry })
  const abortController = new AbortController()
  const history: ModelMessage[] = [{ role: 'user', content: 'start' }]
  const boundaries: string[] = []
  const result = await stack.executeSolo({
    history, config: {}, chatConfig, systemConfig, abortController,
    toolContext: createContext('lifecycle', abortController), resolution, events: new ExecutionEventBus(),
    lifecycle: {
      beforeTurn: ({ turn }) => { boundaries.push(`before:${turn}`) },
      onTurnSettled: async ({ turn, history: settled }) => {
        expect(settled.some((message) => message.role === 'assistant')).toBe(true)
        await Promise.resolve()
        boundaries.push(`persisted:${turn}`)
        expect(streams).toBe(turn)
        if (turn === 1) { settled.push({ role: 'user', content: 'continue' }); return 'continue' }
        return 'stop'
      },
    },
  })
  expect(result.status).toBe('completed')
  expect(streams).toBe(2)
  expect(boundaries).toEqual(['before:1', 'persisted:1', 'before:2', 'persisted:2'])
})

test('host settlement failure ends the run without replaying a completed request', async () => {
  let streams = 0
  const model = createModel(() => { streams++ })
  const stack = createAgentExecutionStack({ model: model.port, toolRegistry })
  const abortController = new AbortController()
  const history: ModelMessage[] = [{ role: 'user', content: 'start' }]
  const result = await stack.executeSolo({
    history, config: {}, chatConfig, systemConfig, abortController,
    toolContext: createContext('failed-persistence', abortController), resolution, events: new ExecutionEventBus(),
    lifecycle: { onTurnSettled: async () => { throw new Error('disk unavailable') } },
  })
  expect(result.status).toBe('error')
  expect(streams).toBe(1)
  expect(history.some((message) => message.role === 'assistant')).toBe(true)
})

test('in-flight Solo cancellation settles as aborted after the provider stream starts', async () => {
  const fixture = createModel()
  let notifyStarted: () => void = () => undefined
  const streamStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve
  })
  fixture.model.doStream = async ({ abortSignal }) => ({
    stream: new ReadableStream({
      start(controller) {
        const abort = () => controller.error(
          abortSignal?.reason ?? new Error('fixture stream aborted')
        )
        if (abortSignal?.aborted) abort()
        else abortSignal?.addEventListener('abort', abort, { once: true })
        notifyStarted()
      },
    }),
  })

  const stack = createAgentExecutionStack({ model: fixture.port, toolRegistry })
  const abortController = new AbortController()
  const history: ModelMessage[] = [{ role: 'user', content: 'cancel after start' }]
  const execution = stack.executeSolo({
    history,
    config: { sessionId: 'cancel-after-start', modelSelection: chatConfig.modelSelection },
    chatConfig,
    systemConfig,
    abortController,
    toolContext: createContext('cancel-after-start', abortController),
    resolution,
    events: new ExecutionEventBus(),
  })

  await streamStarted
  abortController.abort(new Error('user cancelled active stream'))

  await expect(execution).resolves.toEqual({ status: 'aborted' })
  expect(history.some((message) => message.role === 'assistant')).toBe(false)
})

test('Query awaits the same settlement port before returning its result', async () => {
  const model = createModel()
  const stack = createAgentExecutionStack({ model: model.port, toolRegistry,
    query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
  })
  const observations: string[] = []
  const result = await stack.executeQuery({
    task: 'done', opts: {}, parentCtx: createContext('query-settlement'), chatConfig, systemConfig,
    collectCapabilityContext: async () => null,
    lifecycle: {
      beforeTurn: () => { observations.push('before') },
      onTurnSettled: async ({ history }) => {
        await Promise.resolve()
        expect(history.some((message) => message.role === 'assistant')).toBe(true)
        observations.push('saved')
        return 'stop'
      },
    },
  })
  expect(result).toBe('model complete')
  expect(observations).toEqual(['before', 'saved'])
})

for (const scenario of ['reasoning', 'malformed-tool'] as const) {
  test(`strict host recovery stops after ${scenario}`, async () => {
    const fixture = createModel()
    let requests = 0
    let decisions = 0
    const initial = fixture.model.doStream
    fixture.model.doStream = async (...args) => {
      requests++
      if (requests > 1) return initial.apply(fixture.model, args)
      return {
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: scenario === 'reasoning' ? [
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'reasoning' },
            { type: 'reasoning-delta', id: 'reasoning', delta: 'already displayed reasoning' },
            { type: 'reasoning-end', id: 'reasoning' },
            { type: 'error', error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) },
          ] : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'already displayed answer' },
            { type: 'text-end', id: 'text' },
            { type: 'tool-input-start', id: 'bad-call', toolName: 'fixture_tool' },
            { type: 'tool-input-delta', id: 'bad-call', delta: '{"incomplete":' },
            { type: 'tool-input-end', id: 'bad-call' },
            {
              type: 'finish', finishReason: { unified: 'length', raw: 'length' },
              usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
            },
          ],
        }),
      }
    }
    const stack = createAgentExecutionStack({ model: fixture.port, toolRegistry })
    const controller = new AbortController()
    const events: AgentEvent[] = []
    const result = await stack.executeSolo({
      history: [{ role: 'user', content: 'work' }], config: {}, chatConfig, systemConfig,
      abortController: controller, toolContext: createContext(`strict-recovery-${scenario}`, controller),
      resolution, events: new ExecutionEventBus({ agent: (event) => events.push(event) }),
      modelRetry: {
        allowPartialContinuation: false,
        onFailure: () => { decisions++; return { delayMs: 0 } },
      },
    })
    expect(requests).toBe(1)
    expect(decisions).toBe(0)
    expect(result.status).toBe('error')
    expect(events.filter((event) => event.type === 'text-delta' || event.type === 'reasoning-delta')).toHaveLength(1)
  })
}

function createRunnerHarness(fixture: ReturnType<typeof createModel>) {
  const relay = new SubAgentGuidanceRelayRegistry()
  const descriptor: SubAgentTypeDescriptor = {
    id: 'probe', workerType: 'probe', roleId: resolution.id, routeCategory: 'probe',
    workerPhase: 'probe', toolCategories: [], toolNames: [], resourceLeaseScope: null,
    readonlyDefault: true, promptAppend: null,
  }
  const dispatcher = new SubAgentDispatcher(
    new TeamModelRouter({
      resolve: () => ({
        runtimeOverride: { provider: fixture.provider, providerId: 'probe', model: 'probe' },
        trace: null,
      }),
    }),
    new WriteLeaseCoordinator(),
    { systemConfig, chatConfig },
    relay,
    { defaultTypeId: 'probe', getDescriptor: () => descriptor, listDescriptors: () => [descriptor] }
  )
  const stack = createAgentExecutionStack({
    model: fixture.port, toolRegistry,
    query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
  })
  const runner = stack.createRunner({
    contextHelper: { buildToolContext: () => createContext('runner') },
    primaryAgentProfile, subAgentDispatcher: dispatcher, configService: { systemConfig, chatConfig },
    codingSessionPolicy: { toolCategoryToolNames: {} },
    surfaceProfileProvider: {
      resolve: () => ({
        id: 'probe',
        toolPolicy: {
          baseCategories: [], includePromptFeatureCategories: false, restoreApprovedCategories: false,
        },
        allowSubAgents: true,
      }),
      deriveRunPolicy: () => ({
        activeSpace: 'default', initialToolCategories: [], initialActiveToolCategories: [],
        initialPromptFeatures: [], restoredApprovedCategories: [], allowSubAgents: true,
      }),
    },
  })
  return { dispatcher, relay, runner, stack }
}

test('Query idle timeout aborts the actual provider request and leaves its parent usable', async () => {
  const fixture = createModel()
  let providerSignal: AbortSignal | undefined
  fixture.model.doStream = async ({ abortSignal }) => {
    providerSignal = abortSignal
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 'text' })
          controller.enqueue({ type: 'text-delta', id: 'text', delta: 'partial output' })
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), { once: true })
        },
      }),
    }
  }
  const controller = new AbortController()
  const query = new QueryTurn(toolRegistry, new AgentTurnHistoryHelper(), new ContextGovernanceSessionRegistry())
  try {
    await expect(query.executeQueryTurn({
      provider: fixture.provider, model: 'probe', systemPrompt: 'probe',
      history: [{ role: 'user', content: 'work' }], toolContext: createContext('query-idle', controller),
      allowedTools: [], idleStallTimeoutMs: 20,
      modelRetry: { allowPartialContinuation: false, onFailure: () => null },
    })).rejects.toMatchObject({ code: 'MODEL_STREAM_STALLED' })
    expect(providerSignal).toBeDefined()
    expect(providerSignal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  } finally {
    controller.abort()
  }
})

test('Query overflow after visible output never replays that output through the recovery ladder', async () => {
  const fixture = createModel()
  let requests = 0
  fixture.model.doStream = async () => {
    requests += 1
    return {
      stream: simulateReadableStream({
        initialDelayInMs: null, chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: 'already visible' },
          { type: 'error', error: new AppError('MODEL_CONTEXT_OVERFLOW', 'maximum context length exceeded') },
        ],
      }),
    }
  }
  const query = new QueryTurn(toolRegistry, new AgentTurnHistoryHelper(), new ContextGovernanceSessionRegistry())
  const context = createContext('query-overflow')
  const textDeltas: string[] = []
  let recoveryActions = 0
  let failure: unknown
  try {
    await executeLoopTurnWithContextOverflowRecovery({
      turn: 1, abortSignal: context.abortSignal,
      executeTurn: () => query.executeQueryTurn({
        provider: fixture.provider, model: 'probe', systemPrompt: 'probe',
        history: [{ role: 'user', content: 'work' }], toolContext: context,
        allowedTools: [], streamTextDeltas: true,
        events: { emitRuntime: () => undefined, emitTextDelta: (text) => textDeltas.push(text) },
      }),
      resolveAction: (attempt) => resolveContextDegradeAction('query', attempt),
      applyAction: async () => { recoveryActions += 1; return true },
      surrenderLogMessage: 'overflow test exhausted', log: { error: () => undefined },
    })
  } catch (error) {
    failure = error
  }
  expect(failure).toMatchObject({ code: 'MODEL_CONTEXT_OVERFLOW' })
  expect(isContextOverflowReplayUnsafe(failure)).toBe(true)
  expect(requests).toBe(1)
  expect(recoveryActions).toBe(0)
  expect(textDeltas).toEqual(['already visible'])
})

for (const scenario of ['recovers', 'exhausts', 'preserves-write'] as const) {
  test(`provider overflow automatically reclaims before a bounded Query retry: ${scenario}`, async () => {
    const fixture = createModel()
    const successfulStream = fixture.model.doStream.bind(fixture.model)
    const requestChars: number[] = []
    const estimates: number[] = []
    const outputReserves: number[] = []
    let writes = 0
    fixture.model.doStream = async (input) => {
      requestChars.push(JSON.stringify(input.prompt).length)
      expect(input.maxOutputTokens).toBe(48_000)
      if (scenario === 'preserves-write' && requestChars.length === 1) return { stream: simulateReadableStream({
          initialDelayInMs: null, chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'write-once', toolName: 'write_file', input: JSON.stringify({ path: '/repo/output.txt', text: 'done' }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } } },
          ],
        }) }
      if (requestChars.length === (scenario === 'preserves-write' ? 2 : 1) || scenario === 'exhausts') {
        throw new AppError('MODEL_CONTEXT_OVERFLOW', 'maximum context length exceeded')
      }
      return successfulStream(input)
    }
    const writeTool = {
        permissions: ['project:write'],
        schema: z.object({ path: z.string(), text: z.string() }),
        execute: () => { writes++; return { changed: true, revision: 2 } },
    }
    const registry: typeof toolRegistry = {
      ...toolRegistry,
      names: ['read_file', 'write_file', 'context:recall'],
      get: (name) => name === 'write_file' ? writeTool as never : null,
      listAvailable: (_context, names) => (names ?? []).map((name) => ({ name, description: 'probe' })),
      toAiTools: () => ({
        read_file: { description: 'read', inputSchema: z.object({ path: z.string() }) },
        write_file: { description: 'write', inputSchema: z.object({ path: z.string(), text: z.string() }) },
        context__recall: { description: 'recall', inputSchema: z.object({ ref: z.string() }) },
      }),
    }
    const governance = new ContextGovernanceSessionRegistry({
      classifier: { isRefetchable: (input) => input.toolName === 'read_file' ? true : undefined },
      config: { dashboard: false, tailProtectTurns: 1, minEpochSavingPercent: 1, cap: 128_000 },
    })
    const history: ModelMessage[] = []
    for (let index = 0; index < 6; index++) {
      history.push(
        { role: 'user', content: `Read /repo/src/file-${index}.ts` },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `read-${index}`, toolName: 'read_file', input: { path: `/repo/src/file-${index}.ts` } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `read-${index}`, toolName: 'read_file', output: { type: 'text', value: 'existing receipt body '.repeat(200) } }] },
      )
    }
    const sessionId = `automatic-overflow-${scenario}`
    const context = {
      ...createContext(sessionId),
      getCurrentVisibleToolTransportNames: () => ({ read_file: 'read_file', write_file: 'write_file', 'context:recall': 'context__recall' }),
    }
    const query = new QueryTurn(registry, new AgentTurnHistoryHelper(), governance)
    let actions = 0
    const executeTurn = () => query.executeQueryTurn({
        provider: fixture.provider, model: 'probe', systemPrompt: 'probe', history,
        toolContext: context, allowedTools: registry.names, contextWindow: 128_000,
        modelRequestOptions: { requestPolicy: { maxOutputTokens: 48_000 } },
        contextUsageOptions: { reservedOutputTokens: 1_000 },
        events: { emitRuntime: (event) => {
          if (event.kind !== 'context-usage-estimate') return
          estimates.push(event.estimatedTokens)
          outputReserves.push(event.reservedOutputTokens)
        } },
      })
    if (scenario === 'preserves-write') {
      context.codingSession.hasSessionToolCategoryApproval = () => true
      expect((await executeTurn()).hasToolUse).toBe(true)
      expect(writes).toBe(1)
      expect(JSON.parse(JSON.stringify(history.at(-1)))).toMatchObject({ role: 'tool', content: [expect.objectContaining({ output: { type: 'text', value: JSON.stringify({ changed: true, revision: 2 }) } })] })
    }
    const originalHistory = JSON.stringify(history)
    const originalCount = history.length
    const run = executeLoopTurnWithContextOverflowRecovery({
      turn: 1,
      abortSignal: context.abortSignal,
      executeTurn,
      resolveAction: (attempt) => resolveContextDegradeAction('query', attempt),
      applyAction: async () => {
        actions++
        return !!governance.requestEpoch(sessionId, { source: 'overflow-recovery' })?.applied
      },
      surrenderLogMessage: 'overflow recovery exhausted',
      log: { error: () => undefined },
    })
    if (scenario !== 'exhausts') {
      const result = await run
      expect(result.text).toBe('model complete')
      expect(result.predictedInputTokens).toBe(estimates.at(-1))
    }
    else await expect(run).rejects.toMatchObject({ code: 'MODEL_CONTEXT_OVERFLOW' })
    expect(actions).toBe(1)
    expect(requestChars).toHaveLength(scenario === 'preserves-write' ? 3 : 2)
    expect(requestChars.at(-1)).toBeLessThan(requestChars.at(-2)!)
    expect(estimates.at(-1)).toBeLessThan(estimates.at(-2)!)
    expect(outputReserves).toEqual(requestChars.map(() => 48_000))
    expect(writes).toBe(scenario === 'preserves-write' ? 1 : 0)
    expect(JSON.stringify(history.slice(0, originalCount))).toBe(originalHistory)
    expect(governance.epochReports(sessionId)).toContainEqual(expect.objectContaining({ source: 'overflow-recovery', applied: true }))
  })
}

test.each(['solo', 'query'] as const)('%s reserves actual model output policy and calibrates the same compiled request', async (surface) => {
  const fixture = createModel()
  const resolveRuntime = fixture.port.resolveRoleRuntime
  fixture.port.resolveRoleRuntime = async (...args) => ({
    ...await resolveRuntime(...args),
    modelRequestOptions: { requestPolicy: { maxOutputTokens: 48_000 } },
  })
  const compiledEstimates: number[] = []
  let observedReserve = 0
  let requestedOutput = 0
  const successfulStream = fixture.model.doStream.bind(fixture.model)
  fixture.model.doStream = async (input) => {
    requestedOutput = input.maxOutputTokens ?? 0
    return successfulStream(input)
  }
  const records = spyOn(AgentLoopContextUsageManager.prototype, 'recordActualUsage')
  const budgets = spyOn(AgentLoopContextUsageManager.prototype, 'buildContextUsageOptions')
  const events = new ExecutionEventBus({
    agent: (event) => {
      if (event.type !== 'runtime' || event.payload.kind !== 'context-usage-estimate') return
      compiledEstimates.push(event.payload.estimatedTokens)
      observedReserve = event.payload.reservedOutputTokens
    },
  })
  try {
    const stack = createAgentExecutionStack({ model: fixture.port, toolRegistry,
      query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
    })
    const abortController = new AbortController()
    const lifecycle = { onTurnSettled: ({ turn, history }: { turn: number; history: ModelMessage[] }) => {
      if (turn === 1) { history.push({ role: 'user', content: 'one more turn' }); return 'continue' as const }
      return 'stop' as const
    } }
    if (surface === 'solo') {
      const outcome = await stack.executeSolo({
        history: [{ role: 'user', content: 'say done' }],
        config: {}, chatConfig, systemConfig, abortController,
        toolContext: createContext('compiled-calibration', abortController), resolution, events, lifecycle,
      })
      expect(outcome.status).toBe('completed')
    } else {
      expect(await stack.executeQuery({
        task: 'say done', opts: { events },
        parentCtx: createContext('compiled-calibration', abortController),
        chatConfig, systemConfig, collectCapabilityContext: async () => null, lifecycle,
      })).toBe('model complete')
    }
    expect(requestedOutput).toBe(48_000)
    expect(observedReserve).toBe(requestedOutput)
    expect(compiledEstimates).toHaveLength(2)
    expect(records.mock.calls).toEqual(compiledEstimates.map((estimate) => ['probe', estimate, 10]))
    expect(budgets.mock.results[0]?.value.calibrationFactor).toBe(1)
    expect(budgets.mock.results[1]?.value.calibrationFactor).toBeLessThan(1)
  } finally {
    records.mockRestore()
    budgets.mockRestore()
  }
})

for (const mode of ['failure', 'cancellation'] as const) {
  test(`runner preserves a worker's existing mutations after ${mode}`, async () => {
    const fixture = createModel()
    const controller = new AbortController()
    const parent = createContext(`query-snapshot-${mode}`, controller)
    const parentTracker = parent.codingSession as CodingSessionTracker
    let childTracker: CodingSessionTracker | undefined
    const fork = parentTracker.forkForSubAgent.bind(parentTracker)
    parentTracker.forkForSubAgent = () => {
      childTracker = fork()
      return childTracker
    }
    fixture.model.doStream = async () => {
      childTracker!.notifyExternalFilesystemTouches(['edited-before-failure.ts'])
      if (mode === 'cancellation') controller.abort('cancel after write')
      throw new AppError('VALIDATION', 'provider stopped after the resource changed')
    }
    const { runner } = createRunnerHarness(fixture)
    await expect(runner.query('work', parent)).rejects.toBeDefined()
    expect(childTracker).not.toBe(parentTracker)
    expect(parentTracker.getSnapshot()).toMatchObject({
      modifiedPaths: ['edited-before-failure.ts'], hasCapabilityMutations: true,
      needsChangeInspection: true, needsVerificationCommand: true,
    })
  })
}

for (const source of ['worker', 'parent'] as const) {
  test(`in-flight ${source} cancellation remains aborted through the real dispatcher and QueryLoop`, async () => {
    const fixture = createModel()
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    fixture.model.doStream = async ({ abortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), { once: true })
          markStarted()
        },
      }),
    })
    const { dispatcher, relay } = createRunnerHarness(fixture)
    const controller = new AbortController()
    const parent = createContext(`cancel-${source}`, controller)
    const execution = dispatcher.dispatch({
      input: { prompt: 'work', mode: 'sync' }, parentCtx: parent,
      events: new ExecutionEventBus(), config: {},
    })
    // Attach both branches immediately: parent cancellation must reject to the caller.
    const settled = execution.then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }))
    try {
      await started
      const worker = relay.listActiveWorkers(parent.sessionId!)[0]
      expect(worker).toBeDefined()
      if (source === 'worker') {
        expect(dispatcher.abortWorker(parent.sessionId!, worker!.threadId, 'user cancelled worker')).toBe(true)
      } else {
        controller.abort(new Error('user cancelled parent'))
      }
      const outcome = await settled
      if (source === 'worker') {
        expect(outcome.error).toBeNull()
        expect(parseSubAgentToolResult(outcome.result!)).toMatchObject({ status: 'aborted' })
      } else {
        expect(outcome.error).toMatchObject({ code: 'EXECUTION_ABORTED' })
      }
      expect(relay.listActiveWorkers(parent.sessionId!)).toEqual([])
    } finally {
      controller.abort()
      await settled
      dispatcher.clearExecution(parent.sessionId!)
    }
  })
}

test('a standalone Query worker signal cancels its provider and normalizes the terminal error', async () => {
  const fixture = createModel()
  let providerSignal: AbortSignal | undefined
  let markStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  fixture.model.doStream = async ({ abortSignal }) => {
    providerSignal = abortSignal
    return {
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), { once: true })
          markStarted()
        },
      }),
    }
  }
  const stack = createAgentExecutionStack({
    model: fixture.port, toolRegistry,
    query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
  })
  const worker = new AbortController()
  const parent = new AbortController()
  const execution = stack.executeQuery({
    task: 'work', opts: { workerAbortSignal: worker.signal }, parentCtx: createContext('standalone-cancel', parent),
    chatConfig, systemConfig, collectCapabilityContext: async () => null,
  })
  await started
  const watchdog = setTimeout(() => parent.abort('worker signal did not stop its provider'), 500)
  try {
    worker.abort('worker cancelled independently')
    await expect(execution).rejects.toMatchObject({ code: 'EXECUTION_ABORTED' })
    expect(providerSignal?.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  } finally {
    clearTimeout(watchdog)
    parent.abort()
  }
})

test('a Query retry owns a fresh signal after cancelling the stalled attempt', async () => {
  const fixture = createModel()
  const complete = fixture.model.doStream
  const requestSignals: Array<AbortSignal | undefined> = []
  fixture.model.doStream = async (options) => {
    requestSignals.push(options.abortSignal)
    if (requestSignals.length > 1) {
      expect(requestSignals[0]?.aborted).toBe(true)
      expect(options.abortSignal?.aborted).toBe(false)
      return complete.call(fixture.model, options)
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          options.abortSignal?.addEventListener('abort', () => controller.error(options.abortSignal?.reason), { once: true })
        },
      }),
    }
  }
  const parent = new AbortController()
  const query = new QueryTurn(toolRegistry, new AgentTurnHistoryHelper(), new ContextGovernanceSessionRegistry())
  try {
    const result = await query.executeQueryTurn({
      provider: fixture.provider, model: 'probe', systemPrompt: 'probe',
      history: [{ role: 'user', content: 'work' }], toolContext: createContext('query-idle-retry', parent),
      allowedTools: [], idleStallTimeoutMs: 20,
      modelRetry: { allowPartialContinuation: false, onFailure: ({ attempt }) => attempt === 1 ? { delayMs: 0 } : null },
    })
    expect(result.text).toBe('model complete')
    expect(requestSignals).toHaveLength(2)
    expect(parent.signal.aborted).toBe(false)
  } finally {
    parent.abort()
  }
})
