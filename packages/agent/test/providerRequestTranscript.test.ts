import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { jsonSchema, type ModelMessage, tool, type ToolSet } from 'ai'
import { describe, test } from 'bun:test'

import { decodeProviderRequestAuditValue } from '../src/agent/context/providerRequest/serialization'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { assertProviderRequestSnapshotReconstructable } from '../src/agent/context/ProviderRequestSnapshot'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { ProviderTurnRequestHelper } from '../src/agent/ProviderTurnRequestHelper'
import {
  parsePromptAuditText,
  serializePromptAuditLine,
} from '../src/kernel/observability/prompt-audit'
import { ToolExecutionPolicy } from '../src/tools/ExecutionPolicy'

const fixtureUrl = new URL('./fixtures/provider-request-basic.json', import.meta.url)

function compileFixture(message = 'Inspect src/main.ts') {
  const compiler = new ProviderRequestCompiler(
    new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
  )
  return compiler.compile({
    model: 'fixture-model',
    systemPrompt: 'Use project:read before editing.',
    messages: [{ role: 'user', content: message }] as ModelMessage[],
    availableToolNames: ['project__read'],
    toolChoiceName: 'project__read',
    toolSchemaChars: { project__read: 128 },
    toolSchemaHashes: { project__read: 'schema-read-v1' },
    providerTools: [
      {
        name: 'project__read',
        canonicalName: 'project:read',
        description: 'Read a project file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        schemaChars: 128,
        schemaHash: 'schema-read-v1',
      },
    ],
    providerToolChoice: { type: 'tool', toolName: 'project__read' },
    toolNameAliases: { 'project:read': 'project__read' },
    contextWindow: 200_000,
  })
}

