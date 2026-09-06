import { describe, expect, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import {
  type ToolContractExecutionBinding,
  type ToolContractExecutionContext,
  ToolContractExecutionFacade,
  type ToolContractExecutionRegistry,
} from '../src/node/ToolContractExecutionFacade'
import {
  AgentProtocolVersion,
  ToolCatalogDiscoveryToolName,
  ToolSchemaDiscoveryToolName,
  type VelarToolCallEnvelope,
} from '../src/protocol'

const ProbeToolName = 'probe:read'
const ProbeSignature = 'probe:read@1'

function createHarness(options: {
  role?: string
  capabilities?: { effectKind: 'read' | 'write' }
  executionError?: AppError
} = {}) {
  const executed: Array<Record<string, unknown>> = []
  let visibleNames: string[] = []
  let visibleSignatures: Record<string, string> = {}
  let scopeRuns = 0

  const tool = {
    description: 'Read a probe value.',
    role: options.role ?? 'inspect',
    capabilities: options.capabilities,
    permissions: [],
    schema: {
      safeParse: (input: unknown) => ({
        success: true as const,
        data: input as Record<string, unknown>,
      }),
    },
    isConcurrencySafe: () => true,
    execute: (input: Record<string, unknown>) => {
      if (options.executionError) throw options.executionError
      executed.push(input)
      return { echo: input.value }
    },
  }
  const descriptor = {
    name: ProbeToolName,
    description: tool.description,
    role: tool.role,
    capabilities: tool.capabilities,
    permissions: [],
    categoryId: 'project-files' as const,
    systemEnabled: true,
  }
  const registry = {
    get: (name: string) => name === ProbeToolName ? tool : null,
    getRegistrationSignature: (name: string) =>
      name === ProbeToolName ? ProbeSignature : null,
    getCurrentRegistrationSignature: (name: string) =>
      name === ProbeToolName ? ProbeSignature : null,
    getDescriptor: (name: string) => name === ProbeToolName ? descriptor : null,
    listAvailable: () => [descriptor],
    describeToolInputSchema: (_context: unknown, name: string) =>
      name === ProbeToolName
        ? {
            profileId: 'base' as const,
            description: 'Exact probe schema.',
            schema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
              additionalProperties: false,
            },
          }
        : null,
  } as unknown as ToolContractExecutionRegistry<ToolContractExecutionContext>

  const codingSession = {
    recordToolResult: () => undefined,
    recordToolCallResult: () => undefined,
    getRedundantToolCallMessage: () => null,
    consumePendingAutoApprovalNotice: () => null,
    hasSessionToolCategoryApproval: () => true,
    getToolSurfaceProfile: () => 'full',
    setToolSurfaceProfile: (profile: string) => profile,
    getRunProfile: () => 'auto',
    setRunProfile: (profile: string) => profile,
    getActiveCapabilityScope: () => 'project',
  }
  const context = {
    abortSignal: new AbortController().signal,
    log: logRuntime.tag('ToolContractExecutionFacadeProbe'),
    role: { id: 'assistant' },
    execution: null,
    codingSession,
    getCurrentVisibleToolSurfaceProfile: () => null,
    getCurrentVisibleToolRegistrationSignature: (name: string) =>
      visibleSignatures[name] ?? null,
    setCurrentVisibleToolNames: (names: string[]) => {
      visibleNames = [...names]
    },
    setCurrentVisibleToolRegistrationSignatures: (signatures: Record<string, string>) => {
      visibleSignatures = { ...signatures }
    },
  } as unknown as ToolContractExecutionContext
  const binding: ToolContractExecutionBinding<ToolContractExecutionContext> = {
    toolContext: context,
    allowedToolNames: [ProbeToolName],
    hostProjection: {
      hostId: 'probe-host',
      includeCategories: null,
      excludeToolNames: null,
    },
    projectDescriptor: (input) => input,
    runInSessionScope: async (run) => {
      scopeRuns += 1
      return run()
    },
  }
  return {
    binding,
    executed,
    facade: new ToolContractExecutionFacade(registry),
    readScopeRuns: () => scopeRuns,
    readVisibleNames: () => visibleNames,
    readVisibleSignatures: () => visibleSignatures,
  }
}

function call(
  catalogRevision: string,
  toolName: string,
  input: Record<string, unknown> = {},
): VelarToolCallEnvelope {
  return {
    protocolVersion: AgentProtocolVersion,
    contractId: 'contract-1',
    catalogRevision,
    toolCallId: 'call-1',
    toolName,
    input,
  }
}

