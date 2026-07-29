import type { ChatProviderId } from './ModelContracts'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

import type { ModelAdapterRegistryPort } from './ModelAdapterRegistryPort'

export type ModelRegistryPort = ModelAdapterRegistryPort

export interface ModelRuntimeCapabilityService
  extends ModelRegistryPort, KernelCallableCapabilityService {}

export interface CreateModelKernelModuleOptions {
  /** Product-owned provider registry; Kernel never creates or discovers one. */
  registry: ModelRegistryPort
}

/** Typed service identity for model-provider resolution and construction. */
export const ModelCapability =
  createCapabilityToken<ModelRuntimeCapabilityService>('velaros.model')

function parseProviderInput(input: unknown): ChatProviderId {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Model capability input is invalid')
  }
  const record = input as Record<string, unknown>
  if (
    Object.keys(record).length !== 1
    || typeof record.provider !== 'string'
    || record.provider.trim().length === 0
    || record.provider.length > 128
  ) {
    throw new Error('Model capability input is invalid')
  }
  return record.provider as ChatProviderId
}

function createModelCapabilityService(
  registry: ModelRegistryPort,
): ModelRuntimeCapabilityService {
  const callable = createKernelCallableCapability({
    supports_provider: {
      metadata: {
        permissions: [],
        reason: 'Check whether a model provider adapter is registered.',
      },
      invoke: (_scope, input) =>
        registry.supportsProvider(parseProviderInput(input)),
    },
  })

  return Object.freeze({
    ...callable,
    supportsProvider: (
      provider: Parameters<ModelRegistryPort['supportsProvider']>[0],
    ) => registry.supportsProvider(provider),
    createLanguageModelFactory: (
      config: Parameters<
        ModelRegistryPort['createLanguageModelFactory']
      >[0],
    ) =>
      registry.createLanguageModelFactory(config),
    createEmbeddingRequest: (
      config: Parameters<ModelRegistryPort['createEmbeddingRequest']>[0],
      model: Parameters<ModelRegistryPort['createEmbeddingRequest']>[1],
      texts: Parameters<ModelRegistryPort['createEmbeddingRequest']>[2],
    ) =>
      registry.createEmbeddingRequest(config, model, texts),
  })
}

/**
 * Registers the existing model registry without moving provider code into
 * Kernel. The wire-callable surface intentionally exposes only serializable,
 * secret-free provider introspection; model execution stays on injected ports.
 */
export function createModelKernelModule(
  options: CreateModelKernelModuleOptions,
): KernelModuleDefinition {
  if (!options?.registry) {
    throw new Error('Model kernel module requires an injected registry')
  }

  return defineKernelModule({
    manifest: {
      id: 'velaros.model.registry',
      version: '0.3.0',
      apiVersion: 1,
      provides: [ModelCapability],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context) {
      const service = createModelCapabilityService(options.registry)
      context.registerService(ModelCapability, service)
    },
  })
}
