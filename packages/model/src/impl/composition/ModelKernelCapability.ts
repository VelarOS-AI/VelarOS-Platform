import { AppError } from '@velaros-ai/core/error'
import type {
  KernelCallableCapabilityService,
  KernelModuleDefinition,
} from '@velaros-ai/kernel'
import {
  kernelModules,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
  ScopeRef,
} from '@velaros-ai/kernel/contracts'
import {
  KernelVersionAxes,
} from '@velaros-ai/kernel/contracts'

import {
  ModelCapabilityId,
  ModelKernelModuleId,
  ModelKernelModuleVersion,
} from '../../contract/constants.js'
import type { CreateModelKernelModuleOptions } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import { parseModelCapabilityProviderInput } from '../../utils/kernel-input'

import type { ModelAdapterRegistryApi } from './ModelAdapterRegistry'

/**
 * 挂进内核的模型能力服务。
 *
 * wire 面只开 `supports_provider` 一条可调用操作：它可序列化、不带密钥，越界的入参一律拒。
 * 进程内宿主还能直接调注册表的三个方法——那条路绕过 wire 入参门与权限元数据，
 * 由持有服务的宿主自己负责，不对外开放。
 */
export interface ModelRuntimeCapabilityService
  extends ModelAdapterRegistryApi, KernelCallableCapabilityService {}

/** 模型能力的服务身份；宿主按它取注册表。 */
export const ModelCapability: CapabilityToken<ModelRuntimeCapabilityService> =
  kernelModules.token<ModelRuntimeCapabilityService>(ModelCapabilityId)

/**
 * 把产品自己的适配器注册表包成内核服务。
 *
 * 只是转发：不复制注册表状态，也不替宿主造一个。
 */
class ModelKernelCapability implements ModelRuntimeCapabilityService {
  private readonly callable = kernelModules.callable({
    supports_provider: {
      metadata: {
        permissions: [],
        reason: '查询某个模型 provider 有没有已注册的适配器。',
      },
      invoke: (_scope: LooseOptional<ScopeRef>, input: unknown) =>
        this.registry.supportsProvider(parseModelCapabilityProviderInput(input)),
    },
  })

  constructor(private readonly registry: ModelAdapterRegistryApi) {}

  public getOperationMetadata(
    operation: string
  ): ReturnType<KernelCallableCapabilityService['getOperationMetadata']> {
    return this.callable.getOperationMetadata(operation)
  }

  public invoke(
    operation: string,
    scope: LooseOptional<ScopeRef>,
    input: unknown,
    signal: AbortSignal
  ): unknown | Promise<unknown> {
    return this.callable.invoke(operation, scope, input, signal)
  }

  public supportsProvider(provider: ChatProviderId): boolean {
    return this.registry.supportsProvider(provider)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    return this.registry.createLanguageModelFactory(config)
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    return this.registry.createEmbeddingRequest(config, model, texts)
  }
}

/**
 * 把已有的模型注册表登记成内核模块，不把 provider 代码搬进内核。
 *
 * wire 可调用面刻意只暴露可序列化、不含密钥的 provider 探查；模型执行走注入的端口。
 */
export function createModelKernelModule(
  options: CreateModelKernelModuleOptions,
): KernelModuleDefinition {
  if (!options?.registry) {
    throw new AppError('VALIDATION', '模型内核模块必须显式注入适配器注册表。')
  }

  return kernelModules.define({
    manifest: {
      id: ModelKernelModuleId,
      version: ModelKernelModuleVersion,
      apiVersion: KernelVersionAxes.moduleApi,
      provides: [ModelCapability],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process',
    },
    activate(context) {
      context.registerService(ModelCapability, new ModelKernelCapability(options.registry))
    },
  })
}
