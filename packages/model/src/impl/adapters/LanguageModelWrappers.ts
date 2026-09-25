import type { LanguageModel } from 'ai'

import type { ModelCallProviderOptions } from '../../types/adapters'
import type { ChatProviderId, ReasoningLevel } from '../../types/model'
import { asWrappableLanguageModel } from '../../utils/wire/language-models'
import { createReasoningProviderOptions } from '../../utils/wire/reasoning'

import { PromptCacheLanguageModel } from './PromptCacheLanguageModel'
import { ReasoningLanguageModel } from './ReasoningLanguageModel'

/**
 * 给语言模型套包装层的那一处。
 *
 * 两层包装（提示词缓存标记的出线翻译、这一轮 reasoning 参数的合并）都必须落在每一次
 * `doGenerate` / `doStream` 的必经之路上，所以是包一层而不是在装配处改选项。
 * 谁能被包只判一次：字符串模型与非 v3 模型原样返回，各家适配器不再各自复制这道判断。
 * 实例是 `languageModelWrappers`。
 */
export interface LanguageModelWrappersApi {
  /** 套上提示词缓存标记的出线翻译层；包不了就原样返回。 */
  withPromptCache(model: LanguageModel): LanguageModel
  /** 套上这一轮 reasoning 参数的合并层；这一轮不需要发 reasoning、或包不了就原样返回。 */
  withReasoning(
    model: LanguageModel,
    provider: ChatProviderId,
    modelId: string,
    level?: LooseOptional<ReasoningLevel>
  ): LanguageModel
}

export class LanguageModelWrappers implements LanguageModelWrappersApi {
  public withPromptCache(model: LanguageModel): LanguageModel {
    const wrappable = asWrappableLanguageModel(model)

    return wrappable ? new PromptCacheLanguageModel(wrappable) : model
  }

  public withReasoning(
    model: LanguageModel,
    provider: ChatProviderId,
    modelId: string,
    level?: LooseOptional<ReasoningLevel>
  ): LanguageModel {
    // 包不包只看"这一档到底发不发 reasoning"，那个判断与输出上限无关，先按缺省算一遍即可。
    const wrappable = createReasoningProviderOptions(provider, modelId, level)
      ? asWrappableLanguageModel(model)
      : null
    if (!wrappable) return model

    return new ReasoningLanguageModel(
      wrappable,
      (maxOutputTokens) =>
        createReasoningProviderOptions(
          provider,
          modelId,
          level,
          maxOutputTokens
        ) as Nullable<ModelCallProviderOptions>
    )
  }
}

/** 整个进程共用的包装层入口：无状态。 */
export const languageModelWrappers: LanguageModelWrappersApi = new LanguageModelWrappers()
