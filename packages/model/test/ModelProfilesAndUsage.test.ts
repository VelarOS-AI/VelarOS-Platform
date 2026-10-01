import { describe, expect, test } from 'bun:test'

import { modelProfiles, modelProviderRetry, modelUsage } from '../src/index'

describe('Model profiles and usage common layer', () => {
  test('resolves credentials without exposing them in public profiles', () => {
    const profile = { id: 'p1', apiKey: 'secret', model: 'm1' }
    expect(modelProfiles.omitCredential(profile)).toEqual({ id: 'p1', model: 'm1' })
    expect(
      modelProfiles.credential({
        configuredCredential: '',
        environmentName: 'TEST_KEY',
        environment: { TEST_KEY: 'env-secret' },
      })
    ).toBe('env-secret')
    expect(
      modelProfiles.credentialSource({
        configuredCredential: '',
        environmentName: null,
        environment: {},
        credentialOptional: false,
      })
    ).toBe('missing')
  })

  test('normalizes provider usage and calculates configured price', () => {
    const usage = modelUsage.normalizeRunUsage(
      {
        inputTokens: { total: 1_000, cacheRead: 200, cacheWrite: 0 },
        outputTokens: { total: 500, reasoning: 100 },
      },
      { inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.5 }
    )
    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      reasoningTokens: 100,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      totalTokens: 1_500,
      cost: 0.0037,
      knownCost: 0.0037,
      costCoverage: 'complete',
      tokenCoverage: { input: true, output: true, cacheRead: true, cacheWrite: true },
    })
    expect(
      modelUsage.summarize([usage, { ...usage, cost: null, knownCost: 0, costCoverage: 'unknown' }])
    ).toMatchObject({
      runs: 2,
      totalTokens: 3_000,
      cost: null,
      knownCost: 0.0037,
      unknownCostRuns: 1,
      lastContextTokens: 1_000,
    })
  })

  test('forwards caller cancellation to a bounded probe signal', async () => {
    const controller = new AbortController()
    const probe = modelProfiles.runConnectionProbe(async (signal) => {
      controller.abort(new Error('cancelled'))
      await Promise.resolve()
      return signal.aborted
    }, controller.signal)
    expect(await probe).toBe(true)
  })

  test('owns provider-neutral transient retry classification and bounds', () => {
    expect(
      modelProviderRetry.plan(
        { status: 429, headers: { 'retry-after': '3' } },
        {
          retryIndex: 1,
          initialDelayMs: 100,
          maxDelayMs: 5_000,
        }
      )
    ).toMatchObject({ kind: 'rate-limit', delayMs: 3_000 })
    expect(
      modelProviderRetry.plan(
        { status: 401, message: 'Unauthorized' },
        {
          retryIndex: 1,
        }
      )
    ).toBeNull()
    expect(
      modelProviderRetry.plan(
        { code: 'ECONNRESET' },
        {
          retryIndex: 9,
          initialDelayMs: 100,
          maxDelayMs: 500,
        }
      )
    ).toMatchObject({ kind: 'network', delayMs: 500 })
  })
})

test('provider retry reads native Error causes and respects permanent authorization failure', () => {
  const error = new Error('Cannot connect to API', {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  })
  expect(modelProviderRetry.plan(error, { retryIndex: 1 })?.kind).toBe('network')
  expect(
    modelProviderRetry.plan(
      Object.assign(new Error('request rejected'), { statusCode: 401, cause: error }),
      { retryIndex: 1 }
    )
  ).toBeNull()
})
