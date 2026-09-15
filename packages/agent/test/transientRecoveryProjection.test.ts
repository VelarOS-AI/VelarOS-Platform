import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { compactToolInputForModel } from '../src/tools'
import { readReusableAttemptInput, saveToolAttemptInput, saveToolAttemptOutcome } from '../src/tools/recovery/ToolInputReuse'
import { projectTransientRecoveryHistory, restoreReusableInputsForNextDecision } from '../src/tools/recovery/TransientRecoveryProjection'

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

describe('the next decision sees the full input it is asked to correct', () => {
  const body = `  run() {\n${'    // 中文🙂 C:\\src\\path 字面 \\n\n'.repeat(60)}  }`
  const original = { files: [{ fileRef: 'view:abc', edits: [{ op: 'replace', range: [2, 4], text: body }] }] }
  const call = (id: string): ModelMessage => ({
    role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'project:edit', input: compactToolInputForModel(original, id) }],
  })
  const receipt = (id: string, extra: Record<string, unknown> = {}): ModelMessage => ({
    role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'project:edit', output: { type: 'error-text', value: JSON.stringify({
      error: 'tool_execution_failed', code: 'VALIDATION_FAILED', executionOutcome: 'not-applied',
      inputReuse: { reuse: `attempt:${id}` }, ...extra,
    }) } }],
  })
  const inputOf = (messages: ModelMessage[], id: string) => messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((part: any) => part.type === 'tool-call' && part.toolCallId === id) as { input: Record<string, unknown> }
  const reader = (inputs: Record<string, Record<string, unknown>>) => async (id: string) => inputs[id]

  test('restores only the latest decision, keeps durable history, and is stable on repeat sends', async () => {
    expect(JSON.stringify(inputOf([call('edit-1')], 'edit-1').input)).not.toContain('字面')
    const messages = [call('edit-1'), receipt('edit-1')]
    const durable = JSON.stringify(messages)
    const first = await restoreReusableInputsForNextDecision(messages, reader({ 'edit-1': original }))
    expect(inputOf(first.messages, 'edit-1').input).toEqual(original)
    expect([...first.restoredToolCallIds]).toEqual(['edit-1'])
    expect(JSON.stringify(messages)).toBe(durable)
    expect(await restoreReusableInputsForNextDecision(messages, reader({ 'edit-1': original }))).toEqual(first)
    const later: ModelMessage[] = [...messages, { role: 'assistant', content: 'Retrying with a corrected range.' }]
    expect(inputOf((await restoreReusableInputsForNextDecision(later, reader({ 'edit-1': original }))).messages, 'edit-1').input.__historyInputOmissions).toBeDefined()
  })

  test('unknown or completed outcomes, foreign reuse references and oversized inputs stay omitted', async () => {
    const cases: Array<[ModelMessage[], Record<string, Record<string, unknown>>]> = [
      [[call('edit-1'), receipt('edit-1', { executionOutcome: 'unknown' })], { 'edit-1': original }],
      [[call('edit-1'), receipt('edit-1', { inputReuse: { reuse: 'attempt:other' } })], { 'edit-1': original }],
      [[call('edit-1'), receipt('edit-1')], {}],
      [[call('edit-1'), receipt('edit-1')], { 'edit-1': { files: [{ fileRef: 'view:abc', edits: [{ op: 'replace', range: 1, text: 'x'.repeat(40_000) }] }] } }],
    ]
    for (const [messages, inputs] of cases)
      expect(inputOf((await restoreReusableInputsForNextDecision(messages, reader(inputs))).messages, 'edit-1').input.__historyInputOmissions).toBeDefined()
  })

  test('the stored attempt record is the source, and only a not-applied outcome is readable', async () => {
    const store = new InMemoryContextPayloadStore()
    const context = { sessionId: 's', contextPayloadStore: store, resourceId: '/repo' }
    await saveToolAttemptInput(context, 'edit-1', 'project:edit', original, 2)
    expect(await readReusableAttemptInput(store, 's', 'edit-1')).toBeUndefined()
    await saveToolAttemptOutcome(context, 'edit-1', 'not-applied')
    expect(await readReusableAttemptInput(store, 's', 'edit-1')).toEqual(original)
    await saveToolAttemptInput(context, 'edit-2', 'project:edit', original, 2)
    await saveToolAttemptOutcome(context, 'edit-2', 'unknown')
    expect(await readReusableAttemptInput(store, 's', 'edit-2')).toBeUndefined()
    expect(await readReusableAttemptInput(store, 'other-session', 'edit-1')).toBeUndefined()
  })
})

test('the compiled provider request keeps the restored input through structure repair, then omits it after the next decision', async () => {
  const store = new InMemoryContextPayloadStore()
  const context = { sessionId: 's', contextPayloadStore: store, codingSession: {} }
  const input = { files: [{ fileRef: 'view:x', edits: [{ op: 'replace', range: [2, 4], text: `${'正文🙂 '.repeat(600)}end` }] }] }
  await saveToolAttemptInput(context, 'c1', 'project:edit', input, 2)
  await saveToolAttemptOutcome(context, 'c1', 'not-applied')
  const history: ModelMessage[] = [
    { role: 'user', content: 'Apply the change.' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'project:edit', input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'project:edit', output: { type: 'error-text', value: JSON.stringify({
      error: 'tool_execution_failed', code: 'VALIDATION_FAILED', executionOutcome: 'not-applied', inputReuse: { reuse: 'attempt:c1' },
    }) } }] },
  ]
  const compiler = new ProviderRequestCompiler(new ContextGovernanceSessionRegistry({ config: { dashboard: false } }))
  const send = () => compileProviderSendRequest({
    sessionId: 's', rawHistoryMessages: history, toolContext: context as never, payloadStore: store,
    model: 'gpt-test', systemPrompt: 'system', contextWindow: 64000, phase: 'stream',
    availableToolNames: ['project_edit'], toolNameAliases: { 'project:edit': 'project_edit' },
  }, compiler)
  const callInput = (messages: ModelMessage[]) => (messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((part: any) => part.type === 'tool-call' && part.toolCallId === 'c1') as { input: Record<string, unknown> }).input
  const first = await send()
  expect(first.decision.okToSend).toBe(true)
  expect(callInput(first.messages)).toEqual(input)
  history.push({ role: 'user', content: 'Continue with the corrected range.' })
  const later = await send()
  expect(callInput(later.messages).__historyInputOmissions).toBeDefined()
  expect(JSON.stringify(callInput(later.messages))).not.toContain('正文')
  // 活动历史按既有约定被清洗写回；完整参数的权威来源是 attempt 记录，还原只从那里读取。
  expect(await readReusableAttemptInput(store, 's', 'c1')).toEqual(input)
})
