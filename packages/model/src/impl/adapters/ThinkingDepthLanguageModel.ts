import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'

import type { ModelCallProviderOptions } from '../../types/adapters'
import { mergeProviderOptions } from '../../utils/wire/reasoning'

/**
 * 包着另一个语言模型，每次调用时把这一轮算好的 reasoning 参数合进 providerOptions。
 *
 * 和提示词缓存那一层同样的道理：参数逐轮构造，包一层能让合并落在唯一必经之路上。
 */
export interface ThinkingDepthLanguageModelApi extends LanguageModelV3 {}

export class ThinkingDepthLanguageModel implements ThinkingDepthLanguageModelApi {
  constructor(
    private readonly model: LanguageModelV3,
    private readonly providerOptions: ModelCallProviderOptions
  ) {}

  public get specificationVersion(): 'v3' {
    return this.model.specificationVersion
  }

  public get provider(): string {
    return this.model.provider
  }

  public get modelId(): string {
    return this.model.modelId
  }

  public get supportedUrls(): LanguageModelV3['supportedUrls'] {
    return this.model.supportedUrls
  }

  public doGenerate(
    options: LanguageModelV3CallOptions
  ): PromiseLike<LanguageModelV3GenerateResult> {
    return this.model.doGenerate(this.mergeOptions(options))
  }

  public doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    return this.model.doStream(this.mergeOptions(options))
  }

  private mergeOptions(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
    return {
      ...options,
      providerOptions: mergeProviderOptions(
        options.providerOptions,
        this.providerOptions
      ) as ModelCallProviderOptions,
    }
  }
}
