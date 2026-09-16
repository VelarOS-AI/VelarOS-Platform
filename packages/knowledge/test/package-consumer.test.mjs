/**
 * @test-meta
 * title: Knowledge package consumer API
 * summary: 通过发布入口验证运行时的 class/factory API 与实例级故障状态。
 * area: package
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createKnowledgeRuntime,
  KnowledgeRuntime,
  VectorFailureMonitor,
} from '../dist/index.js'

test('package root exposes a class-first runtime while retaining the factory', () => {
  const databaseProvider = () => {
    throw new Error('consumer fixture does not open storage')
  }

  const knowledge = createKnowledgeRuntime({
    databaseProvider,
    storagePathProvider: {
      getLanceDatabasePath: () => '/tmp/knowledge-consumer-fixture',
    },
    embeddingConfig: {
      resolveEmbeddingRuntime: () => ({
        provider: 'fixture',
        model: 'fixture-embedding',
        apiKey: '',
        baseURL: 'https://example.invalid',
        configured: false,
      }),
    },
    embeddingRequestFactory: {
      createEmbeddingRequest: () => ({
        url: 'https://example.invalid/embeddings',
        headers: {},
      }),
    },
    httpClient: {
      postJson: async () => {
        throw new Error('consumer fixture does not perform network IO')
      },
    },
  })

  assert.ok(knowledge instanceof KnowledgeRuntime)
  assert.equal(knowledge.domain, knowledge.knowledgeDomainService)
  assert.equal(knowledge.vectorStore, knowledge.knowledgeVectors)
  assert.equal(typeof knowledge.warmup, 'function')
  assert.equal(typeof knowledge.close, 'function')
})

test('vector failure suppression is isolated per runtime-owned monitor', () => {
  let now = 1_000
  const firstWarnings = []
  const secondWarnings = []
  const first = new VectorFailureMonitor({ now: () => now, windowMs: 100 })
  const second = new VectorFailureMonitor({ now: () => now, windowMs: 100 })

  first.warnOnce({ warn: (...args) => firstWarnings.push(args) }, 'query', 'failed', new Error('401'))
  first.warnOnce({ warn: (...args) => firstWarnings.push(args) }, 'query', 'failed', new Error('401'))
  second.warnOnce({ warn: (...args) => secondWarnings.push(args) }, 'query', 'failed', new Error('401'))

  assert.equal(firstWarnings.length, 1)
  assert.equal(secondWarnings.length, 1)

  now += 101
  first.warnOnce({ warn: (...args) => firstWarnings.push(args) }, 'query', 'failed', new Error('401'))
  assert.equal(firstWarnings.length, 2)
  assert.equal(firstWarnings[1][1].suppressedSinceLastWarning, 1)
})
