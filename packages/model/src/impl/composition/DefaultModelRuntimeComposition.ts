import type { CreateModelRuntimeCompositionOptions } from '../../contract/requires'
import { ModelProviderCollection } from '../providers/ModelProviderCollection'
import { NodeLocalModelEnvironment } from '../providers/NodeLocalModelEnvironment'
import { ProviderModelCatalogService } from '../providers/ProviderModelCatalogService'
import { ProviderScriptRegistry } from '../providers/ProviderScriptRegistry'
import { VelarCloudModelRuntime } from '../providers/VelarCloudModelRuntime'

import { AgentModelResolver } from './AgentModelResolver'
import { AgentModelRuntime } from './AgentModelRuntime'
import {
  createModelAdapterRegistry,
  type ModelAdapterRegistryApi,
} from './ModelAdapterRegistry'

/**
 * 已发布的模型运行时对象图契约。
 *
 * 一个宿主一份；provider script、provider 集合、适配器注册表与解析器的可变状态全部归这一份所有，
 * 不经模块级单例跨应用或租户泄漏。需要具体实现类型时用 {@link DefaultModelRuntimeComposition}。
 */
export interface ModelRuntimeComposition {
  /** provider script 注册表：磁盘与内存两条来源都在它手上。 */
  readonly providerScriptRegistry: ProviderScriptRegistry
  /** 这一份装配读到的环境变量快照。 */
  readonly localModelEnvironment: NodeLocalModelEnvironment
  /** provider 集合：清单、目录、凭据与运行时配置都问它。 */
  readonly providerCollection: ModelProviderCollection
  /** Velar Cloud 的连接绑定容器。 */
  readonly velarCloudRuntime: VelarCloudModelRuntime
  /** 模型适配器注册表：按 provider 找适配器。 */
  readonly modelAdapterRegistry: ModelAdapterRegistryApi
  /** 解析器：把一次产品选择解析成可用运行时。 */
  readonly agentModelResolver: AgentModelResolver
  /** Agent 侧入口：收 `unknown`，解析后交给解析器。 */
  readonly agentModelRuntime: AgentModelRuntime
  /** 远端模型目录服务；产品不要再自己 new 一份，缓存与归属都在这一份上。 */
  readonly providerModelCatalogService?: ProviderModelCatalogService
}

/**
 * 一个宿主独占的默认模型运行时对象图。
 *
 * provider script、provider 集合、适配器注册表与解析器的可变状态全部归本实例所有，
 * 不通过模块级单例跨应用或租户泄漏。
 */
export class DefaultModelRuntimeComposition implements ModelRuntimeComposition {
  public readonly providerScriptRegistry: ProviderScriptRegistry
  public readonly localModelEnvironment: NodeLocalModelEnvironment
  public readonly providerCollection: ModelProviderCollection
  public readonly velarCloudRuntime: VelarCloudModelRuntime
  public readonly modelAdapterRegistry: ModelAdapterRegistryApi
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
      (options.velarCloudRuntime as VelarCloudModelRuntime | undefined)
      ?? new VelarCloudModelRuntime()
    this.modelAdapterRegistry = createModelAdapterRegistry(
      this.providerScriptRegistry,
      this.providerCollection,
      this.velarCloudRuntime,
      this.localModelEnvironment,
      options.adapters
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
 * 装配一份模型运行时对象图并浅冻结。
 *
 * 冻结只保护对象图引用不被替换；每个子运行时仍按自身 API 管理状态。
 */
export function createModelRuntimeComposition(
  options: CreateModelRuntimeCompositionOptions = {}
): DefaultModelRuntimeComposition {
  return Object.freeze(new DefaultModelRuntimeComposition(options))
}

/**
 * 兼容的构造器入口：类型位置表示公开契约，值位置创建默认实现。
 *
 * @deprecated 下一轮入口收口后只留 {@link createModelRuntimeComposition}；
 * 需要声明具体实例类型时用 {@link DefaultModelRuntimeComposition}。
 */
export const ModelRuntimeComposition = DefaultModelRuntimeComposition
