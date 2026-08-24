/**
 * @test-meta
 * title: Cloud 模型错误终止连接重试
 * summary: Cloud 已返回的业务错误应立即显示，只有没有业务错误码的瞬时服务故障才重试。
 * area: packages
 */

import assert from 'node:assert/strict'

import { APICallError } from '@ai-sdk/provider'
import { test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

const retryModulePath = new URL('../dist/agent/retry.js', import.meta.url)

function cloudApiError(statusCode, code, message) {
  return new APICallError({
    message,
    url: 'https://cloud.test/v1/model/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { code, message } }),
    data: { error: { code, message } },
  })
}

test('Cloud application errors stop before reconnecting and preserve the visible message', async () => {
  const { RetryPolicy } = await import(retryModulePath.href)
  const policy = new RetryPolicy()
  const error = cloudApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Velar Free 上游模型服务暂时不可用。')
  let attempts = 0
  let retryEvents = 0

  await assert.rejects(
    policy.runWithConnectionRetry(
      async () => {
        attempts += 1
        throw error
      },
      {
        phase: 'stream',
        turn: 1,
        abortSignal: new AbortController().signal,
        onRetry: () => {
          retryEvents += 1
        },
      }
    ),
    (caught) => caught === error && caught.message === 'Velar Free 上游模型服务暂时不可用。'
  )

  assert.equal(attempts, 1)
  assert.equal(retryEvents, 0)
})

test('Cloud rate-limit errors are terminal while an unclassified 503 stays retryable', async () => {
  const { RetryPolicy } = await import(retryModulePath.href)
  const policy = new RetryPolicy()
  const abortSignal = new AbortController().signal
  const cloudRateLimit = cloudApiError(429, 'RATE_LIMITED', '请求过于频繁。')
  const genericUnavailable = new APICallError({
    message: 'Service unavailable',
    url: 'https://provider.test/chat/completions',
    requestBodyValues: {},
    statusCode: 503,
  })

  assert.equal(policy.shouldRetryConnectionError(cloudRateLimit, 1, { abortSignal }), false)
  assert.equal(policy.shouldRetryConnectionError(genericUnavailable, 1, { abortSignal }), true)
})

test('A stalled model stream retries only before visible output or tool side effects', async () => {
  const { RetryPolicy } = await import(retryModulePath.href)
  const policy = new RetryPolicy()
  const abortSignal = new AbortController().signal
  const stalled = new AppError(
    'MODEL_STREAM_STALLED',
    '模型流已超过 300000ms 没有返回新数据，已中止本轮请求。'
  )

  assert.equal(policy.shouldRetryConnectionError(stalled, 1, { abortSignal }), true)
  assert.equal(policy.shouldRetryConnectionError(stalled, 2, { abortSignal }), false)
  assert.equal(
    policy.shouldRetryConnectionError(stalled, 1, {
      abortSignal,
      hasVisibleOutput: () => true,
    }),
    false
  )
  assert.equal(
    policy.shouldRetryConnectionError(stalled, 1, {
      abortSignal,
      hasToolUse: () => true,
    }),
    false
  )
})
