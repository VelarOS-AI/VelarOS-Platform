import { expect, test } from 'bun:test'

import type { ModelHistoryMessage, ModelTurnRequest } from '../src/index.js'
import { modelRequestEncoder } from '../src/index.js'

test('INV-24 opaque continuation envelopes are bounded and kept separate from message text', () => {
  const state = { model: 'fixture', format: 'fixture-v1', data: 'opaque', tokens: 40 }
  expect(modelRequestEncoder.continuation(state)).toEqual(state)
  for (const value of [
    null,
    { ...state, tokens: -1 },
    { ...state, tokens: NaN },
    { ...state, data: '' },
    { ...state, data: 'x'.repeat(2_000_001) },
    { ...state, model: 12 },
    { ...state, format: '' },
  ])
    expect(() => modelRequestEncoder.continuation(value)).toThrow('模型延续状态封套无效')
  const request = {
    instructions: 'fixture',
    materials: [],
    response: { type: 'text' as const },
    mode: 'work' as const,
    outputTokens: 100,
    history: [{ role: 'assistant' as const, content: 'visible', continuation: state }],
  }
  const history = modelRequestEncoder.messages(request)
  expect(history[0]).toEqual(request.history[0])
  expect(history[0]).not.toBe(request.history[0])
  expect(modelRequestEncoder.encode(request)).not.toContain('opaque')
})

test('native result bodies bind once to the preceding response and preserve the logical history', () => {
  const call = { id: 'same-call-id', name: 'node', input: { code: 'console.log(7)' } }
  const exchange: ModelHistoryMessage = {
    role: 'assistant',
    content: 'native response',
    toolExchange: {
      text: '',
      calls: [call],
      results: [{ id: call.id, name: call.name, output: { recorded: true } }],
    },
  }
  const body: ModelHistoryMessage = {
    role: 'user',
    content: 'Observed result',
    toolResult: { callId: call.id, toolName: call.name },
  }
  const encode = (history: readonly ModelHistoryMessage[]) =>
    modelRequestEncoder.messages({
      instructions: '',
      materials: [],
      response: { type: 'text' },
      mode: 'work',
      outputTokens: 100,
      history,
    } satisfies ModelTurnRequest)
  const history = [exchange, body, exchange, { ...body, content: 'Later result' }]
  expect(encode(history).slice(0, history.length)).toEqual(history)
  expect(body.content).toBe('Observed result')
  for (const invalid of [
    [body],
    [exchange, body, body],
    [exchange, { ...body, toolResult: { callId: call.id, toolName: 'shell' } }],
    [exchange, { ...body, toolResult: { callId: 'missing', toolName: call.name } }],
    [exchange, { role: 'assistant' as const, content: 'Later response' }, body],
    [exchange, { ...body, content: [{ type: 'text' as const, text: 'Array content' }] }],
  ])
    expect(() => encode(invalid)).toThrow('工具结果正文必须与前一条响应的调用唯一配对')
})

test('INV-28 automatic history exposes actionable controls while capacity diagnostics stay on the request', () => {
  for (const phase of ['work', 'maintenance', 'finalizing'] as const) {
    const contextStatus = {
      mode: 'partitioned' as const,
      phase,
      frameId: 'current-frame',
      automaticHistory: true as const,
      pressure: 'critical' as const,
      inputTokens: 32760,
      precision: 'exact' as const,
      basis: 'fixture',
      inputLimit: 32768,
      outputReserve: 12000,
      safetyReserve: 4096,
      remainingTokens: 8,
      advice: 'capacity diagnostic',
      runway: { turns: 0, growthPerTurn: 2500 },
      segment: { index: 7, turns: 8, volumes: 6 },
      cache: { readTokens: 16000, writeTokens: 0 },
      overload: 'Reduce oversized working material',
      stall: { repeatedSteps: 3, advice: 'Change the repeated unsuccessful step' },
    }
    const original = structuredClone(contextStatus)
    const request: ModelTurnRequest = {
      instructions: 'Complete the user task.',
      materials: [{ ref: 'original', origin: 'user', text: 'Original task and constraints' }],
      response: { type: 'text' },
      mode: 'work',
      outputTokens: 12000,
      contextStatus,
    }
    const body = modelRequestEncoder.messages(request).at(-1)!.content as string
    const notice = JSON.parse(body.split('Runtime ContextStatus:\n')[1]!)
    expect(notice.phase).toBe(phase)
    expect(notice.mode).toBe('partitioned')
    expect(notice.history).toContain('自动')
    expect(notice.overload).toBe(contextStatus.overload)
    expect(notice.stall).toEqual(contextStatus.stall)
    for (const key of [
      'pressure',
      'inputTokens',
      'inputLimit',
      'outputReserve',
      'remainingTokens',
      'runway',
      'cache',
      'basis',
      'segment',
    ])
      expect(notice).not.toHaveProperty(key)
    expect(body).toContain('Original task and constraints')
    expect(contextStatus).toEqual(original)
    const { automaticHistory: _automaticHistory, ...manual } = contextStatus
    const legacy = modelRequestEncoder.messages({ ...request, contextStatus: manual }).at(-1)!
      .content as string
    expect(JSON.parse(legacy.split('Runtime ContextStatus:\n')[1]!)).toEqual(manual)
  }
})
