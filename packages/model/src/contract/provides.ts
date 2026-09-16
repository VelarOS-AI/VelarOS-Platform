// Node 宿主专属的三个类上方接口（ModelRuntimeComposition、ModelAdapterRegistryApi、
// ProviderScriptRegistryApi）没有登记在这里：它们的声明链带 provider script 的 SDK 工厂类型，
// 登记进来会把 @ai-sdk/* 的声明拖进可移植根入口。它们从 `./node` 入口直接导出，
// 等下一轮入口收口后再统一登记。
export type { AgentModelResolverApi } from '../impl/composition/AgentModelResolver'
export type { AgentModelRuntimeApi } from '../impl/composition/AgentModelRuntime'
export type {
  ModelRuntimeCapabilityService,
} from '../impl/composition/ModelKernelCapability'
export type { LocalModelEnvironmentApi } from '../impl/providers/LocalModelEnvironment'
export type {
  ModelProviderCollectionApi,
  ModelProviderCollectionOptions,
} from '../impl/providers/ModelProviderCollection'
export type { NodeLocalModelEnvironmentApi } from '../impl/providers/NodeLocalModelEnvironment'
export type { ProviderModelCatalogCacheApi } from '../impl/providers/ProviderModelCatalogCache'
export type { ProviderModelCatalogApi, ProviderModelCatalogServiceOptions } from '../impl/providers/ProviderModelCatalogService'
export type { VelarCloudModelRuntimeApi } from '../impl/providers/VelarCloudModelRuntime'
export type { AiSdkModelRequestTransportOptions } from '../impl/requests/AiSdkModelRequestTransport'
export type { ModelRequestClientApi, ModelRequestClientOptions } from '../impl/requests/ModelRequestClient'
