import assert from 'node:assert/strict'

import {
  CodingSessionTracker,
  ExecutionEventBus,
  PrimaryAgentProfile,
} from '@velaros-ai/agent'
import { AgentRuntimeEvents } from '@velaros-ai/agent/host'
import { ToolContractExecutionFacade } from '@velaros-ai/agent/node'
import {
  AgentProtocolVersion,
  ToolCatalogDiscoveryToolName,
  ToolSchemaDiscoveryToolName,
} from '@velaros-ai/agent/protocol'
import { createAgentExecutionStack } from '@velaros-ai/agent/runtime'
import { logRuntime } from '@velaros-ai/core/logger'
import {
  createInMemoryMemoryFilesIo,
  createMemoryFilesBackend,
} from '@velaros-ai/memory/files'
import { mountMemoryAdapter } from '@velaros-ai/memory/adapter-kernel'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
}
const doGenerateCalls = []
const doStreamCalls = []
let heldStreamStart = null
const model = {
  specificationVersion: 'v3',
  provider: 'packed-fixture',
  modelId: 'packed-fixture',
  get supportedUrls() {
    return Promise.resolve({})
  },
  async doGenerate(options) {
    doGenerateCalls.push(options)
    return {
      content: [{ type: 'text', text: 'packed complete' }],
      usage,
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
    }
  },
  async doStream(options) {
    doStreamCalls.push(options)
    if (heldStreamStart) {
      const notifyStarted = heldStreamStart
      heldStreamStart = null
      return {
        stream: new ReadableStream({
          start(controller) {
            const abortSignal = options.abortSignal
            const abort = () => controller.error(
              abortSignal?.reason ?? new Error('packed stream aborted'),
            )
            if (abortSignal?.aborted) abort()
            else abortSignal?.addEventListener('abort', abort, { once: true })
            notifyStarted()
          },
        }),
      }
    }
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'packed complete' },
            { type: 'text-end', id: 'text' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            },
          ]) controller.enqueue(chunk)
          controller.close()
        },
      }),
    }
  },
}

const provider = () => model
const modelPort = {
  createAgentProvider: () => provider,
  resolveRoleRuntime: async () => ({
    provider,
    providerId: 'packed-fixture',
    model: 'packed-fixture',
    providerModel: 'packed-fixture',
    contextWindow: 128_000,
    supportedInputModalities: ['text'],
    resolutionSource: 'packed-fixture',
    resolutionTrace: [],
  }),
}
const toolRegistry = {
  names: [],
  get: () => null,
  getDescriptor: () => null,
  listAvailable: () => [],
  toAiTools: () => ({}),
}
const primaryAgentProfile = new PrimaryAgentProfile(
  { getSkillMarkdownForRole: () => '', listSkillsForRole: () => [] },
  { getToolCategoryId: () => 'packed-fixture' },
)
const resolution = primaryAgentProfile.resolve({
  knownToolNames: [],
  allowSubAgents: false,
})
const chatConfig = {
  modelSelection: { hostModel: 'packed-fixture' },
  systemPromptAppend: '',
}
const systemConfig = {
  thinkingDepth: 'balanced',
  disabledToolNames: [],
  prompt: { segmentOverrides: [] },
  advancedRuntime: {},
  modelRuntimeContext: { host: 'packed-fixture' },
}

function createToolContext(sessionId, abortController = new AbortController()) {
  let visibleToolNames = []
  let modalities = ['text']
  return {
    sessionId,
    locale: 'en-US',
    abortSignal: abortController.signal,
    log: logRuntime.tag('PackedHostContract'),
    codingSession: new CodingSessionTracker([], []),
    role: {
      id: resolution.id,
      label: resolution.label,
      description: '',
      nextAllowedRoles: [],
    },
    execution: null,
    interaction: {
      getCurrentPlan: () => [],
      getCurrentExecutionAdvice: () => null,
    },
    activeContext: {
      listActiveContextArtifacts: async () => [],
      upsertActiveContextArtifact: async () => {
        throw new Error('packed fixture has no goal artifacts')
      },
    },
    listTools: () => [],
    listToolCategories: () => [],
    getEnabledToolCategories: () => [],
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolNames: () => visibleToolNames,
    setCurrentVisibleToolNames: (names) => {
      visibleToolNames = [...names]
    },
    getSupportedModelInputModalities: () => modalities,
    setSupportedModelInputModalities: (next) => {
      modalities = [...next]
    },
    query: async () => {
      throw new Error('nested delegation is disabled in the packed fixture')
    },
  }
}

