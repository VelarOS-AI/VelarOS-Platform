import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { decodeProviderRequestAuditValue } from '../src/agent/context/providerRequest/serialization'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { assertProviderRequestSnapshotReconstructable } from '../src/agent/context/ProviderRequestSnapshot'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import {
  parsePromptAuditText,
  serializePromptAuditLine,
} from '../src/kernel/observability/prompt-audit'

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
