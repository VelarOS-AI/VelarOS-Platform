import {
  type EmbeddingRequest,
  type LanguageModelFactory,
  ModelAdapter,
  type ModelAdapterConfig,
  ModelProviderCollection,
  ModelRequestClient,
  type ModelRequestClientOptions,
  type ModelRequestServiceOptions,
  type ModelRequestTransport,
  VelarCloudModelRuntime,
  VelarModelAdapter,
} from '@velaros-ai/model'
import {
  LocalModelEnvironment,
  OllamaProviderId,
  OpenRouterFreeModelId,
} from '@velaros-ai/model/catalog'
import type {
  AgentProviderRuntimeConfig,
  ModelProviderAdapterKind,
  ModelProviderPreset,
  ModelSelection,
} from '@velaros-ai/model/contracts'
import {
  createModelAdapterRegistry,
  createModelRuntimeComposition,
  DefaultModelRuntimeComposition,
  type ModelRuntimeComposition,
  type ProviderScriptRegistryOptions,
} from '@velaros-ai/model/node'

declare const requestOptions: ModelRequestClientOptions
declare const legacyRequestOptions: ModelRequestServiceOptions
declare const transport: ModelRequestTransport
declare const providerScripts: ProviderScriptRegistryOptions
declare const adapterKind: ModelProviderAdapterKind
declare const preset: ModelProviderPreset
declare const runtimeConfig: AgentProviderRuntimeConfig
declare const selection: ModelSelection

class ConsumerAdapter extends ModelAdapter {
  public createLanguageModelFactory(
    _config: ModelAdapterConfig
  ): LanguageModelFactory {
    return () => 'fixture-model'
  }

  public override createEmbeddingRequest(): EmbeddingRequest {
    return {
      url: 'https://example.invalid/embeddings',
      headers: {},
    }
  }
}

const composition = createModelRuntimeComposition({
  providerScripts,
  velarCloudRuntime: new VelarCloudModelRuntime(),
})
const compositionContract: ModelRuntimeComposition = composition
const providers: ModelProviderCollection = composition.providerCollection
const cloudRuntime: VelarCloudModelRuntime = compositionContract.velarCloudRuntime
const defaultComposition = new DefaultModelRuntimeComposition({
  providerScripts,
})
const client = new ModelRequestClient({
  ...requestOptions,
  transport,
})
const adapter = new ConsumerAdapter(['custom'], providers)
const cloudAdapter = new VelarModelAdapter(
  providers,
  cloudRuntime
)
const registry = createModelAdapterRegistry(
  composition.providerScriptRegistry,
  providers,
  compositionContract.velarCloudRuntime
)
const modelEnvironment = new LocalModelEnvironment({
  VELAROS_OLLAMA_CHAT_MODEL: 'qwen3:8b',
})

void providers
void compositionContract
void cloudRuntime
void client
void adapter
void cloudAdapter
void defaultComposition
void legacyRequestOptions
void registry
void adapterKind
void preset
void runtimeConfig
void selection
void modelEnvironment.resolveOllamaChatModel()
void OllamaProviderId
void OpenRouterFreeModelId
