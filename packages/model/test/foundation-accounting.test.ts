import { expect, test } from 'bun:test'

import {
  resolveProviderModelContextWindow,
  resolveProviderScriptContextWindow,
} from '../src/utils/catalog/context-windows'
import {
  findPricingRates,
  normalizePersistedUsage,
  normalizeRunUsage,
  summarizeUsage,
} from '../src/utils/usage'

test('unknown model family aliases do not acquire a guessed context window', () => {
  for (const model of ['gpt-5.6-sol', 'gpt-5.6']) {
    expect(resolveProviderModelContextWindow('openai', model)).toBe(1_050_000)
    expect(resolveProviderModelContextWindow('openrouter', `openai/${model}`)).toBe(1_050_000)
    expect(resolveProviderModelContextWindow('openai', `${model}-private-8k`)).toBeNull()
    expect(resolveProviderModelContextWindow('custom', model)).toBeNull()
  }
  for (const name of [
    'gpt-5-private-8k',
    'gpt-5.99-unregistered',
    'gpt-4.1-private',
    'gpt-5:8k',
    'gpt-5@private',
    'gpt-5',
  ])
    expect(resolveProviderModelContextWindow('custom', name)).toBeNull()
  expect(
    resolveProviderScriptContextWindow({
      providerId: 'custom',
      runtimeModel: 'gpt-5-private',
      metadata: { contextWindow: 8_000 },
    })
  ).toBe(8_000)
})

test('cache read and write token buckets use their own rates', () => {
  const rates = findPricingRates(
    {
      currency: 'USD',
      version: 'fixture',
      updatedAt: '',
      expiresAt: '',
      entries: [
        {
          provider: 'test',
          model: 'test-model',
          aliases: ['alias'],
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 4,
          cacheReadUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 3,
          source: 'fixture',
        },
      ],
    },
    'test',
    'alias'
  )!
  const usage = normalizeRunUsage(
    { inputTokens: { total: 1_000, cacheRead: 200, cacheWrite: 100 }, outputTokens: 500 },
    rates
  )
  expect(usage.cost).toBeCloseTo(0.0038)
  expect(usage.costCoverage).toBe('complete')
  expect(usage.cacheWriteTokens).toBe(100)
  expect(summarizeUsage([usage, usage])).toMatchObject({
    costCoverage: 'complete',
    unknownCostRuns: 0,
    cacheWriteTokens: 200,
  })
})

test('unknown costs and invalid cache totals cannot become a complete invoice', () => {
  const known = normalizeRunUsage(
    { inputTokens: { total: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: 10 },
    { inputPerMillion: 2, outputPerMillion: 4 }
  )
  const partial = normalizeRunUsage(
    { inputTokens: { total: 100, cacheRead: 20, cacheWrite: 0 }, outputTokens: 10 },
    { inputPerMillion: 2, outputPerMillion: 4 }
  )
  expect(partial.cost).toBeNull()
  expect(partial.knownCost).toBeCloseTo(0.0002)
  expect(partial.costCoverage).toBe('partial')
  expect(summarizeUsage([known, partial])).toMatchObject({
    cost: null,
    costCoverage: 'partial',
    unknownCostRuns: 1,
  })
  expect(normalizeRunUsage({}, { inputPerMillion: 2, outputPerMillion: 4 }).cost).toBeNull()
  expect(
    normalizeRunUsage(
      { inputTokens: { total: 10, cacheRead: 20 }, outputTokens: 2 },
      { inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.5 }
    ).cost
  ).toBeNull()
  expect(normalizePersistedUsage({ ...known, costCoverage: undefined })).toMatchObject({
    cost: null,
    costCoverage: 'partial',
    knownCost: known.cost,
  })
})

test('unreported SDK cache buckets stay unknown instead of becoming a complete cost', () => {
  const usage = normalizeRunUsage(
    {
      inputTokens: 100,
      outputTokens: 10,
      inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined },
    },
    { inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.5, cacheWritePerMillion: 3 }
  )
  expect(usage.cost).toBeNull()
  expect(usage.costCoverage).toBe('partial')
  expect(usage.tokenCoverage).toEqual({
    input: true,
    output: true,
    cacheRead: false,
    cacheWrite: false,
  })
})

test('known cache buckets contribute to partial cost independently of missing buckets', () => {
  const usage = normalizeRunUsage(
    { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 20 } },
    { inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.5, cacheWritePerMillion: 3 }
  )
  expect(usage.cost).toBeNull()
  expect(usage.knownCost).toBeCloseTo(0.00005)
  expect(usage.tokenCoverage?.cacheRead).toBe(true)
  expect(usage.tokenCoverage?.cacheWrite).toBe(false)
})
