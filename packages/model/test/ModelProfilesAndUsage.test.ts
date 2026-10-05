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

test('provider retry classifies structured and code-only transient failures without guessing unknown codes', () => {
  for (const [code, kind] of [
    ['stream_read_error', 'network'],
    ['ECONNRESET', 'network'],
    ['server_error', 'provider'],
    ['internal_server_error', 'provider'],
    ['service_unavailable', 'provider'],
    ['overloaded_error', 'provider'],
    ['rate_limit_exceeded', 'rate-limit'],
  ] as const) {
    for (const failure of [
      code,
      { message: code },
      { response: { error: { code, message: 'opaque provider failure' } } },
      new Error('request failed', { cause: { data: { error: { code } } } }),
    ])
      expect(modelProviderRetry.plan(failure, { retryIndex: 1 })?.kind).toBe(kind)
  }
  for (const failure of [
    'unknown_provider_code',
    { code: 'unknown_provider_code' },
    { message: 'An example mentions stream_read_error, without identifying this failure.' },
    { request: { error: { code: 'stream_read_error' } } },
  ])
    expect(modelProviderRetry.plan(failure, { retryIndex: 1 })).toBeNull()
})

test('permanent provider codes take precedence over transient hints and generic error messages', () => {
  for (const code of [
    'invalid_api_key',
    'authentication_error',
    'invalid_request_error',
    'validation_failed',
    'context_length_exceeded',
    'model_not_found',
    'permission_denied',
    'insufficient_quota',
  ]) {
    for (const detail of [{ code, message: 'opaque failure' }, { message: code }])
      expect(
        modelProviderRetry.plan(
          {
            status: 503,
            retryable: true,
            message: 'stream_read_error',
            response: { error: detail },
          },
          { retryIndex: 1 }
        )
      ).toBeNull()
  }
  expect(
    modelProviderRetry.plan(
      { code: 'ABORT_ERR', cause: { code: 'server_error' } },
      { retryIndex: 1 }
    )
  ).toBeNull()
  expect(
    modelProviderRetry.plan(new DOMException('stream_read_error', 'AbortError'), { retryIndex: 1 })
  ).toBeNull()
  expect(
    modelProviderRetry.plan(
      { status: 403, error: { code: 'stream_read_error' } },
      { retryIndex: 1 }
    )
  ).toBeNull()
})
