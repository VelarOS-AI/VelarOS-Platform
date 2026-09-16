import type { LanguageModel } from 'ai'

import { isFunction } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ProviderScriptRegistryPort } from '../../types/scripts'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'
import type { ProviderScriptRegistryScripts } from '../providers/ProviderScriptRegistry'

import { languageModelWrappers } from './LanguageModelWrappers'
import { ModelAdapter } from './ModelAdapter'

/**
 * 把注入的 provider script 接成一个适配器。
 *
 * 这里不判信任：脚本能进注册表就已经过了显式登记这道门（见 `ProviderScriptRegistry` 的信任模型）。
 */
export class ProviderScriptModelAdapter extends ModelAdapter implements ModelProviderAdapter {
  constructor(
    private readonly registry: ProviderScriptRegistryScripts & ProviderScriptRegistryPort,
    providers: ModelProviderCollectionApi
  ) {
    super([], providers)
  }

  public override supports(provider: ChatProviderId): boolean {
    return this.registry.supportsProvider(provider)
  }

  public createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory {
    const script = this.registry.requireProviderScript(config.provider)
    const createFactory = script.definition.createLanguageModelFactory
    if (!createFactory) {
      throw new AppError(
        ModelErrorCodes.providerScriptInvalid,
        `${config.provider} provider script 缺少 createLanguageModelFactory。`
      )
    }

    const factory = createFactory({
      config,
      helpers: script.helpers,
      runtimeMetadata: config.providerScriptRuntimeMetadata,
    })
    if (!isFunction(factory)) {
      throw new AppError(
        ModelErrorCodes.providerScriptInvalid,
        `${config.provider} provider script 的 createLanguageModelFactory 必须返回函数。`
      )
    }

    return (modelId, options) =>
      languageModelWrappers.withPromptCache(factory(modelId, options) as LanguageModel)
  }

  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest {
    const script = this.registry.requireProviderScript(config.provider)
    const createEmbeddingRequest = script.definition.createEmbeddingRequest
    if (!createEmbeddingRequest) return super.createEmbeddingRequest(config, model, texts)

    return createEmbeddingRequest({
      config,
      helpers: script.helpers,
      runtimeMetadata: config.providerScriptRuntimeMetadata,
      model,
      texts,
    })
  }
}
