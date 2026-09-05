import { type ModelMessage,simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, test } from 'bun:test'

import { logRuntime } from '@velaros-ai/core/logger'

import { CodingSessionTracker } from '../src/agent/CodingSessionTracker'
import { ContextBuilder } from '../src/agent/ContextBuilder'
import { PrimaryAgentProfile } from '../src/agent/PrimaryAgentProfile'
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
    const descriptor: SubAgentTypeDescriptor = {
      id: 'probe',
      workerType: 'probe',
      roleId: resolution.id,
      routeCategory: 'probe',
      workerPhase: 'probe',
      toolCategories: [],
      toolNames: [],
      resourceLeaseScope: null,
      readonlyDefault: true,
      promptAppend: null,
    }
    const dispatcher = new SubAgentDispatcher(
      new TeamModelRouter({
        resolve: () => ({
          runtimeOverride: { provider: model.provider, providerId: 'probe', model: 'probe' },
          trace: null,
        }),
      }),
      new WriteLeaseCoordinator(),
      { systemConfig, chatConfig },
      new SubAgentGuidanceRelayRegistry(),
      {
        defaultTypeId: 'probe',
        getDescriptor: () => descriptor,
        listDescriptors: () => [descriptor],
      }
    )
    const stack = createAgentExecutionStack({
      model: model.port,
      toolRegistry,
      query: { roleEngine: { resolve: () => resolution }, getToolNamesForCategories: () => [] },
    })
    stack.createRunner({
      contextHelper: { buildToolContext: () => createContext('runner') },
      primaryAgentProfile,
      subAgentDispatcher: dispatcher,
      configService: { systemConfig, chatConfig },
      codingSessionPolicy: { toolCategoryToolNames: {} },
      surfaceProfileProvider: {
        resolve: () => ({
          id: 'probe',
          toolPolicy: {
            baseCategories: [],
            includePromptFeatureCategories: false,
            restoreApprovedCategories: false,
          },
          allowSubAgents: true,
        }),
        deriveRunPolicy: () => ({
          activeSpace: 'default',
          initialToolCategories: [],
          initialActiveToolCategories: [],
          initialPromptFeatures: [],
          restoredApprovedCategories: [],
          allowSubAgents: true,
        }),
      },
    })
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
