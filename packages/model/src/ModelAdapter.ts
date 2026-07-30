import type { LanguageModel } from 'ai'

import { isBlank } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  AgentProviderAdapterConfig,
  ChatProviderId,
  ModelRequestOptions,
  ReasoningLevel,
  ThinkingDepth,
} from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import type { ProviderScriptRuntimeMetadata } from './ProviderScriptRegistryPort'

export interface ModelAdapterConfig {
  /** 聊天 provider id。 */
  provider: ChatProviderId
  /** UI 配置或环境变量中的 API key。 */
  apiKey: string
  /** provider base URL，已按 preset 做过默认值解析。 */
  baseURL: string
  /** 用户上传的自定义 provider adapter。 */
  adapter?: LooseOptional<AgentProviderAdapterConfig>
  /** 本次请求期望的模型运行策略；adapter 会按 provider 能力映射为 reasoning/thinking 参数。 */
  thinkingDepth?: LooseOptional<ThinkingDepth>
  /** Composer 思考力度 5 档；存在时优先于 thinkingDepth 决定 reasoning 开关/力度/预算。 */
  reasoningLevel?: LooseOptional<ReasoningLevel>
  /** 本地 provider script 已解析的运行时元数据；执行阶段复用它，避免同一轮运行二次解析漂移。 */
  providerScriptRuntimeMetadata?: LooseOptional<ProviderScriptRuntimeMetadata>
}

/** embedding 请求的 provider 无关描述。 */
export interface EmbeddingRequest {
  url: string
  headers: Record<string, string>
  body?: unknown
  execute?: () => Promise<unknown>
}

/** 延迟到具体 modelId 才创建 AI SDK LanguageModel。 */
export type LanguageModelFactory = (modelId: string, options?: ModelRequestOptions) => LanguageModel

/**
 * 模型适配器基类。
 *
 * 子类负责把统一的 ModelAdapterConfig 转换为 provider SDK/API 需要的参数。
 * 语言模型和 embedding 是分开的能力：不支持 embedding 的 provider 可复用默认错误。
 */
abstract class ModelAdapter {
  constructor(
    private readonly providerIds: readonly ChatProviderId[],
    private readonly providers: ModelProviderCollection
  ) {}

  /** 这个 adapter 是否支持指定 provider。 */
  public supports(provider: ChatProviderId): boolean {
    return this.providerIds.includes(provider)
  }

  /** 创建语言模型工厂。 */
  public abstract createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory

  /** 创建 embedding 请求；默认表示不支持 embedding。 */
  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    _model: string,
    _texts: string[]
  ): EmbeddingRequest {
    throw new AppError(
      'VALIDATION',
      `${config.provider} 当前未接入 embedding 适配，记忆会回退为文本检索`
    )
  }

  /** 优先使用显式 apiKey，其次按 provider preset 读取环境变量。 */
  protected resolveApiKey(config: ModelAdapterConfig): string {
    return this.providers.resolveApiKey(config)
  }

  /** 获取必需 API key；可选 key provider 允许返回空字符串。 */
  protected requireApiKey(config: ModelAdapterConfig): string {
    const apiKey = this.resolveApiKey(config)
    if (!isBlank(apiKey)) return apiKey

    const preset = this.providers.requireOperationalManifest(config.provider)
    if (preset.apiKeyOptional) return ''

    throw new AppError(
      'VALIDATION',
      `${preset.label} 的 API Key 未配置，请由宿主提供凭证。`
    )
  }

  /** 按 provider preset 解析最终 baseURL。 */
  protected resolveBaseURL(
    config: Pick<ModelAdapterConfig, 'provider' | 'baseURL'>
  ): string {
    return this.providers.resolveBaseURL(config)
  }
}

export { ModelAdapter }
