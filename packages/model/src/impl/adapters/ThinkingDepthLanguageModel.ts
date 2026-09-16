import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import { isString } from '@velaros-ai/core'

import type { ModelCallProviderOptions } from '../../types/adapters'
import type {
  ChatProviderId,
  ReasoningEffort,
  ReasoningLevel,
  ThinkingDepth,
} from '../../types/model'
import {
  createThinkingDepthProviderOptions as createProviderOptions,
  mergeOpenRouterReasoning as mergeRouterReasoning,
  mergeProviderOptions,
  requireThinkingDepth as requireDepth,
  resolveThinkingBudget as resolveBudget,
  resolveThinkingDepthEffort as resolveDepthEffort,
} from '../../utils/wire/reasoning'

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

/** 给一个语言模型套上 reasoning 参数合并层；这一轮不需要发 reasoning 时原样返回。 */
export function applyThinkingDepthProviderOptions(
  model: LanguageModel,
  provider: ChatProviderId,
  modelId: string,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): LanguageModel {
  const providerOptions = createProviderOptions(provider, modelId, depth, level)
  if (!providerOptions || isString(model) || model.specificationVersion !== 'v3') return model

  return new ThinkingDepthLanguageModel(model, providerOptions as ModelCallProviderOptions)
}

/** 按 provider 与具体模型算出这一轮要附加的 reasoning providerOptions；不需要时返回 null。 */
export function createThinkingDepthProviderOptions(
  provider: ChatProviderId,
  model: string,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): Nullable<Record<string, unknown>> {
  return createProviderOptions(provider, model, depth, level)
}

/** OpenRouter 与 Velar 路由层的 reasoning 开关。 */
export function mergeOpenRouterReasoning(
  existing: unknown,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): Record<string, unknown> {
  return mergeRouterReasoning(existing, depth, level)
}

/** 把任意输入收窄成三档思考深度，认不出来的按 balanced。 */
export function requireThinkingDepth(depth?: LooseOptional<ThinkingDepth>): ThinkingDepth {
  return requireDepth(depth)
}

/** 三档思考深度对应的 thinking budget。 */
export function resolveThinkingBudget(
  maxOutputTokens?: number,
  depth?: LooseOptional<ThinkingDepth>
): number {
  return resolveBudget(maxOutputTokens, depth)
}

/** 三档思考深度对应的 reasoning 力度。 */
export function resolveThinkingDepthEffort(
  depth?: LooseOptional<ThinkingDepth>
): ReasoningEffort {
  return resolveDepthEffort(depth)
}