async function probeAgentExecution() {
  assert.equal(typeof AgentRuntimeEvents, 'function')
  const stack = createAgentExecutionStack({
    model: modelPort,
    toolRegistry,
    query: {
      roleEngine: { resolve: () => resolution },
      getToolNamesForCategories: () => [],
    },
  })
  const soloAbort = new AbortController()
  const history = [{ role: 'user', content: 'finish the packed solo probe' }]
  const solo = await stack.executeSolo({
    history,
    config: { sessionId: 'packed-solo', modelSelection: chatConfig.modelSelection },
    chatConfig,
    systemConfig,
    abortController: soloAbort,
    toolContext: createToolContext('packed-solo', soloAbort),
    resolution,
    events: new ExecutionEventBus(),
  })
  assert.equal(solo.status, 'completed')
  assert.match(JSON.stringify(history), /packed complete/u)

  const query = await stack.executeQuery({
    task: 'finish the packed query probe',
    opts: { contextEpochScope: 'packed-query' },
    parentCtx: createToolContext('packed-query'),
    chatConfig,
    systemConfig,
    collectCapabilityContext: async () => null,
  })
  assert.equal(query, 'packed complete')

  const cancelledController = new AbortController()
  const cancelledHistory = [{ role: 'user', content: 'cancel the active packed model stream' }]
  const streamStarted = new Promise((resolve) => {
    heldStreamStart = resolve
  })
  const cancellation = stack.executeSolo({
    history: cancelledHistory,
    config: { sessionId: 'packed-cancelled', modelSelection: chatConfig.modelSelection },
    chatConfig,
    systemConfig,
    abortController: cancelledController,
    toolContext: createToolContext('packed-cancelled', cancelledController),
    resolution,
    events: new ExecutionEventBus(),
  })
  await streamStarted
  cancelledController.abort(new Error('packed cancellation'))
  const cancelled = await cancellation
  assert.equal(cancelled.status, 'aborted')
  assert.equal(doStreamCalls.length, 3)
  assert.equal(doGenerateCalls.length, 0)
  assert.equal(cancelledHistory.some(({ role }) => role === 'assistant'), false)
  stack.clearSession('packed-solo')
}

function createToolContractHarness() {
  const toolName = 'fixture:echo'
  let schemaVersion = 1
  const executed = []
  let visibleSignatures = {}
  const tool = {
    description: 'Echo a packed fixture value.',
    role: 'inspect',
    permissions: [],
    schema: {
      safeParse: (input) => ({ success: true, data: input }),
    },
    isConcurrencySafe: () => true,
    execute: (input) => {
      executed.push(input)
      return { echo: input.value, schemaVersion }
    },
  }
  const registry = {
    get: (name) => name === toolName ? tool : null,
    getRegistrationSignature: (name) =>
      name === toolName ? `${toolName}@${schemaVersion}` : null,
    getCurrentRegistrationSignature: (name) =>
      name === toolName ? `${toolName}@${schemaVersion}` : null,
    getDescriptor: (name) => name === toolName ? {
      name: toolName,
      description: tool.description,
      role: tool.role,
      permissions: [],
      categoryId: 'project-files',
      systemEnabled: true,
    } : null,
    listAvailable: () => [{
      name: toolName,
      description: tool.description,
      role: tool.role,
      permissions: [],
      categoryId: 'project-files',
      systemEnabled: true,
    }],
    describeToolInputSchema: (_context, name) => name === toolName ? {
      profileId: 'base',
      description: `Packed echo schema v${schemaVersion}.`,
      schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
          schemaVersion: { const: schemaVersion },
        },
        required: ['value'],
        additionalProperties: false,
      },
    } : null,
  }
  const codingSession = {
    recordToolResult: () => undefined,
    recordToolCallResult: () => undefined,
    getRedundantToolCallMessage: () => null,
    consumePendingAutoApprovalNotice: () => null,
    hasSessionToolCategoryApproval: () => true,
    getToolSurfaceProfile: () => 'full',
    setToolSurfaceProfile: (profile) => profile,
    getRunProfile: () => 'auto',
    setRunProfile: (profile) => profile,
    getActiveCapabilityScope: () => 'project',
  }
  const context = {
    abortSignal: new AbortController().signal,
    log: logRuntime.tag('PackedToolContract'),
    role: { id: 'assistant' },
    execution: null,
    codingSession,
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolRegistrationSignature: (name) =>
      visibleSignatures[name] ?? null,
    setCurrentVisibleToolNames: () => undefined,
    setCurrentVisibleToolRegistrationSignatures: (signatures) => {
      visibleSignatures = { ...signatures }
    },
  }
  const binding = {
    toolContext: context,
    allowedToolNames: [toolName],
    hostProjection: {
      hostId: 'packed-host',
      includeCategories: null,
      excludeToolNames: null,
    },
    projectDescriptor: (descriptor) => descriptor,
    runInSessionScope: async (run) => run(),
  }
  return {
    binding,
    executed,
    facade: new ToolContractExecutionFacade(registry),
    setSchemaVersion: (version) => {
      schemaVersion = version
    },
    toolName,
  }
}

