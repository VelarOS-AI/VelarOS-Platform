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
  expect(a.requestAudit.toolCount).toBe(0)
  expect(a.request.response).toEqual(base.response)
  expect(a.requestAudit.requestFingerprint.messageHash).toBe(
    b.requestAudit.requestFingerprint.messageHash
  )
  expect(a.requestAudit.requestFingerprint.id).not.toBe(b.requestAudit.requestFingerprint.id)
  expect(a.requestAudit.requestFingerprint.prefixHash).not.toBe(
    b.requestAudit.requestFingerprint.prefixHash
  )
  expect(a.requestAudit.requestFingerprint.responseFormatHash).not.toBe(
    b.requestAudit.requestFingerprint.responseFormatHash
  )
  expect(b.estimate.tokens).toBeGreaterThan(a.estimate.tokens)
})

test('request audit stays bounded as live history grows and retains no request body', async () => {
  const secret = 'PRIVATE_USER_MATERIAL_审计不得复制'
  const driver = {
    id: 'model-id'.repeat(100),
    limits: { contextTokens: 1_000_000, inputTokens: 900_000, outputTokens: 1000 },
    estimate: async () => ({
      tokens: 200,
      precision: 'estimate' as const,
      basis: '计量'.repeat(1000),
    }),
    stream() {
      throw Error('must not send')
    },
  }
  const compiler = createProviderRequestCompiler()
  const sizes = []
  for (const count of [1, 64, 256]) {
    const history = Array.from({ length: count }, () => ({
      role: 'user' as const,
      content: secret.repeat(100),
    }))
    const compiled = await compiler.compileModelTurn({ ...base, history }, driver, 10)
    const audit = JSON.stringify(compiled.requestAudit)
    sizes.push(audit.length)
    expect(audit.length).toBeLessThan(2000)
    expect(audit).not.toContain(secret)
    expect(Object.keys(compiled.requestAudit).sort()).toEqual(
      [
        'basis',
        'basisTruncated',
        'inputTokens',
        'messageCount',
        'model',
        'modelTruncated',
        'outputTokens',
        'precision',
        'requestFingerprint',
        'schemaVersion',
        'toolCount',
      ].sort()
    )
    expect(compiled.request.history?.at(-1)?.content).toBe(secret.repeat(100))
    expect(compiled.requestAudit.modelTruncated).toBe(true)
    expect(compiled.requestAudit.basisTruncated).toBe(true)
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(8)
})
