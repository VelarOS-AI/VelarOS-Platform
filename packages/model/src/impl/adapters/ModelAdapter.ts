import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes } from '../../contract/constants.js'
import type { ModelProviderAdapter } from '../../contract/requires'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../../types/adapters'
import type { ChatProviderId } from '../../types/model'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'

import { ReasoningFallback, type ReasoningFallbackApi } from './ReasoningFallback'

/**
 * 模型适配器基类。
 *
 * 子类负责把统一的 `ModelAdapterConfig` 转换为 provider SDK/API 需要的参数。
 * 语言模型和 embedding 是分开的能力：不支持 embedding 的 provider 复用这里的默认错误。
 *
 * @deprecated 扩展点已经换成注入面的 `ModelProviderAdapter`：宿主自带适配器实现那个接口，
 * 从 `createModelRuntimeComposition({ adapters })` 传进来即可，不必继承本类。
 * 本类下一轮入口收口后不再出包。
 */
abstract class ModelAdapter implements ModelProviderAdapter {
  /** 思考参数被拒时的退档记忆：适配器随运行时对象图各建一份，型号能用的档记在这里。 */
  protected readonly reasoningFallback: ReasoningFallbackApi = new ReasoningFallback()

  constructor(
    private readonly providerIds: readonly ChatProviderId[],
    private readonly providers: ModelProviderCollectionApi
  ) {}

  /** 这个 adapter 是否支持指定 provider。 */
  public supports(provider: ChatProviderId): boolean {
    return this.providerIds.includes(provider)
  }

  /** 创建语言模型工厂。 */
  public abstract createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory

  /** 创建 embedding 请求；默认表示这个 provider 没有接入 embedding。 */
  public createEmbeddingRequest(
    config: ModelAdapterConfig,
    _model: string,
    _texts: string[]
  ): EmbeddingRequest {
    throw new AppError(
      ModelErrorCodes.embeddingUnsupported,
      `${config.provider} 当前未接入 embedding 适配`
    )
  }

  /** 优先使用显式 apiKey，其次按 provider preset 读取环境变量。 */
  protected resolveApiKey(config: ModelAdapterConfig): string {
    return this.providers.resolveApiKey(config)
  }

  /**
   * 获取必需 API key；可选 key provider 允许返回空字符串。
   *
   * 判据与文案都收在 `ModelProviderCollection.requireApiKey` 一处：同一个"缺 key"以前在这里和
   * provider 集合里各写一遍，文案不一样，产品按文字分支时会漏掉其中一条。
   */
  protected requireApiKey(config: ModelAdapterConfig): string {
    return this.providers.requireApiKey(config)
  }

  /** 按 provider preset 解析最终 baseURL。 */
  protected resolveBaseURL(config: Pick<ModelAdapterConfig, 'provider' | 'baseURL'>): string {
    return this.providers.resolveBaseURL(config)
  }
}

export { ModelAdapter }
