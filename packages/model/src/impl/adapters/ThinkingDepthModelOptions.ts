import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import { isFiniteNumber, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from '../../types/ModelContracts'

type ReasoningEffort = 'low' | 'medium' | 'high'
type ProviderOptions = NonNullable<LanguageModelV3CallOptions['providerOptions']>

const DefaultThinkingDepth: ThinkingDepth = 'balanced'
/** ultra 档无显式 maxOutputTokens 时使用的 thinking budget 下限。 */
const UltraReasoningBudgetFloor = 16_000
/** ultra 档 thinking budget 的硬上限。 */
const UltraReasoningBudgetCeil = 24_000
/** ultra 档相对 maxOutputTokens 的预算系数。 */
const UltraReasoningBudgetRatio = 0.6
/** 非 ultra 档相对 maxOutputTokens 的预算系数基线（再乘各档 multiplier）。 */
const ThinkingBudgetRatio = 0.35

/**
 * 是否拿到了可按比例换算的输出预算。
 *
 * 判据：缺席、`NaN`/`Infinity` 与 **0** 都必须走各档常量兜底——0 直接按比例算会得出
 * 0 budget，等于悄悄关掉 reasoning（§2.4 失败方向）。负数**刻意仍走比例路径**：
 * 结果被下游 `Math.max(1024, …)` 的下限兜住，本批不改既有行为，真要拒的话该在入口挡（见报告）。
 */
function hasUsableOutputBudget(maxOutputTokens?: number): maxOutputTokens is number {
  return isFiniteNumber(maxOutputTokens) && maxOutputTokens !== 0
}

function requireThinkingDepth(depth?: LooseOptional<ThinkingDepth>): ThinkingDepth {
  return depth === 'fast' || depth === 'balanced' || depth === 'deep'
    ? depth
    : DefaultThinkingDepth
}

function reasoningLevelToThinkingDepth(level: ReasoningLevel): ThinkingDepth {
  switch (level) {
    case 'off':
    case 'low':
      return 'fast'
    case 'high':
    case 'ultra':
      return 'deep'
    default:
      return 'balanced'
  }
}

function resolveThinkingDepthEffort(depth?: LooseOptional<ThinkingDepth>): ReasoningEffort {
  switch (requireThinkingDepth(depth)) {
    case 'fast':
      return 'low'
    case 'deep':
      return 'high'
    default:
      return 'medium'
  }
}

/** off 档：本次请求完全不发 reasoning。 */
function isReasoningDisabledByLevel(level?: LooseOptional<ReasoningLevel>): boolean {
  return level === 'off'
}

/** reasoning 力度：有 5 档 level 时优先按 level，否则回落到 3 档 thinkingDepth。ultra 与 high 同为 high effort（力度轴上限），差异体现在 budget。 */
function resolveReasoningEffort(
  level?: LooseOptional<ReasoningLevel>,
  depth?: LooseOptional<ThinkingDepth>
): ReasoningEffort {
  switch (level) {
    case 'off':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'ultra':
      return 'high'
    default:
      return resolveThinkingDepthEffort(depth)
  }
}

/** thinking budget：ultra 档在 deep 基础上进一步抬高，其余按 level→thinkingDepth 映射。 */
function resolveReasoningBudget(
  maxOutputTokens?: number,
  level?: LooseOptional<ReasoningLevel>,
  depth?: LooseOptional<ThinkingDepth>
): number {
  const effectiveDepth = level ? reasoningLevelToThinkingDepth(level) : depth
  const base = resolveThinkingBudget(maxOutputTokens, effectiveDepth)
  if (level !== 'ultra') return base

  const boosted = hasUsableOutputBudget(maxOutputTokens)
    ? Math.min(UltraReasoningBudgetCeil, Math.floor(maxOutputTokens * UltraReasoningBudgetRatio))
    : UltraReasoningBudgetFloor
  return Math.max(base, boosted)
}

function resolveThinkingBudget(
  maxOutputTokens?: number,
  depth?: LooseOptional<ThinkingDepth>
): number {
  const normalizedDepth = requireThinkingDepth(depth)

  if (!hasUsableOutputBudget(maxOutputTokens)) {
    switch (normalizedDepth) {
      case 'fast':
        return 2048
      case 'deep':
        return 8192
      default:
        return 4096
    }
  }

  const multiplier =
    normalizedDepth === 'fast'
      ? 0.5
      : normalizedDepth === 'deep'
        ? 1.5
        : 1
  const maxBudget = normalizedDepth === 'deep' ? 12_000 : 8192

  return Math.max(1024, Math.min(maxBudget, Math.floor(maxOutputTokens * ThinkingBudgetRatio * multiplier)))
}

function mergeOpenRouterReasoning(
  existing: unknown,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): Record<string, unknown> {
  const base = isPlainObject(existing) ? existing : {}

  // off：显式关闭 reasoning（即便上游漏掉 enable 门控也兜底）。
  if (level === 'off') return { ...base, enabled: false, exclude: true }

  // ultra：高 effort 之外再抬高 token 预算，使其在支持 max_tokens 的 provider 上区别于 high。
  if (level === 'ultra') return {
      ...base,
      effort: 'high',
      max_tokens: isNumber(base.max_tokens) ? base.max_tokens : UltraReasoningBudgetCeil,
    }

  return {
    ...base,
    effort: isString(base.effort) ? base.effort : resolveReasoningEffort(level, depth),
  }
}

/**
 * off 档各家的写法（查各家 API 语义后逐家定，不是一刀切）：
 *
 * - **anthropic 必须显式发关闭**：省略 `thinking` 不等于不思考——新一代模型的自适应思考是默认开的，
 *   `claude-*-latest` 这类别名更可能指到默认开的那一代。厂商的关闭写法是 `thinking: { type: 'disabled' }`，
 *   3.7/4.x 都接受；5 一代只在 effort ≤ high 时接受，本档刻意不发 `effort`（服务端默认就是 high），所以也安全。
 *   **加模型匹配器时要一起查这条**：有的型号（思考永远开的那一代）会直接拒绝 `disabled`，只能省略 `thinking`；
 *   现在 `matchesClaudeReasoningModel` 匹配不到它们，所以这里没有分支。
 * - **openai / google 一个推理参数都不发**：两家都没有覆盖本包全部推理模型的通用关闭写法
 *   （`reasoning_effort: 'none'` 要 GPT-5.1 起才支持，发给 o3/o4 会被拒；`thinkingBudget: 0` 只有
 *   Gemini 2.5 Flash 一系接受，2.5 Pro 有下限、Gemini 3 改用 `thinkingLevel` 且没有关闭档）。
 *   发错写法是整条请求被拒，比"这一档少省一点思考"严重得多，所以退回"不发"，由服务端默认值兜底。
 * - **OpenRouter 与 Velar 不走这里**：它们在请求体里发 `reasoning: { enabled: false, exclude: true }`
 *   （见 `mergeOpenRouterReasoning`），那是路由层自己的开关，与上游模型默认值无关。
 */
function createReasoningDisabledProviderOptions(
  provider: ChatProviderId,
  model: string
): Nullable<Record<string, unknown>> {
  if (provider !== 'anthropic' || !matchesClaudeReasoningModel(model)) return null

  return { anthropic: { thinking: { type: 'disabled' } } }
}

function createThinkingDepthProviderOptions(
  provider: ChatProviderId,
  model: string,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): Nullable<Record<string, unknown>> {
  // off 先判：这一档与 thinkingDepth 无关，缺 depth 时也要生效。
  if (isReasoningDisabledByLevel(level)) return createReasoningDisabledProviderOptions(provider, model)
  if (!depth) return null

  switch (provider) {
    case 'openai':
      return matchesOpenAiReasoningModel(model)
        ? {
            openai: {
              reasoningEffort: resolveThinkingDepthEffort(depth),
              reasoningSummary: 'auto',
            },
          }
        : null
    case 'anthropic':
      return matchesClaudeReasoningModel(model)
        ? {
            anthropic: createAnthropicThinkingOptions(model, depth),
          }
        : null
    case 'google':
      return matchesGoogleReasoningModel(model)
        ? {
            google: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: resolveThinkingBudget(undefined, depth),
              },
            },
          }
        : null
    default:
      return null
  }
}

