import { AppError } from '@velaros-ai/core/error'

import { AnthropicModelAdapter } from './AnthropicModelAdapter'
import { DeepSeekModelAdapter } from './DeepSeekModelAdapter'
import { GoogleModelAdapter } from './GoogleModelAdapter'
import type { LocalModelEnvironment } from './LocalModelEnvironment'
import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './ModelAdapter'
import type { ModelAdapter } from './ModelAdapter'
import type { ModelAdapterRegistryPort } from './ModelAdapterRegistryPort'
import type { ChatProviderId } from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { NodeLocalModelEnvironment } from './NodeLocalModelEnvironment'
import { OpenAICompatibleModelAdapter } from './OpenAICompatibleModelAdapter'
import { OpenAIModelAdapter } from './OpenAIModelAdapter'
import {
  ProviderScriptModelAdapter,
  type ProviderScriptRegistry,
} from './ProviderScriptRegistry'
import { UserJsModelAdapter } from './UserJsModelAdapter'
import {
  type VelarCloudModelRuntime,
  velarCloudModelRuntime,
} from './VelarCloudModelRuntime'
import { VelarModelAdapter } from './VelarModelAdapter'

/**
 * 模型适配器注册表。
 *
 * 不同 provider 的 SDK/API 差异都封装在 ModelAdapter 里；Agent 只通过
 * Registry 按 provider 找到适配器，再创建 language model 或 embedding 请求。
 */
class ModelAdapterRegistry implements ModelAdapterRegistryPort {
  constructor(private readonly adapters: readonly ModelAdapter[]) {
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
  private getAdapter(provider: ChatProviderId): ModelAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(provider))
    if (!adapter) {
      throw new AppError('VALIDATION', `未找到 provider 适配器：${provider}`)
    }

    return adapter
  }
}

/**
 * 为一个产品 composition 创建独立的模型适配器注册表。
 *
 * adapter 顺序会影响 provider 匹配优先级；可变的 provider-script registry
 * 必须由同一个 composition 显式传入，禁止回落到进程全局状态。
 */
function createModelAdapterRegistry(
  providerScriptRegistry: ProviderScriptRegistry,
  providers: ModelProviderCollection,
  velarCloudRuntime: VelarCloudModelRuntime,
  localModelEnvironment: LocalModelEnvironment = new NodeLocalModelEnvironment()
): ModelAdapterRegistry {
  return new ModelAdapterRegistry([
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
  ])
}

/**
 * @deprecated 仅用于兼容 0.4.x 的进程级 Velar Cloud 绑定。
 * 新宿主必须创建自己的 `VelarCloudModelRuntime`，并调用
 * {@link createModelAdapterRegistry} 显式注入。
 */
function createLegacyModelAdapterRegistry(
  providerScriptRegistry: ProviderScriptRegistry,
  providers: ModelProviderCollection
): ModelAdapterRegistry {
  return createModelAdapterRegistry(
    providerScriptRegistry,
    providers,
    velarCloudModelRuntime
  )
}

export {
  createLegacyModelAdapterRegistry,
  createModelAdapterRegistry,
  ModelAdapterRegistry,
}
