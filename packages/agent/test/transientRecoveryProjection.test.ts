import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import { projectTransientRecoveryHistory } from '../src/tools/recovery/TransientRecoveryProjection'

const decision: ModelMessage = {
  role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'edit-1', toolName: 'project:edit', input: {} }],
}
function failure(): ModelMessage {
  return {
    role: 'tool', content: [{
      type: 'tool-result', toolCallId: 'edit-1', toolName: 'project:edit',
      output: { type: 'json', value: {
        error: 'AMBIGUOUS_TARGET',
        details: { recovery: { kind: 'project-edit-candidates', candidates: [{ range: 42, match: 'private-source-marker' }] } },
        inputReuse: { reuse: 'attempt:edit-1' },
      } },
    }],
  }
}

describe('transient edit recovery context', () => {
  test('shows candidates for the next decision and preserves repeat-send determinism', () => {
    const messages = [decision, failure()]
    expect(projectTransientRecoveryHistory(messages)).toEqual(messages)
    expect(projectTransientRecoveryHistory(projectTransientRecoveryHistory(messages))).toEqual(messages)
  })

  test('archives detail after the next model step without mutating durable history', () => {
    const messages: ModelMessage[] = [decision, failure(), { role: 'assistant', content: 'Use the first target.' }]
    const projected = projectTransientRecoveryHistory(messages)
    expect(JSON.stringify(projected)).not.toContain('private-source-marker')
    expect(JSON.stringify(projected)).toContain('attempt:edit-1')
    expect(JSON.stringify(projected)).toContain('AMBIGUOUS_TARGET')
    expect(JSON.stringify(messages)).toContain('private-source-marker')
  })

  test('new user intent removes previous candidates; current failure still presents its own', () => {
    const messages: ModelMessage[] = [decision, failure(), { role: 'user', content: 'Change the other function.' }, decision, failure()]
    const projected = projectTransientRecoveryHistory(messages)
    expect(JSON.stringify(projected).match(/private-source-marker/g)).toHaveLength(1)
  })

  test('handles JSON text tool results without interpreting plain source strings', () => {
    const receipt = failure()
    if (receipt.role !== 'tool') throw new Error('test fixture')
    const part = receipt.content[0]
    if (part.type !== 'tool-result') throw new Error('test fixture')
    const messages: ModelMessage[] = [decision, {
      ...receipt,
      content: [{ ...part, output: { type: 'error-text', value: JSON.stringify(part.output.value) } }],
    }, { role: 'user', content: 'Continue' }]
    expect(JSON.stringify(projectTransientRecoveryHistory(messages))).not.toContain('private-source-marker')
  })
})


test.each(['json', 'error-json', 'text', 'error-text'] as const)('archives recovery through a %s ContextRef excerpt without changing its wrapper', (type) => {
  const original = failure() as Extract<ModelMessage, { role: 'tool' }>
  const part = original.content[0] as any
  const envelope = { __contextRef: 'tool-output', ref: 'output:edit-1', excerpt: JSON.stringify(part.output.value), retrieval: { tool: 'context:recall', args: { ref: 'output:edit-1' } } }
  part.output = { type, value: type.endsWith('text') ? JSON.stringify(envelope) : envelope }
  const current: ModelMessage[] = [decision, original]
  expect(projectTransientRecoveryHistory(current)).toEqual(current)
  const old: ModelMessage[] = [...current, { role: 'assistant', content: 'Continue with the target.' }]
  const projected = projectTransientRecoveryHistory(old)
  const shown = (projected[1]!.content as any[])[0].output
  expect(shown.type).toBe(type)
  const value = type.endsWith('text') ? JSON.parse(shown.value) : shown.value
  expect(typeof value.excerpt).toBe('string')
  expect(JSON.parse(value.excerpt).details.recovery.status).toBe('archived')
  expect(value.ref).toBe(envelope.ref)
  expect(value.retrieval).toEqual(envelope.retrieval)
  expect(JSON.stringify(old)).toContain('private-source-marker')
  expect(JSON.stringify(projected)).not.toContain('private-source-marker')
  expect(projectTransientRecoveryHistory(projected)).toEqual(projected)
})

