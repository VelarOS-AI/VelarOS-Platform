import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'

import type {
  ModelCallProviderOptions,
  ReasoningProviderOptionsResolver,
} from '../../types/adapters'
import { mergeProviderOptions } from '../../utils/wire/reasoning'

/**
 * 包着另一个语言模型，每次调用时把这一轮算出的 reasoning 参数合进 providerOptions。
 *
 * 和提示词缓存那一层同样的道理：参数逐轮构造，包一层能让合并落在唯一必经之路上。
 * 参数是逐轮**算**而不是构造时算死的：ultra 档的 thinking budget 要按这次调用的
 * `maxOutputTokens` 换算，而输出上限只有走到 `doGenerate` / `doStream` 才知道。
 */
export interface ReasoningLanguageModelApi extends LanguageModelV3 {}

export class ReasoningLanguageModel implements ReasoningLanguageModelApi {
  constructor(
    private readonly model: LanguageModelV3,
    private readonly resolveProviderOptions: ReasoningProviderOptionsResolver
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
    const providerOptions = this.resolveProviderOptions(options.maxOutputTokens)
    if (!providerOptions) return options

    return {
      ...options,
      providerOptions: mergeProviderOptions(
        options.providerOptions,
        providerOptions
      ) as ModelCallProviderOptions,
    }
  }
}