describe('ToolContractExecutionFacade', () => {
  test('classifies denied calls by structured code regardless of message language', async () => {
    for (const code of ['PERMISSION', 'PERMISSION_DENIED', 'EXECUTION_DENIED']) {
      const harness = createHarness({ executionError: new AppError(code, '当前工具调用未获授权') })
      const { catalogRevision } = harness.facade.resolveCatalog(harness.binding, { readOnly: false })
      const result = await harness.facade.executeTool(
        harness.binding,
        call(catalogRevision, ProbeToolName, { value: 'blocked' }),
        { readOnly: false, onProgress: () => undefined },
      )
      expect(result).toMatchObject({
        status: 'denied',
        error: '当前工具调用未获授权',
        output: { error: 'tool_denied', code },
      })
      expect(harness.executed).toEqual([])
    }
  })

  test('does not mistake permission-related prose in a runtime failure for an authorization denial', async () => {
    const harness = createHarness({ executionError: new AppError('IO', 'Could not read permission diagnostics') })
    const { catalogRevision } = harness.facade.resolveCatalog(harness.binding, { readOnly: false })
    await expect(harness.facade.executeTool(
      harness.binding,
      call(catalogRevision, ProbeToolName, { value: 'runtime-error' }),
      { readOnly: false, onProgress: () => undefined },
    )).resolves.toMatchObject({ status: 'error', output: { code: 'IO' } })
  })

  test('uses the same denial classification when the host scope rejects before tool execution', async () => {
    for (const code of ['PERMISSION', 'PERMISSION_DENIED', 'EXECUTION_DENIED']) {
      const harness = createHarness()
      const binding = {
        ...harness.binding,
        runInSessionScope: async () => { throw new AppError(code, '宿主拒绝进入执行作用域') },
      }
      const { catalogRevision } = harness.facade.resolveCatalog(binding, { readOnly: false })
      await expect(harness.facade.executeTool(
        binding,
        call(catalogRevision, ProbeToolName, { value: 'blocked' }),
        { readOnly: false, onProgress: () => undefined },
      )).resolves.toMatchObject({ status: 'denied', error: '宿主拒绝进入执行作用域' })
      expect(harness.executed).toEqual([])
    }
  })

  test('projects a deterministic catalog with both recovery tools', () => {
    const harness = createHarness()
    const first = harness.facade.resolveCatalog(harness.binding, { readOnly: false })
    const second = harness.facade.resolveCatalog(harness.binding, { readOnly: false })

    expect(first).toEqual(second)
    expect(first.catalogRevision).toHaveLength(20)
    expect(first.tools.map((tool) => tool.name)).toEqual([
      ToolCatalogDiscoveryToolName,
      ToolSchemaDiscoveryToolName,
      ProbeToolName,
    ])
    expect(first.tools.at(-1)).toMatchObject({
      description: 'Exact probe schema.',
      category: 'project-files',
      readOnly: true,
    })
  })

  test('uses capability effects as the read-only truth and role only as a fallback', () => {
    const memoryRead = createHarness({
      role: 'memory',
      capabilities: { effectKind: 'read' },
    })
    const mixedWrite = createHarness({
      role: 'inspect',
      capabilities: { effectKind: 'write' },
    })

    expect(
      memoryRead.facade.resolveCatalog(memoryRead.binding, { readOnly: true }).tools.at(-1)
    ).toMatchObject({ name: ProbeToolName, readOnly: true })
    expect(
      mixedWrite.facade.resolveCatalog(mixedWrite.binding, { readOnly: true }).tools.map((tool) => tool.name)
    ).toEqual([ToolCatalogDiscoveryToolName, ToolSchemaDiscoveryToolName])
    expect(
      mixedWrite.facade.resolveCatalog(mixedWrite.binding, { readOnly: false }).tools.at(-1)
    ).toMatchObject({ name: ProbeToolName, readOnly: false })
  })

  test('rejects stale and out-of-scope calls before entering the execution scope', async () => {
    const harness = createHarness()
    const { catalogRevision } = harness.facade.resolveCatalog(harness.binding, {
      readOnly: false,
    })

    await expect(
      harness.facade.executeTool(
        harness.binding,
        call('stale', ProbeToolName, { value: 'must-not-run' }),
        { readOnly: false, onProgress: () => undefined },
      ),
    ).resolves.toMatchObject({ status: 'lease-denied', reason: 'stale-revision' })
    await expect(
      harness.facade.executeTool(
        harness.binding,
        call(catalogRevision, 'probe:hidden'),
        { readOnly: false, onProgress: () => undefined },
      ),
    ).resolves.toMatchObject({ status: 'lease-denied', reason: 'out-of-scope' })

    expect(harness.executed).toEqual([])
    expect(harness.readScopeRuns()).toBe(0)
  })

  test('serves catalog/schema recovery and executes only through the standard policy path', async () => {
    const harness = createHarness()
    const { catalogRevision } = harness.facade.resolveCatalog(harness.binding, {
      readOnly: false,
    })
    const options = { readOnly: false, onProgress: () => undefined }

    await expect(
      harness.facade.executeTool(
        harness.binding,
        call(catalogRevision, ToolCatalogDiscoveryToolName),
        options,
      ),
    ).resolves.toMatchObject({
      status: 'success',
      output: { protocolVersion: AgentProtocolVersion, catalogRevision },
    })
    await expect(
      harness.facade.executeTool(
        harness.binding,
        call(catalogRevision, ToolSchemaDiscoveryToolName, {
          names: [ProbeToolName, 'missing'],
        }),
        options,
      ),
    ).resolves.toMatchObject({
      status: 'success',
      output: { missing: ['missing'] },
    })
    await expect(
      harness.facade.executeTool(
        harness.binding,
        call(catalogRevision, ProbeToolName, { value: 'executed' }),
        options,
      ),
    ).resolves.toMatchObject({
      status: 'success',
      output: { echo: 'executed' },
    })

    expect(harness.executed).toEqual([{ value: 'executed' }])
    expect(harness.readScopeRuns()).toBe(1)
    expect(harness.readVisibleNames()).toEqual([ProbeToolName])
    expect(harness.readVisibleSignatures()).toEqual({
      [ProbeToolName]: ProbeSignature,
    })
  })
})