function applyThinkingDepthProviderOptions(
  model: LanguageModel,
  provider: ChatProviderId,
  modelId: string,
  depth?: LooseOptional<ThinkingDepth>,
  level?: LooseOptional<ReasoningLevel>
): LanguageModel {
  const providerOptions = createThinkingDepthProviderOptions(provider, modelId, depth, level)
  if (!providerOptions || isString(model) || model.specificationVersion !== 'v3') return model

  return new ThinkingDepthLanguageModel(model, providerOptions as ProviderOptions)
}

class ThinkingDepthLanguageModel implements LanguageModelV3 {
  constructor(
    private readonly model: LanguageModelV3,
    private readonly providerOptions: ProviderOptions
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
      providerOptions: mergeProviderOptions(options.providerOptions, this.providerOptions),
    }
  }
}

function mergeProviderOptions(
  existing: LanguageModelV3CallOptions['providerOptions'],
  next: ProviderOptions
): ProviderOptions {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }

  Object.entries(next).forEach(([key, value]) => {
    const current = merged[key]
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? { ...current, ...(value as Record<string, unknown>) }
        : value
  })

  return merged as ProviderOptions
}

function createAnthropicThinkingOptions(model: string, depth: ThinkingDepth): Record<string, unknown> {
  if (matchesAdaptiveClaudeThinkingModel(model)) return {
      sendReasoning: true,
      thinking: {
        type: 'adaptive',
        display: 'summarized',
      },
      effort: resolveThinkingDepthEffort(depth),
    }

  return {
    sendReasoning: true,
    thinking: {
      type: 'enabled',
      budgetTokens: resolveThinkingBudget(undefined, depth),
    },
  }
}

function matchesOpenAiReasoningModel(model: string): boolean {
  return /(?:^|\/)(?:o[34](?:-|$)|gpt-[45]|gpt-oss)/i.test(model)
}

function matchesClaudeReasoningModel(model: string): boolean {
  return [
    /claude-(?:opus|sonnet|haiku)-(?:latest|4(?:[.-]\d+)?)/i,
    /claude-(?:4(?:[.-]\d+)?)-(?:opus|sonnet|haiku)/i,
    /claude-(?:3[.-]7-sonnet|sonnet-3[.-]7)/i,
  ].some((matcher) => matcher.test(model))
}

function matchesAdaptiveClaudeThinkingModel(model: string): boolean {
  return [
    /claude-(?:opus|sonnet)-(?:latest|4[.-](?:6|7)(?:\D|$))/i,
    /claude-4[.-](?:6|7)(?:\D|$).*(?:opus|sonnet)/i,
  ].some((matcher) => matcher.test(model))
}

function matchesGoogleReasoningModel(model: string): boolean {
  return /gemini-(?:2\.5|3(?:[.-]|$))/i.test(model)
}

export {
  applyThinkingDepthProviderOptions,
  createThinkingDepthProviderOptions,
  isReasoningDisabledByLevel,
  mergeOpenRouterReasoning,
  requireThinkingDepth,
  resolveReasoningBudget,
  resolveReasoningEffort,
  resolveThinkingBudget,
  resolveThinkingDepthEffort,
}
export type { ReasoningEffort }
