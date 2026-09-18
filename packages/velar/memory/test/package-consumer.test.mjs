/**
 * @test-meta
 * title: Memory product package consumer API
 * summary: 经构建产物的 `./memory` 入口验证记忆的工厂面（类不出单元，只有工厂与实例）。
 * area: package
 */
import assert from 'node:assert/strict'

import { test } from 'bun:test'

import {
  createMemoryRuntime,
  mountMemoryAdapter,
} from '../../dist/memory/index.js'

test('package root exposes the runtime factory only, and it hands back one domain facade', () => {
  const databaseProvider = () => {
    throw new Error('consumer fixture does not open storage')
  }
  const memory = createMemoryRuntime({ databaseProvider })

  assert.equal(memory.domain, undefined)
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

  assert.equal(typeof adapter.evidenceBridge, 'object')
  assert.equal(typeof adapter.turnRecall, 'object')
  assert.equal(typeof adapter.service.close, 'function')
  adapter.service.close()
})