test.each(['project-edit-candidates', 'project-edit-validation'])('never interprets source JSON or successful mutation %s data as failure metadata', (kind) => {
  for (const toolName of ['system:read', 'project:read', 'project:code', 'project:edit']) {
    const source = { recovery: { kind, candidates: ['actual-source-json'] } }
    const history: ModelMessage[] = [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'source', toolName,
      output: { type: 'text', value: JSON.stringify(source) },
    }] }, { role: 'assistant', content: 'Inspect the source.' }]
    expect(projectTransientRecoveryHistory(history)).toEqual(history)
  }
})

test.each(['json', 'error-json', 'text', 'error-text'] as const)('candidate syntax windows last one decision through direct and ContextRef %s payloads', (type) => {
  for (const wrapped of [false, true]) {
    const recovery = { kind: 'project-edit-validation', coordinateSpace: 'candidate', applied: false,
      windows: [{ path: 'source.ts', lines: [[120, 'candidate-only-source-marker']] }] }
    const failure = { error: 'tool_execution_failed', code: 'VALIDATION_FAILED',
      details: { executionOutcome: 'not-applied', diagnostics: [{ path: 'source.ts', line: 120 }], recovery },
      inputReuse: { reuse: 'attempt:edit-1' } }
    const envelope = { __contextRef: 'tool-output', ref: 'output:edit-1', excerpt: JSON.stringify(failure),
      retrieval: { tool: 'context:recall', args: { ref: 'output:edit-1' } } }
    const value = wrapped ? envelope : failure
    const output = { type, value: type.endsWith('text') ? JSON.stringify(value) : value }
    const current: ModelMessage[] = [decision, { role: 'tool', content: [{
      type: 'tool-result', toolCallId: 'edit-1', toolName: 'project:edit', output,
    }] } as ModelMessage]
    const original = JSON.stringify(current)
    expect(projectTransientRecoveryHistory(current)).toEqual(current)
    const projected = projectTransientRecoveryHistory([...current, { role: 'assistant', content: 'Repair the original range.' }])
    const shownOutput = (projected[1]!.content as any[])[0].output
    const shown = type.endsWith('text') ? JSON.parse(shownOutput.value) : shownOutput.value
    const result = wrapped ? JSON.parse(shown.excerpt) : shown
    expect(result.details.recovery).toMatchObject({ kind: 'project-edit-validation', status: 'archived' })
    expect(result.details.diagnostics).toEqual(failure.details.diagnostics)
    expect(result.inputReuse).toEqual(failure.inputReuse)
    expect(JSON.stringify(projected)).not.toContain('candidate-only-source-marker')
    expect(JSON.stringify(current)).toBe(original)
    expect(projectTransientRecoveryHistory(projected)).toEqual(projected)
    if (wrapped) expect(shown.retrieval).toEqual(envelope.retrieval)
  }
})

test.each([
  '{"error":"tool_execution_failed","details":{"recovery":{"kind":"project-edit-candidates","candidates":[...splice',
  '...splice... "window":{"lines":[[42,"candidate source tail"]]}}}',
])('unparseable failure excerpts retain recall without unusable candidate fragments: %s', (excerpt) => {
  const envelope = { __contextRef: 'tool-output', ref: 'output:original', excerpt, retrieval: { tool: 'context:recall', args: { ref: 'output:original' } } }
  const history: ModelMessage[] = [decision, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'edit-1', toolName: 'project:edit', output: { type: 'error-text', value: JSON.stringify(envelope) } }] }]
  const projected = projectTransientRecoveryHistory(history)
  const shown = JSON.parse((projected[1]!.content as any[])[0].output.value)
  expect(shown.excerpt).toBeUndefined()
  expect(shown.ref).toBe('output:original')
  expect(shown.retrieval).toEqual(envelope.retrieval)
  expect(JSON.stringify(history)).toContain('...splice')
})
