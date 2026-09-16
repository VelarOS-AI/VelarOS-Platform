export {
  CustomModelProviderIds,
  DefaultProviderModels,
  DirectOpenAICompatibleProviderIds,
  ModelProviderOperationalManifests,
  OllamaEnvNames,
  OllamaProviderId,
  OpenAICompatibleGatewayDefaultBaseURL,
  OpenRouterAutoModelId,
  OpenRouterCompatibleProviderIds,
  OpenRouterFreeModelId,
  VelarAutoModelId,
} from './contract/constants.js'
export type { LocalModelEnvironmentApi } from './contract/provides'
export type { ModelEnvironmentPort } from './contract/requires'
export {
  LocalModelEnvironment,
  resolveOllamaBaseURL,
  resolveOllamaChatModel,
  resolveOllamaContextWindow,
  resolveOllamaVisibleChatModels,
} from './impl/providers/LocalModelEnvironment'
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
} from './impl/providers/ModelCatalog'
export type {
  ChatProviderId,
  ModelProviderAdapterKind,
  ModelProviderOperationalManifest,
  ModelProviderValidationKind,
  ProviderModelResolution,
} from './types/model'
export type { ProviderModelDefinition, SharedProviderCatalog } from './types/providers'