void describe('provider request transcript', () => {
  void test('locks the fully assembled model-visible request without provider credentials', async () => {
    const expected = JSON.parse(await readFile(fixtureUrl, 'utf8'))
    const compiled = compileFixture()

    assert.deepEqual(compiled.providerRequest, expected)
    assertProviderRequestSnapshotReconstructable(compiled.providerRequest)
    assert.deepEqual(decodeProviderRequestAuditValue(compiled.providerRequest.messages), [
      { content: 'Inspect src/main.ts', role: 'user' },
    ])
  })

  void test('changes request identity when content changes under the same role sequence', () => {
    const first = compileFixture('Inspect src/main.ts')
    const second = compileFixture('Inspect src/other.ts')

    assert.deepEqual(first.requestFingerprint.roleSequence, second.requestFingerprint.roleSequence)
    assert.notEqual(first.requestFingerprint.messageHash, second.requestFingerprint.messageHash)
    assert.notEqual(first.requestFingerprint.id, second.requestFingerprint.id)
  })

  void test('fails before send when the visible tool surface cannot be reconstructed', () => {
    const compiled = compileFixture()
    compiled.providerRequest.tools = []

    assert.throws(
      () => assertProviderRequestSnapshotReconstructable(compiled.providerRequest),
      /无法从审计快照完整重建/
    )
  })

  void test('fails before send when a visible tool has no exact schema', () => {
    const compiled = compileFixture()
    compiled.providerRequest.tools[0].inputSchema = null

    assert.throws(
      () => assertProviderRequestSnapshotReconstructable(compiled.providerRequest),
      /tool schemas are missing/
    )
  })

  for (const mutation of ['unload', 'replace'] as const) {
    void test(`keeps the sent schema after provider ${mutation} during context preparation`, async () => {
      const originalSchema = {
        type: 'object' as const,
        properties: { path: { type: 'string' as const } },
        required: ['path'],
        additionalProperties: false,
      }
      const liveTools: ToolSet = {
        project__read: tool({
          description: 'Read a project file.',
          inputSchema: jsonSchema(async () => {
            await Promise.resolve()
            return originalSchema
          }),
        }),
      }
      const turnTools = { ...liveTools }
      let currentSignature: string | null = 'read-v1'
      const helper = new ProviderTurnRequestHelper({} as never, 'stream')
      // StreamTurn awaits this host read after producing aiTools from its turn registry.
      await helper.resolveContextWorkingSetInputs({
        activeContext: {
          listActiveContextArtifacts: async () => {
            await Promise.resolve()
            if (mutation === 'unload') {
              delete liveTools.project__read
              currentSignature = null
            } else {
              liveTools.project__read = tool({
                description: 'Replacement contract.',
                inputSchema: jsonSchema({
                  type: 'object',
                  properties: { replacement: { type: 'number' } },
                  required: ['replacement'],
                }),
              })
              currentSignature = 'read-v2'
            }
            liveTools.next_turn_only = tool({ inputSchema: jsonSchema({ type: 'object' }) })
            return []
          },
        },
      })
      const definitions = await helper.resolveProviderToolDefinitions(
        turnTools,
        {
          canonicalToProvider: { 'project:read': 'project__read' },
          providerToCanonical: { project__read: 'project:read' },
        },
        { project__read: 128 },
        { project__read: 'schema-read-v1' }
      )

      assert.deepEqual(definitions.map((definition) => definition.name), ['project__read'])
      assert.equal(definitions[0].description, 'Read a project file.')
      assert.deepEqual(definitions[0].inputSchema, originalSchema)
      const compiler = new ProviderRequestCompiler(
        new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
      )
      const compiled = compiler.compile({
        model: 'fixture-model',
        systemPrompt: 'Read the file.',
        messages: [{ role: 'user', content: 'Inspect src/main.ts' }],
        availableToolNames: ['project__read'],
        providerTools: definitions,
        toolSchemaChars: { project__read: 128 },
        contextWindow: 200_000,
      })
      assertProviderRequestSnapshotReconstructable(compiled.providerRequest)

      // Snapshot fidelity does not authorize an implementation whose live claim changed.
      const policy = new ToolExecutionPolicy({
        get: () => undefined,
        getDescriptor: () => null,
        listAvailable: () => [],
        getRegistrationSignature: () => 'read-v1',
        getCurrentRegistrationSignature: () => currentSignature,
      })
      const decision = policy.prepareExecution({
        toolName: 'project:read',
        args: { path: 'src/main.ts' },
        baseContext: { getCurrentVisibleToolRegistrationSignature: () => 'read-v1' },
        abortSignal: new AbortController().signal,
        emitProgress: () => undefined,
        updateMetadata: () => undefined,
      } as never)
      assert.deepEqual(decision, { allowed: false, error: 'Stale tool call: project:read' })
    })
  }

  void test('fails locally before provider send when any compiled tool name is invalid', () => {
    const compiler = new ProviderRequestCompiler(
      new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    )
    const messages: ModelMessage[] = [
      { role: 'user', content: 'run status' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'system:run',
            input: { command: 'git status' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'system:run',
            output: { type: 'text', value: 'clean' },
          },
        ],
      },
      { role: 'user', content: 'continue' },
    ]

    assert.throws(
      () =>
        compiler.compile({
          model: 'fixture-model',
          systemPrompt: 'system',
          messages,
          contextWindow: 200_000,
        }),
      /provider history contains invalid tool names: system:run/
    )
  })

  void test('rewrites a page-out historical tool before it reaches the provider input', () => {
    const helper = new ProviderTurnRequestHelper({} as never, 'stream')
    const transportPlan = helper.captureToolTransportPlan({
      getCurrentVisibleToolTransportNames: () => ({
        'tooling:map': 'tooling__map',
      }),
    })
    const requestAliases = helper.resolveProviderRequestToolNameAliases(transportPlan, [
      'system:run',
    ])
    const compiler = new ProviderRequestCompiler(
      new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    )
    const compiled = compiler.compile({
      model: 'fixture-model',
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'run status' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'system:run',
              input: { command: 'git status' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'system:run',
              output: { type: 'text', value: 'clean' },
            },
          ],
        },
        { role: 'user', content: 'continue' },
      ] as ModelMessage[],
      availableToolNames: ['tooling__map'],
      toolSchemaChars: { tooling__map: 64 },
      toolNameAliases: requestAliases,
      contextWindow: 200_000,
    })

    assert.deepEqual(compiled.requestFingerprint.historyToolNames, ['system__run'])
    assert.equal(transportPlan.providerToCanonical.system__run, undefined)
  })

  void test('persists the assembled request in the prompt audit sidecar', () => {
    const compiled = compileFixture()
    const record = {
      capturedAt: 1,
      sessionId: 'session-1',
      runId: 'run-1',
      requestFingerprint: compiled.requestFingerprint.id,
      turn: 1,
      roleId: 'operator',
      model: 'fixture-model',
      systemPrompt: compiled.system,
      promptSegments: [],
      skippedPromptSegments: [],
      capabilityContextAudit: [],
      providerRequest: compiled.providerRequest,
    }

    const parsed = parsePromptAuditText(serializePromptAuditLine(record), 'fixture.prompts.jsonl')
    assert.equal(parsed.truncatedTail, false)
    assert.deepEqual(parsed.records, [record])
  })
})
