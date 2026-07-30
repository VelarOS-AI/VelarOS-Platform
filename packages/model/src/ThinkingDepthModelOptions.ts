import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import { isFiniteNumber, isNumber, isPlainObject, isString } from '@velaros-ai/core'

import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from './ModelContracts'

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

function createThinkingDepthProviderOptions(
  provider: ChatProviderId,
  model: string,
  depth?: LooseOptional<ThinkingDepth>
): Nullable<Record<string, unknown>> {
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
  depth?: LooseOptional<ThinkingDepth>
): LanguageModel {
  const providerOptions = createThinkingDepthProviderOptions(provider, modelId, depth)
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
