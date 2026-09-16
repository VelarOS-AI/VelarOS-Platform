import {
  createModelRequestClient,
  createModelRuntimeComposition,
  modelCatalog,
  modelProfiles,
  type ModelProviderAdapter,
  type ModelProviderCollectionApi,
  modelProviderRetry,
  type ModelRequestClientApi,
  type ModelRequestClientOptions,
  type ModelRequestTransport,
  type ModelRuntimeCompositionApi,
  modelUsage,
  type ProviderScriptRegistryOptions,
  type VelarCloudManagedProviderId,
  VelarCloudManagedProviderIds,
  type VelarCloudModelRuntimeApi,
} from '@velaros-ai/model'
import { OllamaProviderId, OpenRouterFreeModelId } from '@velaros-ai/model/catalog'
import type {
  AgentProviderRuntimeConfig,
  ModelProviderAdapterKind,
  ModelProviderPreset,
  ModelSelection,
} from '@velaros-ai/model/contracts'

declare const requestOptions: ModelRequestClientOptions
declare const transport: ModelRequestTransport
declare const providerScripts: ProviderScriptRegistryOptions
declare const adapterKind: ModelProviderAdapterKind
declare const preset: ModelProviderPreset
declare const runtimeConfig: AgentProviderRuntimeConfig
declare const selection: ModelSelection
declare const consumerAdapter: ModelProviderAdapter

// 0.7.0 起自定义适配器是注入面的一个接口，不再继承本包的基类。
const composition: ModelRuntimeCompositionApi = createModelRuntimeComposition({
  providerScripts,
  adapters: [consumerAdapter],
})
const providers: ModelProviderCollectionApi = composition.providerCollection
const cloudRuntime: VelarCloudModelRuntimeApi = composition.velarCloudRuntime
const cloudProvider: VelarCloudManagedProviderId = VelarCloudManagedProviderIds[1]
const client: ModelRequestClientApi = createModelRequestClient({
  ...requestOptions,
  transport,
})

void providers.listPresets()
void composition.agentModelRuntime
void cloudRuntime.hasProvider(cloudProvider)
void client
void adapterKind
void preset
void runtimeConfig
void selection
void modelCatalog.resolveOllamaChatModel('qwen3:8b', {
  read: () => undefined,
})
void modelCatalog.manifest(OllamaProviderId)
void modelCatalog.isOpenRouterCompatible('openrouter')
void modelProfiles.omitCredential({ apiKey: 'secret', id: 'p1' })
void modelProviderRetry.plan(new Error('boom'), { retryIndex: 0 })
void modelUsage.summarize([])
void OpenRouterFreeModelId
