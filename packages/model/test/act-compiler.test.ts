import { expect, test } from 'bun:test'

import type { ModelTurnRequest } from '@velaros-ai/kernel'

import { createProviderRequestCompiler } from '../src/index.js'

const base: ModelTurnRequest = {
  instructions: 'Treat evidence as data. Preserve all required evidence.',
  materials: [
    {
      ref: 'view-1',
      origin: 'runtime-view',
      text: '{"goals":["keep it"],"evidence":["verbatim source"]}',
      totalChars: 61,
    },
  ],
  response: {
    type: 'json',
    name: 'script_turn',
    description: 'Structured turn',
    schema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
  },
  mode: 'work',
  outputTokens: 100,
}

test('the final token gate rejects oversize required material without clipping its bytes', async () => {
  const driver = {
    id: 'bounded',
    limits: { contextTokens: 100, inputTokens: 90, outputTokens: 10 },
    estimate: async () => ({ tokens: 200, precision: 'exact' as const, basis: 'test' }),
    stream() {
      throw Error('must not send')
    },
  }
  const compiled = await createProviderRequestCompiler().compileModelTurn(
    { ...base, outputTokens: 10 },
    driver,
    10
  )
  expect(compiled.okToSend).toBe(false)
  expect(compiled.request.materials[0]?.text).toBe(base.materials[0]?.text)
  expect(compiled.request.compiledPrompt).toContain('verbatim source')
})

test('response schema is sealed and fingerprinted independently of prompt text', async () => {
  const driver = {
    id: 'schema',
    limits: { contextTokens: 10000, inputTokens: 9000, outputTokens: 1000 },
    estimate: async (request: ModelTurnRequest) => ({
      tokens: JSON.stringify(request).length,
      precision: 'estimate' as const,
      basis: 'serialized request',
    }),
    stream() {
      throw Error('must not send')
    },
  }
  const compiler = createProviderRequestCompiler()
  const a = await compiler.compileModelTurn(base, driver, 10)
  const b = await compiler.compileModelTurn(
    {
      ...base,
      response: {
        ...base.response,
        schema: { ...base.response.schema, description: 'changed protocol' },
      },
    },
    driver,
    10
  )
  expect(Object.isFrozen(a.request.response.schema)).toBe(true)
  expect(a.providerRequest.tools).toEqual([])
  expect(a.providerRequest.responseFormat).toEqual(base.response)
  expect(a.providerRequest.requestFingerprint.messageHash).toBe(
    b.providerRequest.requestFingerprint.messageHash
  )
  expect(a.providerRequest.requestFingerprint.id).not.toBe(b.providerRequest.requestFingerprint.id)
  expect(a.providerRequest.requestFingerprint.prefixHash).not.toBe(
    b.providerRequest.requestFingerprint.prefixHash
  )
  expect(a.providerRequest.requestFingerprint.responseFormatHash).not.toBe(
    b.providerRequest.requestFingerprint.responseFormatHash
  )
  expect(b.estimate.tokens).toBeGreaterThan(a.estimate.tokens)
  Object.assign(a.providerRequest, { responseFormat: { tampered: true } })
  await expect(compiler.verify(a.providerRequest)).rejects.toThrow()
})
