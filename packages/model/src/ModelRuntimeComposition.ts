import { AgentModelResolver } from './AgentModelResolver'
import { AgentModelRuntime } from './AgentModelRuntime'
import {
  createModelAdapterRegistry,
  type ModelAdapterRegistry,
} from './ModelAdapterRegistry'
import { ModelProviderCollection } from './ModelProviderCollection'
import { NodeLocalModelEnvironment } from './NodeLocalModelEnvironment'
import { ProviderModelCatalogService, type ProviderModelCatalogServiceOptions } from './ProviderModelCatalogService'
import {
  ProviderScriptRegistry,
  type ProviderScriptRegistryOptions,
} from './ProviderScriptRegistry'
import { VelarCloudModelRuntime } from './VelarCloudModelRuntime'

export interface CreateModelRuntimeCompositionOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly providerScripts?: ProviderScriptRegistryOptions
  readonly velarCloudRuntime?: VelarCloudModelRuntime
  readonly providerCatalog?: Omit<ProviderModelCatalogServiceOptions, 'providerCollection' | 'providerScriptRegistry'>
}

/**
 * 已发布的模型运行时对象图契约。
 *
 * 接口保持结构化类型兼容；需要使用默认装配或生命周期实现时，使用
 * {@link DefaultModelRuntimeComposition}。
 */
export interface ModelRuntimeComposition {
  readonly providerScriptRegistry: ProviderScriptRegistry
  readonly localModelEnvironment: NodeLocalModelEnvironment
  readonly providerCollection: ModelProviderCollection
  readonly velarCloudRuntime: VelarCloudModelRuntime
  readonly modelAdapterRegistry: ModelAdapterRegistry
  readonly agentModelResolver: AgentModelResolver
  readonly agentModelRuntime: AgentModelRuntime
  readonly providerModelCatalogService?: ProviderModelCatalogService
}

/**
 * 一个宿主独占的默认模型运行时对象图。
 *
 * provider scripts、provider collection、adapter registry 与解析器的可变状态
 * 全部归本实例所有，不通过模块级单例跨应用或租户泄漏。
 */
export class DefaultModelRuntimeComposition implements ModelRuntimeComposition {
  public readonly providerScriptRegistry: ProviderScriptRegistry
  public readonly localModelEnvironment: NodeLocalModelEnvironment
  public readonly providerCollection: ModelProviderCollection
  public readonly velarCloudRuntime: VelarCloudModelRuntime
  public readonly modelAdapterRegistry: ModelAdapterRegistry
  public readonly agentModelResolver: AgentModelResolver
  public readonly agentModelRuntime: AgentModelRuntime
  public readonly providerModelCatalogService: ProviderModelCatalogService

  constructor(options: CreateModelRuntimeCompositionOptions = {}) {
    this.localModelEnvironment = new NodeLocalModelEnvironment(options.environment)
    this.providerScriptRegistry = new ProviderScriptRegistry(options.providerScripts)
    this.providerCollection = new ModelProviderCollection(
      this.providerScriptRegistry,
      { environment: this.localModelEnvironment.variables }
    )
    this.velarCloudRuntime =
      options.velarCloudRuntime ?? new VelarCloudModelRuntime()
    this.modelAdapterRegistry = createModelAdapterRegistry(
      this.providerScriptRegistry,
      this.providerCollection,
      this.velarCloudRuntime,
      this.localModelEnvironment
    )
    this.providerModelCatalogService = new ProviderModelCatalogService({
      ...options.providerCatalog,
      providerCollection: this.providerCollection,
      providerScriptRegistry: this.providerScriptRegistry,
    })
    this.agentModelResolver = new AgentModelResolver(
      this.modelAdapterRegistry,
      this.providerScriptRegistry,
      this.providerCollection,
      this.localModelEnvironment,
      this.providerModelCatalogService
    )
    this.agentModelRuntime = new AgentModelRuntime(
      this.modelAdapterRegistry,
      this.agentModelResolver
    )
  }
}

/**
 * 兼容的构造器入口：类型位置表示公开契约，值位置创建默认实现。
 *
 * 需要声明具体实例类型时使用 {@link DefaultModelRuntimeComposition}。
 */

export const ModelRuntimeComposition = DefaultModelRuntimeComposition

/**
 * 保留原有函数式装配入口与浅冻结语义。
 *
 * 冻结 composition 只保护对象图引用不被替换；每个子运行时仍按自身 API 管理状态。
 */
export function createModelRuntimeComposition(
  options: CreateModelRuntimeCompositionOptions = {}
): DefaultModelRuntimeComposition {
  return Object.freeze(new DefaultModelRuntimeComposition(options))
}
