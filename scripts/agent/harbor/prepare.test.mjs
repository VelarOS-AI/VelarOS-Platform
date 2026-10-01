import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { candidateModel } from './run.mjs'
import { validateCandidatePricing } from './candidate-pricing.mjs'

test('candidate requests use the exact frozen model and reasoning without a historic fallback', () => {
  for (const modelName of ['gpt-5.6-sol', 'fixture-future-model']) {
    const actual = candidateModel(
      { modelName, reasoningEffort: 'high' },
      { apiKey: 'fixture', baseURL: 'http://127.0.0.1:1/v1' }
    )
    assert.equal(actual.model, modelName)
    assert.equal(actual.reasoningLevel, 'high')
  }
  for (const identity of [
    {},
    { modelName: 'gpt-5.6-sol' },
    { modelName: 'gpt-5.6-sol', reasoningEffort: 'silent' },
    { modelName: 'openai/gpt-5.6-sol', reasoningEffort: 'high' },
  ]) {
    assert.throws(() => candidateModel(identity, {}), /explicitly frozen/)
  }
})

test('prepare requires explicit model and reasoning before packing or installing', () => {
  for (const args of [[], ['--model', 'gpt-5.6-sol'], ['--reasoning', 'high']]) {
    const result = spawnSync(
      process.execPath,
      [new URL('./prepare.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--(?:model|reasoning) must explicitly/)
  }
})

test('candidate preserves explicit disabled cache capability and rejects ambiguous settings', () => {
  const identity = { modelName: 'gpt-5.6-sol', reasoningEffort: 'high' }
  const credentials = { apiKey: 'fixture', baseURL: 'http://127.0.0.1:1/v1' }
  assert.equal(
    Object.hasOwn(candidateModel(identity, credentials), 'openaiExplicitCacheBreakpoints'),
    false
  )
  for (const value of [false, true])
    assert.equal(
      candidateModel({ ...identity, openaiExplicitCacheBreakpoints: value }, credentials)
        .openaiExplicitCacheBreakpoints,
      value
    )
  for (const value of ['false', 0, null])
    assert.throws(
      () => candidateModel({ ...identity, openaiExplicitCacheBreakpoints: value }, credentials),
      /must be boolean/
    )
  const invalid = spawnSync(
    process.execPath,
    [
      new URL('./prepare.mjs', import.meta.url).pathname,
      '--model',
      identity.modelName,
      '--reasoning',
      identity.reasoningEffort,
      '--openai-explicit-cache-breakpoints',
      'auto',
    ],
    { encoding: 'utf8' }
  )
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /must be enabled or disabled/)
})

test('candidate pricing binds explicit finite rates to the selected model and reasoning', () => {
  const pricing = {
    schema: 1,
    model: 'fixture-model',
    reasoning_effort: 'medium',
    service_tier: 'default',
    input: 4,
    cachedInput: 0.4,
    cacheWriteInput: 5,
    output: 20,
    longThreshold: 272000,
    longInputMultiplier: 2,
    longOutputMultiplier: 1.5,
    unit: 'USD per million tokens',
    source: 'fixture://verified',
    verified_at: '2026-09-30T00:00:00Z',
  }
  assert.deepEqual(validateCandidatePricing(pricing, 'fixture-model', 'medium'), pricing)
  for (const changes of [
    { model: 'other-model' },
    { reasoning_effort: 'high' },
    { output: undefined },
    { output: -1 },
    { output: NaN },
    { output: Infinity },
    { input: true },
    { unit: 'tokens' },
  ]) {
    assert.throws(
      () => validateCandidatePricing({ ...pricing, ...changes }, 'fixture-model', 'medium'),
      /Pricing must be/
    )
  }
})
