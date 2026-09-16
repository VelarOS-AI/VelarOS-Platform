import type { CreateModelRuntimeCompositionOptions } from '../../contract/requires'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'
import { ModelProviderCollection } from '../providers/ModelProviderCollection'
import type { NodeLocalModelEnvironmentApi } from '../providers/NodeLocalModelEnvironment'
import { NodeLocalModelEnvironment } from '../providers/NodeLocalModelEnvironment'
import type { ProviderModelCatalogApi } from '../providers/ProviderModelCatalogService'
import { ProviderModelCatalogService } from '../providers/ProviderModelCatalogService'
import type { ProviderScriptRegistryApi } from '../providers/ProviderScriptRegistry'
import { ProviderScriptRegistry } from '../providers/ProviderScriptRegistry'
import type { VelarCloudModelRuntimeApi } from '../providers/VelarCloudModelRuntime'
import { VelarCloudModelRuntime } from '../providers/VelarCloudModelRuntime'

import type { AgentModelResolverApi } from './AgentModelResolver'
import { AgentModelResolver } from './AgentModelResolver'
import type { AgentModelRuntimeApi } from './AgentModelRuntime'
import { AgentModelRuntime } from './AgentModelRuntime'
import type { ModelAdapterRegistryApi } from './ModelAdapterRegistry'
import { ModelAdapterRegistry } from './ModelAdapterRegistry'

/**
 * 一个宿主独占的模型运行时对象图：本包交给宿主的那件整能力。
 *
 * provider script、provider 集合、适配器注册表与解析器的可变状态全部归这一份所有，
 * 不经模块级单例跨应用或租户泄漏。工厂是 `createModelRuntimeComposition`。
 * 成员一律按接口给，具体实现类不出包——宿主要换实现就从注入面换，不从类继承。
 */
export interface ModelRuntimeCompositionApi {
  /** provider script 注册表：磁盘与内存两条来源都在它手上。 */
  readonly providerScriptRegistry: ProviderScriptRegistryApi
  /** 这一份装配读到的环境变量快照。 */
  readonly localModelEnvironment: NodeLocalModelEnvironmentApi
  /** provider 集合：清单、目录、凭据与运行时配置都问它。 */
  readonly providerCollection: ModelProviderCollectionApi
  /** Velar Cloud 的连接绑定容器。 */
  readonly velarCloudRuntime: VelarCloudModelRuntimeApi
  /** 模型适配器注册表：按 provider 找适配器。 */
  readonly modelAdapterRegistry: ModelAdapterRegistryApi
  /** 解析器：把一次产品选择解析成可用运行时。 */
  readonly agentModelResolver: AgentModelResolverApi
  /** Agent 侧入口：收 `unknown`，解析后交给解析器。 */
  readonly agentModelRuntime: AgentModelRuntimeApi
  /** 远端模型目录服务；产品不要再自己造一份，缓存与归属都在这一份上。 */
  readonly providerModelCatalogService: ProviderModelCatalogApi
}

/**
 * 一个宿主独占的默认模型运行时对象图。
 *
 * provider script、provider 集合、适配器注册表与解析器的可变状态全部归本实例所有，
 * 不通过模块级单例跨应用或租户泄漏。
 */
export class DefaultModelRuntimeComposition implements ModelRuntimeCompositionApi {
  public readonly providerScriptRegistry: ProviderScriptRegistryApi
  public readonly localModelEnvironment: NodeLocalModelEnvironmentApi
  public readonly providerCollection: ModelProviderCollectionApi
  public readonly velarCloudRuntime: VelarCloudModelRuntimeApi
  public readonly modelAdapterRegistry: ModelAdapterRegistryApi
  public readonly agentModelResolver: AgentModelResolverApi
  public readonly agentModelRuntime: AgentModelRuntimeApi
  public readonly providerModelCatalogService: ProviderModelCatalogApi

  constructor(options: CreateModelRuntimeCompositionOptions = {}) {
    // 本地变量拿的是具体实现：适配器要用注册表上不出包的取脚本方法，Cloud 绑定要用不出包的查绑定方法。
    // 字段一律按接口收窄，外面看到的只有接口那一面。
    const environment = new NodeLocalModelEnvironment(options.environment)
    const providerScriptRegistry = new ProviderScriptRegistry(options.providerScripts)
    const velarCloudRuntime = new VelarCloudModelRuntime()
    this.localModelEnvironment = environment
    this.providerScriptRegistry = providerScriptRegistry
    this.providerCollection = new ModelProviderCollection(
      providerScriptRegistry,
      { environment: environment.variables }
    )
    this.velarCloudRuntime = velarCloudRuntime
    this.modelAdapterRegistry = new ModelAdapterRegistry(
      providerScriptRegistry,
      this.providerCollection,
      velarCloudRuntime,
      environment,
      options.adapters
    )
    this.providerModelCatalogService = new ProviderModelCatalogService({
      ...options.providerCatalog,
      providerCollection: this.providerCollection,
      providerScriptRegistry,
    })
    this.agentModelResolver = new AgentModelResolver(
      this.modelAdapterRegistry,
      providerScriptRegistry,
      this.providerCollection,
      environment,
      this.providerModelCatalogService
    )
    this.agentModelRuntime = new AgentModelRuntime(
      this.modelAdapterRegistry,
      this.agentModelResolver
    )
  }
}

/**
 * 装配一份模型运行时对象图并浅冻结。
 *
 * 冻结只保护对象图引用不被替换；每个子运行时仍按自身 API 管理状态。
 */
export function createModelRuntimeComposition(
  options: CreateModelRuntimeCompositionOptions = {}
): ModelRuntimeCompositionApi {
  return Object.freeze(new DefaultModelRuntimeComposition(options))
}
