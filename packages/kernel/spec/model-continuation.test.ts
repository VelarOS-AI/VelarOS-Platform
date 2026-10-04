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
