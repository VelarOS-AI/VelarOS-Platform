import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'

import type { ModelCallProviderOptions } from '../../types/adapters'
import type { ReasoningLevel } from '../../types/model'
import { mergeProviderOptions } from '../../utils/wire/reasoning'

import type { ReasoningFallbackApi } from './ReasoningFallback'

/**
 * 包着另一个语言模型，每次调用时把这一轮的 reasoning 参数合进 providerOptions。
 *
 * 和提示词缓存那一层同样的道理：参数逐轮构造，包一层能让合并落在唯一必经之路上。
 * 参数是逐轮**算**而不是构造时算死的：按数字预算发的型号要按这次调用的 `maxOutputTokens` 换算，
 * 而输出上限只有走到 `doGenerate` / `doStream` 才知道。型号不认这一档时由 `fallback` 往下退档重发。
 */
export interface ReasoningLanguageModelApi extends LanguageModelV3 {}

export class ReasoningLanguageModel implements ReasoningLanguageModelApi {
  constructor(
    private readonly model: LanguageModelV3,
    private readonly reasoning: {
      /** 退档记忆里这个型号的键。 */
      readonly key: string
      /** 这一轮选的思考力度。 */
      readonly level: ReasoningLevel
      readonly fallback: ReasoningFallbackApi
      /** 按这一档与这次的输出上限算 reasoning 选项；null（不带思考参数）或这一档不发时返回 null。 */
      readonly resolve: (
        level: Nullable<ReasoningLevel>,
        maxOutputTokens?: number
      ) => Nullable<ModelCallProviderOptions>
    }
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
    return this.call(options, (merged) => this.model.doGenerate(merged))
  }

  public doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    return this.call(options, (merged) => this.model.doStream(merged))
  }

  private call<T>(
    options: LanguageModelV3CallOptions,
    invoke: (options: LanguageModelV3CallOptions) => PromiseLike<T>
  ): Promise<T> {
    const { key, level, fallback, resolve } = this.reasoning
    return fallback.run(key, level, (current) => invoke(this.mergeOptions(options, current)), {
      signature: (current) => JSON.stringify(resolve(current, options.maxOutputTokens)),
    })
  }

  private mergeOptions(
    options: LanguageModelV3CallOptions,
    level: Nullable<ReasoningLevel>
  ): LanguageModelV3CallOptions {
    const providerOptions = this.reasoning.resolve(level, options.maxOutputTokens)
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
