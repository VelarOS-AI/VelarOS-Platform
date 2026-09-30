import { expect, test } from 'bun:test'

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