function toolCall(catalogRevision, toolName, input = {}) {
  return {
    protocolVersion: AgentProtocolVersion,
    contractId: 'packed-contract',
    catalogRevision,
    toolCallId: 'packed-call',
    toolName,
    input,
  }
}

async function probeToolContracts() {
  const harness = createToolContractHarness()
  const first = harness.facade.resolveCatalog(harness.binding, { readOnly: false })
  assert.deepEqual(first.tools.slice(0, 2).map(({ name }) => name), [
    ToolCatalogDiscoveryToolName,
    ToolSchemaDiscoveryToolName,
  ])

  harness.setSchemaVersion(2)
  const second = harness.facade.resolveCatalog(harness.binding, { readOnly: false })
  assert.notEqual(second.catalogRevision, first.catalogRevision)
  const stale = await harness.facade.executeTool(
    harness.binding,
    toolCall(first.catalogRevision, harness.toolName, { value: 'stale' }),
    { readOnly: false, onProgress: () => undefined },
  )
  assert.deepEqual(
    { status: stale.status, reason: stale.reason },
    { status: 'lease-denied', reason: 'stale-revision' },
  )

  const completed = await harness.facade.executeTool(
    harness.binding,
    toolCall(second.catalogRevision, harness.toolName, { value: 'paired' }),
    { readOnly: false, onProgress: () => undefined },
  )
  assert.deepEqual(
    {
      protocolVersion: completed.protocolVersion,
      contractId: completed.contractId,
      catalogRevision: completed.catalogRevision,
      toolCallId: completed.toolCallId,
      toolName: completed.toolName,
      status: completed.status,
      output: completed.output,
    },
    {
      protocolVersion: AgentProtocolVersion,
      contractId: 'packed-contract',
      catalogRevision: second.catalogRevision,
      toolCallId: 'packed-call',
      toolName: harness.toolName,
      status: 'success',
      output: { echo: 'paired', schemaVersion: 2 },
    },
  )
  assert.deepEqual(harness.executed, [{ value: 'paired' }])
}

async function probeIndependentMemoryBackend() {
  const io = createInMemoryMemoryFilesIo()
  const backend = createMemoryFilesBackend({
    roots: [{ scopeType: 'global', scopeId: 'global', directory: '/memory' }],
    io,
    now: () => 1_700_000_000_000,
  })
  const adapter = mountMemoryAdapter({
    backend,
    config: {
      isEnabled: () => true,
      isBackgroundGrowthEnabled: () => false,
      allowBatteryGrowth: () => false,
      isAutomaticDeepRecallEnabled: () => false,
      isChatCaptureEnabled: () => true,
      isWorkspaceCaptureEnabled: () => true,
      isComputerUseCaptureEnabled: () => true,
      isExecutionCaptureEnabled: () => true,
    },
    hostContext: {
      resolveScope: () => ({ scopeType: 'global', scopeId: 'global' }),
      turnContextScopes: ['system'],
    },
  })
  assert.equal(adapter.service, null)
  assert.equal(adapter.storeDescriptor.id, 'files')
  assert.equal(adapter.isDefaultStore, false)

  const captured = await adapter.store.capture({
    sourceType: 'user_correction',
    trustLevel: 'user_stated',
    sourceId: 'packed-memory-1',
    title: 'Packed memory contract',
    content: 'The packed host keeps independent memory backends.',
    category: 'fact',
    scopeType: 'global',
    scopeId: 'global',
  })
  assert.equal(captured.inserted, true)
  const recalled = await adapter.store.recall('independent memory', { limit: 3 })
  assert.equal(recalled.length, 1)
  assert.equal(recalled[0].id, captured.evidence.id)
  const archived = await adapter.store.archive(captured.evidence.id)
  assert.equal(archived.claimId, captured.evidence.id)
  assert.deepEqual(await adapter.store.recall('independent memory', { limit: 3 }), [])
  assert.equal((await adapter.store.getItem(captured.evidence.id))?.id, captured.evidence.id)
  assert.ok(Object.keys(io.snapshot()).some((name) => name.endsWith('.md')))
}

await probeAgentExecution()
await probeToolContracts()
await probeIndependentMemoryBackend()

console.info('✓ packed runtime contracts: Solo/Query, cancellation, tool pairing, schema refresh and independent Memory backend')
