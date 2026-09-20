/**
 * model 域根入口（`@velaros-ai/model`），给 Node 宿主。
 *
 * 一个宿主只需要这一个入口：运行时对象图、请求客户端、内核挂载、四个无状态实例，
 * 加上注入面与它们用到的数据。另外两个入口是它的子集——`./contracts` 只有可移植数据，
 * `./catalog` 多一份 browser-safe 的 `modelCatalog`。
 */

// ── 可移植数据与常量表（`./contracts` 的全部内容） ───────────────
export * from './contracts.js'

// ── 产品面 ──────────────────────────────────────────────────────
export type {
  AgentModelResolverApi,
  AgentModelRuntimeApi,
  AiSdkModelRequestTransportOptions,
  LocalModelEnvironmentApi,
  ModelAdapterRegistryApi,
  ModelCatalogApi,
  ModelProfilesApi,
  ModelProviderCollectionApi,
  ModelProviderCollectionOptions,
  ModelProviderRetryApi,
  ModelRequestClientApi,
  ModelRequestClientOptions,
  ModelRuntimeCapabilityService,
  ModelRuntimeCompositionApi,
  ModelUsageApi,
  NodeLocalModelEnvironmentApi,
  ProviderModelCatalogApi,
  ProviderModelCatalogCacheApi,
  ProviderModelCatalogServiceOptions,
  ProviderScriptRegistryApi,
  VelarCloudModelRuntimeApi,
} from './contract/provides'

// ── 注入面 ──────────────────────────────────────────────────────
export type {
  CreateModelKernelModuleOptions,
  CreateModelRuntimeCompositionOptions,
  ModelEnvironmentPort,
  ModelProviderAdapter,
  ModelRequestTransport,
  ProviderModelCatalogAttribution,
  ProviderScriptHostBridge,
  ProviderScriptRegistryOptions,
  VelarCloudModelRuntimeBinding,
} from './contract/requires'

// ── 值：装配、请求客户端、内核模块，与四个无状态实例 ────────────
export { createModelRuntimeComposition } from './impl/composition/DefaultModelRuntimeComposition'
export { createModelKernelModule, ModelCapability } from './impl/composition/ModelKernelCapability'
export { modelCatalog } from './impl/providers/ModelCatalog'
export { modelProfiles } from './impl/requests/ModelProfiles'
export { modelProviderRetry } from './impl/requests/ModelProviderRetry'
export { createModelRequestClient } from './impl/requests/ModelRequestClient'
export { modelUsage } from './impl/requests/ModelUsage'

// ── 公开签名用到的数据 ──────────────────────────────────────────
export type { ModelDriver } from './contract/requires.js'
export type { AiSdkDriverOptions } from './contract/requires.js'
export { createAiSdkModelDriver } from './impl/requests/AiSdkModelDriver.js'
export type {
  AgentProvider,
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
  ModelResolutionTraceEntry,
  ResolvedAgentModelRuntime,
} from './types/adapters'
export type { ModelDriverLimits, ModelImage, ModelInputEstimate, ModelMaterial, ModelResponseFormat, ModelTurnDelta,ModelTurnRequest } from './types/driver.js'
export type {
  ModelProviderAvailabilityOptions,
  ModelProviderConfiguredInput,
} from './types/providers'
export type {
  ModelRequestDecodedObjectInput,
  ModelRequestEndpoint,
  ModelRequestEnvelope,
  ModelRequestGenerateText,
  ModelRequestGenerateTextInput,
  ModelRequestGenerateTextResult,
  ModelRequestLanguageModel,
  ModelRequestMessages,
  ModelRequestObjectBaseInput,
  ModelRequestObjectInput,
  ModelRequestObjectOutput,
  ModelRequestObjectOutputInput,
  ModelRequestOpenStreamInput,
  ModelRequestOutput,
  ModelRequestOutputDecoder,
  ModelRequestStreamText,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextInputToString,
  ModelRequestStreamTextResult,
  ModelRequestTextInput,
  ModelRequestTextOutput,
} from './types/requests'
export type { ProviderScriptRegistryPort } from './types/scripts'
export type { ModelRequestEncoderApi } from '@velaros-ai/kernel'
export { modelRequestEncoder } from '@velaros-ai/kernel'
