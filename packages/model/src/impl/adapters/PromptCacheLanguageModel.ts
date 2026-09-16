import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import { isString } from '@velaros-ai/core'

import { applyPromptCacheCallOptions as applyCallOptions } from '../../utils/wire/prompt-cache'

/**
 * 包着另一个语言模型，出线前把内部的提示词缓存标记翻译成各家的线上字段。
 *
 * 为什么包一层而不在装配处改选项：断点必须跟随每一次 `doGenerate` 或 `doStream`，
 * 而选项是逐轮构造的；包装模型让翻译落在唯一必经之路上，装配处漏接线也不会静默失效。
 */
export interface PromptCacheLanguageModelApi extends LanguageModelV3 {}

export class PromptCacheLanguageModel implements PromptCacheLanguageModelApi {
  constructor(private readonly model: LanguageModelV3) {}

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
    return this.model.doGenerate(applyCallOptions(options))
  }

  public doStream(options: LanguageModelV3CallOptions): PromiseLike<LanguageModelV3StreamResult> {
    return this.model.doStream(applyCallOptions(options))
  }
}

/** 给一个语言模型套上缓存标记翻译层；字符串模型与非 v3 模型原样返回。 */
export function applyPromptCacheProviderOptions(model: LanguageModel): LanguageModel {
  if (isString(model) || model.specificationVersion !== 'v3') return model

  return new PromptCacheLanguageModel(model)
}

/** 出线前把内部缓存标记整体翻译成各家的线上字段。 */
export function applyPromptCacheCallOptions(
  options: LanguageModelV3CallOptions
): LanguageModelV3CallOptions {
  return applyCallOptions(options)
}
