import { describe, expect, test } from 'bun:test'

import type {
  CapabilityToken,
  KernelModuleActivateContext,
} from '@velaros-ai/core/kernel/abi'

import {
  createModelKernelModule,
  ModelCapability,
  type ModelRegistryPort,
  type ModelRuntimeCapabilityService,
} from '../src'

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
    ).toThrow('Model kernel module requires an injected registry')
    expect(() =>
      createModelKernelModule({} as never)
    ).toThrow('Model kernel module requires an injected registry')
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
      reason: 'Check whether a model provider adapter is registered.',
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
      )).toThrow('Model capability input is invalid')
    expect(module.manifest.permissions).toEqual([])
  })
})
