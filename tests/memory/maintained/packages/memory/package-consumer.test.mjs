/**
 * @test-meta
 * title: Memory product package consumer API
 * summary: 通过发布入口验证记忆包两个入口的 class/factory API。
 * area: package
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMemoryRuntime,
  MemoryRuntime,
} from '../../../../../packages/memory/dist/index.js'
import {
  MemoryAdapterRuntime,
  mountMemoryAdapter,
} from '../../../../../packages/memory/dist/adapter-kernel/index.js'

test('package root exposes a class-first runtime while retaining the factory', () => {
  const databaseProvider = () => {
    throw new Error('consumer fixture does not open storage')
  }
  const memory = createMemoryRuntime({ databaseProvider })

  assert.ok(memory instanceof MemoryRuntime)
  assert.equal(memory.domain, memory.memoryDomainService)
  assert.equal(typeof memory.memoryDomainService.recall, 'function')
})

test('kernel adapter factory returns an explicit lifecycle object', () => {
  const domain = {
    recall: () => [],
    recoverOrphanDreamRuns: () => undefined,
    warmup: () => ({ state: 'idle' }),
  }
  const always = () => true
  const adapter = mountMemoryAdapter({
    tree: {
      domain,
      idleSignal: {
        getIdleSeconds: () => 0,
        isOnBatteryPower: () => false,
        isAppFocused: () => true,
      },
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
