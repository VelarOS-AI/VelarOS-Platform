/**
 * @test-meta
 * title: 内存 provider script 的存活
 * summary: 模型运行时 · registerSource 注册的来源在重配宿主与重载后不消失。
 * area: package
 */
import { describe, expect, test } from 'bun:test'

import { ProviderScriptRegistry } from '../src/impl/providers/ProviderScriptRegistry'
import type { ChatProviderId } from '../src/index'

const MemoryProviderId = 'memory-source-probe' as ChatProviderId
const MemoryScriptPath = '/tmp/velaros-model-memory-source.cjs'

function createMemorySource(label: string): string {
  return `module.exports = {
  manifest: {
    id: '${MemoryProviderId}',
    label: '${label}',
    description: '内存注册的探针 provider',
    defaultModel: 'probe-model',
    models: [{ id: 'probe-model', label: 'Probe Model', inputModalities: ['text'] }]
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
  test('公开描述符是同代稳定的纯数据快照，清单读取不能改写执行状态', () => {
    const registry = createRegistry()
    registry.registerSource({
      source: createMemorySource('Probe'),
      scriptPath: MemoryScriptPath,
    })
    const descriptor = registry.getProviderScript(MemoryProviderId)
    if (!descriptor) throw new Error('fixture provider was not registered')

    expect(Object.keys(descriptor)).toEqual(['manifest'])
    expect(structuredClone(descriptor)).toEqual(descriptor)
    expect(registry.getProviderScript(MemoryProviderId)).toBe(descriptor)
    expect(Reflect.set(descriptor.manifest, 'label', 'changed')).toBe(false)
    expect(Reflect.set(descriptor.manifest.models, '0', { id: 'changed' })).toBe(false)
    expect(Reflect.set(descriptor.manifest.models[0], 'id', 'changed')).toBe(false)
    expect(Reflect.set(descriptor.manifest.models[0].inputModalities!, '0', 'image')).toBe(false)

    const manifests = registry.listProviderManifests()
    manifests[0].label = 'changed'
    manifests[0].models[0].inputModalities = ['image']
    const loaded = registry.requireProviderScript(MemoryProviderId)
    expect(loaded.manifest.label).toBe('Probe')
    expect(loaded.manifest.models[0].inputModalities).toEqual(['text'])
    expect(registry.getProviderScript(MemoryProviderId)).toBe(descriptor)

    registry.registerSource({
      source: createMemorySource('Probe'),
      scriptPath: MemoryScriptPath,
    })
    expect(registry.getProviderScript(MemoryProviderId)).toEqual(descriptor)
    expect(registry.getProviderScript(MemoryProviderId)).not.toBe(descriptor)
  })

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
