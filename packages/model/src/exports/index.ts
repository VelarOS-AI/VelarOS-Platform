export {
  CustomModelProviderIds,
  DefaultProviderModels,
  DirectOpenAICompatibleProviderIds,
  ModelErrorCodes,
  ModelInputModalities,
  ModelProviderAdapterKinds,
  ModelProviderOperationalManifests,
  ModelProviderValidationKinds,
  ModelWireLimits,
  OllamaEnvNames,
  OllamaProviderId,
  OpenAICompatibleGatewayDefaultBaseURL,
  OpenRouterAutoModelId,
  OpenRouterCompatibleProviderIds,
  OpenRouterFreeModelId,
  ReasoningLevels,
  ThinkingDepths,
  VelarAutoModelId,
  VelarCloudManagedProviderIds,
} from '../contract/constants.js'
export type {
  AgentModelResolverApi,
  AgentModelRuntimeApi,
  AiSdkModelRequestTransportOptions,
  LocalModelEnvironmentApi,
  ModelProviderCollectionApi,
  ModelProviderCollectionOptions,
  ModelRequestClientApi,
  ModelRequestClientOptions,
  ModelRuntimeCapabilityService,
  ProviderModelCatalogApi,
  ProviderModelCatalogCacheApi,
  ProviderModelCatalogServiceOptions,
  VelarCloudModelRuntimeApi,
} from '../contract/provides'
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
} from '../contract/requires'
export { AnthropicModelAdapter } from '../impl/adapters/AnthropicModelAdapter'
export { DeepSeekModelAdapter } from '../impl/adapters/DeepSeekModelAdapter'
export { GoogleModelAdapter } from '../impl/adapters/GoogleModelAdapter'
export { ModelAdapter } from '../impl/adapters/ModelAdapter'
export { OpenAICompatibleModelAdapter } from '../impl/adapters/OpenAICompatibleModelAdapter'
export { OpenAIModelAdapter } from '../impl/adapters/OpenAIModelAdapter'
export {
  applyPromptCacheCallOptions,
  applyPromptCacheProviderOptions,
} from '../impl/adapters/PromptCacheLanguageModel'
export {
  applyThinkingDepthProviderOptions,
  createThinkingDepthProviderOptions,
  mergeOpenRouterReasoning,
  requireThinkingDepth,
  resolveThinkingBudget,
  resolveThinkingDepthEffort,
} from '../impl/adapters/ThinkingDepthLanguageModel'
export { VelarModelAdapter } from '../impl/adapters/VelarModelAdapter'
export { AgentModelResolver } from '../impl/composition/AgentModelResolver'
export { AgentModelRuntime } from '../impl/composition/AgentModelRuntime'
export {
  createModelKernelModule,
  ModelCapability,
} from '../impl/composition/ModelKernelCapability'
export {
  LocalModelEnvironment,
  resolveOllamaBaseURL,
  resolveOllamaChatModel,
  resolveOllamaContextWindow,
  resolveOllamaVisibleChatModels,
} from '../impl/providers/LocalModelEnvironment'
export {
  getModelProviderOperationalManifest,
  getResolvedProviderModel,
  getSharedProviderCatalog,
  getSharedProviderModels,
  getSharedProviderSuggestedModels,
  getVisibleProviderModels,
  isOpenRouterCompatibleProvider,
  KnownModelContextWindows,
  OpenAiOnlyModels,
  resolveProviderModelContextWindow,
  resolveProviderModelSelection,
  SharedProviderCatalogs,
} from '../impl/providers/ModelCatalog'
export {
  filterEmbeddingModelCandidates,
  ModelProviderCollection,
  resolveDefaultEmbeddingModelForProvider,
  selectEmbeddingModelCandidate,
} from '../impl/providers/ModelProviderCollection'
export { ProviderModelCatalogService } from '../impl/providers/ProviderModelCatalogService'
export {
  isVelarCloudManagedProviderId,
  VelarCloudModelRuntime,
} from '../impl/providers/VelarCloudModelRuntime'
export { AiSdkModelRequestTransport } from '../impl/requests/AiSdkModelRequestTransport'
export {
  omitModelProfileCredential,
  resolveModelProfileCredential,
  resolveModelProfileCredentialSource,
  runModelConnectionProbe,
} from '../impl/requests/ModelProfiles'
export {
  planModelProviderRetry,
  waitForModelRetry,
} from '../impl/requests/ModelProviderRetry'
export {
  applyModelRequestPolicy,
  ModelRequestClient,
  ModelRequestService,
  type ModelRequestServiceOptions,
} from '../impl/requests/ModelRequestClient'
export {
  normalizeModelRunUsage,
  normalizePersistedModelUsage,
  summarizeModelUsage,
} from '../impl/requests/ModelUsage'
export type {
  AgentProvider,
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
  ModelAdapterRegistryPort,
  ModelRegistryPort,
  ModelResolutionTraceEntry,
  ResolvedAgentModelRuntime,
} from '../types/adapters'
export type * from '../types/model'
export type {
  ModelProviderAvailabilityOptions,
  ModelProviderConfiguredInput,
  ProviderModelDefinition,
  SharedProviderCatalog,
} from '../types/providers'
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
} from '../types/requests'
export type { ProviderScriptRegistryPort } from '../types/scripts'
