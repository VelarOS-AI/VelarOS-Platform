import { describe, expect, test } from 'bun:test'

import type {
  KernelModuleActivateContext,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'

import {
  createModelKernelModule,
  ModelCapability,
  type ModelRegistryPort,
  type ModelRuntimeCapabilityService,
} from '../src/index'

function createCaptureContext(
  capture: (tokenId: string, service: object) => void,
): KernelModuleActivateContext {
  return {
    registerService<TService extends object>(
      token: CapabilityToken<TService>,
      service: TService,
    ) {
      capture(token.id, service)
      return { dispose() {} }
    },
  } as unknown as KernelModuleActivateContext
}

describe('model kernel module', () => {
  test('requires a product-owned registry and never creates a global fallback', () => {
    expect(() =>
      createModelKernelModule(undefined as never)
    ).toThrow('模型内核模块必须显式注入适配器注册表。')
    expect(() =>
      createModelKernelModule({} as never)
    ).toThrow('模型内核模块必须显式注入适配器注册表。')
  })

  test('registers an injected provider registry behind a stable token', async () => {
    let service: ModelRuntimeCapabilityService | undefined
    const registry = {
      supportsProvider: (provider: string) => provider === 'openai',
      createLanguageModelFactory: () => {
        throw new Error('not called')
      },
      createEmbeddingRequest: () => {
        throw new Error('not called')
      },
    } as ModelRegistryPort
    const module = createModelKernelModule({ registry })

    await module.activate(
      createCaptureContext((tokenId, registered) => {
        expect(tokenId).toBe(ModelCapability.id)
        service = registered as ModelRuntimeCapabilityService
      }),
    )

    expect(service?.getOperationMetadata('supports_provider')).toEqual({
      permissions: [],
      reason: '查询某个模型 provider 有没有已注册的适配器。',
    })
    expect(await service?.invoke(
      'supports_provider',
      undefined,
      { provider: 'openai' },
      new AbortController().signal,
    )).toBe(true)
    expect(() =>
      service?.invoke(
        'supports_provider',
        undefined,
        { provider: 'openai', apiKey: 'must-not-enter-call-surface' },
        new AbortController().signal,
      )).toThrow('模型能力的入参不合法')
    expect(module.manifest.permissions).toEqual([])
  })
})
