import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ProviderScriptRegistryPort } from '../../types/scripts'
import { AnthropicModelAdapter } from '../adapters/AnthropicModelAdapter'
import { DeepSeekModelAdapter } from '../adapters/DeepSeekModelAdapter'
import { GoogleModelAdapter } from '../adapters/GoogleModelAdapter'
import { OpenAICompatibleModelAdapter } from '../adapters/OpenAICompatibleModelAdapter'
import { OpenAIModelAdapter } from '../adapters/OpenAIModelAdapter'
import { ProviderScriptModelAdapter } from '../adapters/ProviderScriptModelAdapter'
import { UserJsModelAdapter } from '../adapters/UserJsModelAdapter'
import { VelarModelAdapter } from '../adapters/VelarModelAdapter'
import type { LocalModelEnvironmentApi } from '../providers/LocalModelEnvironment'
import { LocalModelEnvironment } from '../providers/LocalModelEnvironment'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'
import type { ProviderScriptRegistryScripts } from '../providers/ProviderScriptRegistry'
import { type VelarCloudModelRuntimeLookup } from '../providers/VelarCloudModelRuntime'

/**
 * 模型适配器注册表。
 *
 * 不同 provider 的 SDK/API 差异都封装在各自的适配器里；Agent 只经注册表按 provider
 * 找到适配器，再创建语言模型或 embedding 请求。适配器顺序即匹配优先级。
 */
export interface ModelAdapterRegistryApi {
  /** 这个 provider 有没有能用的适配器。 */
  supportsProvider(provider: ChatProviderId): boolean
  /** 按这次调用的配置造一个语言模型工厂。 */
  createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory
  /** 按这次调用的配置造一个 embedding 请求；不支持 embedding 的 provider 由具体适配器抛可读错误。 */
  createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest
}

export class ModelAdapterRegistry implements ModelAdapterRegistryApi {
  private readonly adapters: readonly ModelProviderAdapter[]

  /**
   * 适配器顺序即匹配优先级：宿主自带的排最前，然后是 Cloud 托管、provider script，
   * 最后才是各家内置 SDK。可变的 provider script 注册表必须由同一个装配显式传入，
   * 禁止回落到进程全局状态。
   */
  constructor(
    providerScriptRegistry: ProviderScriptRegistryScripts & ProviderScriptRegistryPort,
    providers: ModelProviderCollectionApi,
    velarCloudRuntime: VelarCloudModelRuntimeLookup,
    localModelEnvironment: LocalModelEnvironmentApi = new LocalModelEnvironment(),
    injectedAdapters: readonly ModelProviderAdapter[] = []
  ) {
    this.adapters = [
      ...injectedAdapters,
      new VelarModelAdapter(providers, velarCloudRuntime),
      new ProviderScriptModelAdapter(providerScriptRegistry, providers),
      new AnthropicModelAdapter(providers.getProviderIdsByAdapterKind('anthropic-sdk'), providers),
      new GoogleModelAdapter(providers.getProviderIdsByAdapterKind('google-sdk'), providers),
      new DeepSeekModelAdapter(providers.getProviderIdsByAdapterKind('deepseek-sdk'), providers),
      new OpenAICompatibleModelAdapter(
        providers.getProviderIdsByAdapterKind('openai-compatible'),
        providers,
        localModelEnvironment
      ),
      new OpenAIModelAdapter(providers.getProviderIdsByAdapterKind('openai-sdk'), providers),
      new UserJsModelAdapter(providers.getProviderIdsByAdapterKind('custom-js'), providers),
    ]
  }

  /** 判断当前 provider 是否有适配器。 */
  public supportsProvider(provider: ChatProviderId): boolean {
    return this.adapters.some((adapter) => adapter.supports(provider))
  }

  /** 创建 AI SDK LanguageModel factory。 */
  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    return this.getAdapter(config.provider).createLanguageModelFactory(config)
  }

  /** 创建 embedding 请求；不支持的 provider 会由具体 adapter 抛出可读错误。 */
  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    return this.getAdapter(config.provider).createEmbeddingRequest(config, model, texts)
  }

  /** 按 provider 查找第一个匹配适配器。 */
  private getAdapter(provider: ChatProviderId): ModelProviderAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(provider))
    if (!adapter) {
      throw new AppError(ModelErrorCodes.adapterMissing, `未找到 provider 适配器：${provider}`)
    }

    return adapter
  }
}
