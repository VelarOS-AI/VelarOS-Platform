import { describe, expect, test } from 'bun:test'

import { normalizeModelRequestError } from '../src/agent/model/ModelRequestError'

describe('model request error normalization', () => {
  test('surfaces quota exhaustion without leaking provider response or request data', () => {
    const error = Object.assign(new Error('Forbidden'), {
      statusCode: 403,
      responseBody: JSON.stringify({
        error: 'Credits exhausted',
        code: 'QUOTA_EXCEEDED',
        quota: { totalRemaining: 0 },
        credential: 'must-not-leak',
      }),
      requestBodyValues: { apiKey: 'must-not-leak' },
    })

    const normalized = normalizeModelRequestError(error)

    expect(normalized.code).toBe('QUOTA_EXCEEDED')
    expect(normalized.message).toBe('模型服务额度已用尽，请补充额度或切换服务商后重试。')
    expect(normalized.context).toEqual({
      providerCode: 'QUOTA_EXCEEDED',
      statusCode: 403,
    })
    expect(JSON.stringify(normalized.toJSON())).not.toContain('must-not-leak')
  })

  test('reads nested provider failures and preserves unknown errors unchanged', () => {
    const nested = normalizeModelRequestError(
      new Error('outer', {
        cause: Object.assign(new Error('Bad request'), {
          statusCode: 400,
          responseBody: JSON.stringify({
            error: { message: 'Invalid model', code: 'MODEL_INVALID' },
          }),
        }),
      })
    )
    expect(nested.code).toBe('MODEL_INVALID')
    expect(nested.message).toBe('Invalid model')
    expect(nested.context).toEqual({ providerCode: 'MODEL_INVALID', statusCode: 400 })

    const ordinary = new Error('socket closed')
    expect(normalizeModelRequestError(ordinary).message).toBe('socket closed')
  })
})
