/**
 * @test-meta
 * title: Memory product package consumer API
 * summary: 通过发布入口验证三个包的 class/factory API 与实例级故障状态。
 * area: package
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMemoryRuntime,
  MemoryRuntime,
} from '../../../../packages/memory/dist/index.js'
import {
  createKnowledgeRuntime,
  KnowledgeRuntime,
  VectorFailureMonitor,
} from '../../../../packages/knowledge/dist/index.js'
import {
  MemoryAdapterRuntime,
  mountMemoryAdapter,
} from '../../../../packages/memory-adapter-kernel/dist/index.js'

test('package roots expose class-first runtimes while retaining factories', () => {
  const databaseProvider = () => {
    throw new Error('consumer fixture does not open storage')
  }
  const memory = createMemoryRuntime({ databaseProvider })

  assert.ok(memory instanceof MemoryRuntime)
  assert.equal(memory.domain, memory.memoryDomainService)
  assert.equal(typeof memory.memoryDomainService.recall, 'function')

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

test('kernel adapter factory returns an explicit lifecycle object', () => {
  const domain = {
    recall: () => [],
    recoverOrphanDreamRuns: () => undefined,
    warmup: () => ({ state: 'idle' }),
  }
  const always = () => true
  const adapter = mountMemoryAdapter({
    domain,
    idleSignal: {
      getIdleSeconds: () => 0,
      isOnBatteryPower: () => false,
      isAppFocused: () => true,
    },
    config: {
      isEnabled: always,
      isBackgroundGrowthEnabled: always,
      allowBatteryGrowth: always,
      isAutomaticDeepRecallEnabled: always,
      isChatCaptureEnabled: always,
      isWorkspaceCaptureEnabled: always,
      isComputerUseCaptureEnabled: always,
      isExecutionCaptureEnabled: always,
    },
    hostContext: {
      resolveScope: ({ sessionId }) => ({
        scopeType: 'session',
        scopeId: `session:${sessionId}`,
      }),
      turnContextScopes: ['user'],
    },
  })

  assert.ok(adapter instanceof MemoryAdapterRuntime)
  assert.equal(typeof adapter.service.close, 'function')
  adapter.service.close()
})
