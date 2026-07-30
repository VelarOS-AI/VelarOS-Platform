import { isNonBlankString, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  createCapabilityToken,
  createKernelCallableCapability,
  defineKernelModule,
  type KernelCallableCapabilityService,
  type KernelModuleDefinition,
} from '@velaros-ai/core/kernel/abi'

import type { ModelAdapterRegistryPort } from './ModelAdapterRegistryPort'
import type { ChatProviderId } from './ModelContracts'

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

/** wire 面入参上限：provider id 是标识符不是载荷，越界一律拒。 */
const MaxWireProviderIdChars = 128

function invalidCapabilityInput(detail: string): AppError {
  return new AppError('VALIDATION', `Model capability input is invalid: ${detail}`)
}

/**
 * 判据（§5.3b ④安全门）——wire 面唯一的入参解析点，**只认恰好一个 `provider` 键**。
 *
 * 多余的键一律拒而不是忽略：这条通道对外可调用，宽进等于允许"多传一个字段就能改行为"，
 * 且日后给 `supports_provider` 加轴时，旧客户端的错拼字段会静默被当默认值。长度上限挡的是
 * 拿 id 当载荷灌进来。四条判据各自给独立诊断（§2.7）——原先四条共用一句话，等于没有诊断。
 */
function parseProviderInput(input: unknown): ChatProviderId {
  if (!isPlainObject(input)) throw invalidCapabilityInput('expected an object payload')

  const keys = Object.keys(input)
  if (keys.length !== 1) {
    throw invalidCapabilityInput(
      `expected exactly one "provider" key, received [${keys.join(', ')}]`
    )
  }
  if (!isNonBlankString(input.provider)) {
    throw invalidCapabilityInput('"provider" must be a non-blank string')
  }
  if (input.provider.length > MaxWireProviderIdChars) {
    throw invalidCapabilityInput(`"provider" exceeds ${MaxWireProviderIdChars} characters`)
  }

  return input.provider as ChatProviderId
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
    throw new AppError('VALIDATION', 'Model kernel module requires an injected registry')
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
