/**
 * @test-meta
 * title: 内存 provider script 的存活
 * summary: 模型运行时 · registerSource 注册的来源在重配宿主与重载后不消失。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import type { ChatProviderId } from '../src/exports/index'
import { ProviderScriptRegistry } from '../src/impl/providers/ProviderScriptRegistry'

const MemoryProviderId = 'memory-source-probe' as ChatProviderId
const MemoryScriptPath = '/tmp/velaros-model-memory-source.cjs'

function createMemorySource(label: string): string {
  return `module.exports = {
  manifest: {
    id: '${MemoryProviderId}',
    label: '${label}',
    description: '内存注册的探针 provider',
    defaultModel: 'probe-model',
    models: [{ id: 'probe-model', label: 'Probe Model' }]
  },
  createLanguageModelFactory() {
    return function createLanguageModel() {
      return {}
    }
  }
}`
}

function createRegistry(): ProviderScriptRegistry {
  return new ProviderScriptRegistry({ configPaths: [] })
}

describe('内存 provider script', () => {
  test('重配宿主、重配来源与重载之后仍然在', () => {
    const registry = createRegistry()
    const providerId = registry.registerSource({
      source: createMemorySource('Probe'),
      scriptPath: MemoryScriptPath,
    })

    expect(providerId).toBe(MemoryProviderId)
    expect(registry.supportsProvider(providerId)).toBe(true)

    registry.configureHost({ getAppVersion: () => '9.9.9' })
    expect(registry.supportsProvider(providerId)).toBe(true)

    registry.configureSources({ configPaths: [] })
    expect(registry.supportsProvider(providerId)).toBe(true)

    registry.reload()
    expect(registry.supportsProvider(providerId)).toBe(true)
    expect(registry.listProviderManifests().map((manifest) => manifest.id)).toEqual([
      MemoryProviderId,
    ])
  })

  test('重放时用的是重配后的宿主桥', () => {
    const registry = createRegistry()
    registry.registerSource({
      source: createMemorySource('Probe'),
      scriptPath: MemoryScriptPath,
    })
    registry.configureHost({ getAppVersion: () => '9.9.9' })

    expect(registry.requireProviderScript(MemoryProviderId).helpers.host.getAppVersion()).toBe(
      '9.9.9'
    )
  })

  test('同一个 id 重新注册覆盖旧来源', () => {
    const registry = createRegistry()
    registry.registerSource({
      source: createMemorySource('旧'),
      scriptPath: MemoryScriptPath,
    })
    registry.registerSource({
      source: createMemorySource('新'),
      scriptPath: MemoryScriptPath,
    })
    registry.reload()

    expect(registry.requireProviderScript(MemoryProviderId).label).toBe('新')
  })

  test('注销之后不会被重载放回来', () => {
    const registry = createRegistry()
    const providerId = registry.registerSource({
      source: createMemorySource('Probe'),
      scriptPath: MemoryScriptPath,
    })

    expect(registry.unregisterProvider(providerId)).toBe(true)
    expect(registry.supportsProvider(providerId)).toBe(false)

    registry.reload()
    expect(registry.supportsProvider(providerId)).toBe(false)
    expect(registry.unregisterProvider(providerId)).toBe(false)
  })
})
