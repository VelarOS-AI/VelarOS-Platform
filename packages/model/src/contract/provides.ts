/**
 * 产品面：本包交给外面的整件能力。类实现的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），
 * 这里登记并转发；没有类的公开接口（内核能力服务）直接声明在这里。
 *
 * 这里的每个接口都必须从根入口导出；`ModelCatalogApi` 与 `LocalModelEnvironmentApi` 两条
 * 还要能被 `./catalog` 入口加载，它们的声明链不碰 Node 内置模块。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { AgentModelResolverApi } from '../impl/composition/AgentModelResolver'
export type { AgentModelRuntimeApi } from '../impl/composition/AgentModelRuntime'
export type { ModelRuntimeCompositionApi } from '../impl/composition/DefaultModelRuntimeComposition'
export type { ModelAdapterRegistryApi } from '../impl/composition/ModelAdapterRegistry'
export type { ModelRuntimeCapabilityService } from '../impl/composition/ModelKernelCapability'
export type { LocalModelEnvironmentApi } from '../impl/providers/LocalModelEnvironment'
export type { ModelCatalogApi } from '../impl/providers/ModelCatalog'
export type {
  ModelProviderCollectionApi,
  ModelProviderCollectionOptions,
} from '../impl/providers/ModelProviderCollection'
export type { NodeLocalModelEnvironmentApi } from '../impl/providers/NodeLocalModelEnvironment'
export type { ProviderModelCatalogCacheApi } from '../impl/providers/ProviderModelCatalogCache'
export type {
  ProviderModelCatalogApi,
  ProviderModelCatalogServiceOptions,
} from '../impl/providers/ProviderModelCatalogService'
export type { ProviderScriptRegistryApi } from '../impl/providers/ProviderScriptRegistry'
export type { VelarCloudModelRuntimeApi } from '../impl/providers/VelarCloudModelRuntime'
export type { AiSdkModelRequestTransportOptions } from '../impl/requests/AiSdkModelRequestTransport'
export type { ModelProfilesApi } from '../impl/requests/ModelProfiles'
export type { ModelProviderRetryApi } from '../impl/requests/ModelProviderRetry'
export type {
  ModelRequestClientApi,
  ModelRequestClientOptions,
} from '../impl/requests/ModelRequestClient'
export type { ModelUsageApi } from '../impl/requests/ModelUsage'
