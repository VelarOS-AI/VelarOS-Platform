import { describe, expect, test } from 'bun:test'

import {
  normalizeModelRunUsage,
  omitModelProfileCredential,
  planModelProviderRetry,
  resolveModelProfileCredential,
  resolveModelProfileCredentialSource,
  runModelConnectionProbe,
  summarizeModelUsage,
} from '../src'

describe('Model profiles and usage common layer', () => {
  test('resolves credentials without exposing them in public profiles', () => {
    const profile = { id: 'p1', apiKey: 'secret', model: 'm1' }
    expect(omitModelProfileCredential(profile)).toEqual({ id: 'p1', model: 'm1' })
    expect(resolveModelProfileCredential({
      configuredCredential: '',
      environmentName: 'TEST_KEY',
      environment: { TEST_KEY: 'env-secret' },
    })).toBe('env-secret')
    expect(resolveModelProfileCredentialSource({
      configuredCredential: '',
      environmentName: null,
      environment: {},
      credentialOptional: false,
    })).toBe('missing')
  })

  test('normalizes provider usage and calculates configured price', () => {
    const usage = normalizeModelRunUsage({
      inputTokens: { total: 1_000, cacheRead: 200 },
      outputTokens: { total: 500, reasoning: 100 },
    }, { inputPerMillion: 2, outputPerMillion: 4 })
    expect(usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      reasoningTokens: 100,
      cachedInputTokens: 200,
      totalTokens: 1_500,
      cost: 0.004,
    })
    expect(summarizeModelUsage([usage, { ...usage, cost: null }])).toMatchObject({
      runs: 2,
      totalTokens: 3_000,
      cost: 0.004,
      lastContextTokens: 1_000,
    })
  })

  test('forwards caller cancellation to a bounded probe signal', async () => {
    const controller = new AbortController()
    const probe = runModelConnectionProbe(async (signal) => {
      controller.abort(new Error('cancelled'))
      await Promise.resolve()
      return signal.aborted
    }, controller.signal)
    expect(await probe).toBe(true)
  })

  test('owns provider-neutral transient retry classification and bounds', () => {
    expect(planModelProviderRetry({ status: 429, headers: { 'retry-after': '3' } }, {
      retryIndex: 1,
      initialDelayMs: 100,
      maxDelayMs: 5_000,
    })).toMatchObject({ kind: 'rate-limit', delayMs: 3_000 })
    expect(planModelProviderRetry({ status: 401, message: 'Unauthorized' }, {
      retryIndex: 1,
    })).toBeNull()
    expect(planModelProviderRetry({ code: 'ECONNRESET' }, {
      retryIndex: 9,
      initialDelayMs: 100,
      maxDelayMs: 500,
    })).toMatchObject({ kind: 'network', delayMs: 500 })
  })
})
