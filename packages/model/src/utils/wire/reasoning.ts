import { isFiniteNumber, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'

import type { ReasoningEffort } from '../../types/adapters'
import type { ChatProviderId, ReasoningLevel, ThinkingDepth } from '../../types/model'
import { ModelTuning } from '../tuning'

/**
 * 是否拿到了可按比例换算的输出预算。
 *
 * 判据：缺席、`NaN`/`Infinity` 与 **0** 都必须走各档常量兜底——0 直接按比例算会得出
 * 0 budget，等于悄悄关掉 reasoning（§2.4 失败方向）。负数**刻意仍走比例路径**：
 * 结果被下游预算下限兜住，本批不改既有行为。
 */
function hasUsableOutputBudget(maxOutputTokens?: number): maxOutputTokens is number {
  return isFiniteNumber(maxOutputTokens) && maxOutputTokens !== 0
}

/** 把任意输入收窄成三档思考深度，认不出来的按 balanced。 */
export function requireThinkingDepth(depth?: LooseOptional<ThinkingDepth>): ThinkingDepth {
  return depth === 'fast' || depth === 'balanced' || depth === 'deep'
    ? depth
    : 'balanced'
}

/** 五档思考力度落到三档思考深度上。 */
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

/** 三档思考深度对应的 reasoning 力度。 */
export function resolveThinkingDepthEffort(depth?: LooseOptional<ThinkingDepth>): ReasoningEffort {
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
export function isReasoningDisabledByLevel(level?: LooseOptional<ReasoningLevel>): boolean {
  return level === 'off'
}

/** reasoning 力度：有 5 档 level 时优先按 level，否则回落到 3 档 thinkingDepth。ultra 与 high 同为 high effort（力度轴上限），差异体现在 budget。 */
export function resolveReasoningEffort(
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
export function resolveReasoningBudget(
  maxOutputTokens?: number,
  level?: LooseOptional<ReasoningLevel>,
  depth?: LooseOptional<ThinkingDepth>
): number {
  const effectiveDepth = level ? reasoningLevelToThinkingDepth(level) : depth
  const base = resolveThinkingBudget(maxOutputTokens, effectiveDepth)
  if (level !== 'ultra') return base

  const boosted = hasUsableOutputBudget(maxOutputTokens)
    ? Math.min(
        ModelTuning.reasoning.ultraCeil,
        Math.floor(maxOutputTokens * ModelTuning.reasoning.ultraRatio)
      )
    : ModelTuning.reasoning.ultraFloor
  return Math.max(base, boosted)
}

/** 三档思考深度对应的 thinking budget；没有输出预算可换算时走各档常量。 */
export function resolveThinkingBudget(
  maxOutputTokens?: number,
  depth?: LooseOptional<ThinkingDepth>
): number {
  const normalizedDepth = requireThinkingDepth(depth)

  if (!hasUsableOutputBudget(maxOutputTokens)) {
    switch (normalizedDepth) {
      case 'fast':
        return ModelTuning.reasoning.budgetFast
      case 'deep':
        return ModelTuning.reasoning.budgetDeep
      default:
        return ModelTuning.reasoning.budgetBalanced
    }
  }

  const multiplier =
    normalizedDepth === 'fast'
      ? ModelTuning.reasoning.fastMultiplier
      : normalizedDepth === 'deep'
        ? ModelTuning.reasoning.deepMultiplier
        : 1
  const maxBudget =
    normalizedDepth === 'deep' ? ModelTuning.reasoning.budgetMaxDeep : ModelTuning.reasoning.budgetMax

  return Math.max(
    ModelTuning.reasoning.budgetMin,
    Math.min(maxBudget, Math.floor(maxOutputTokens * ModelTuning.reasoning.budgetRatio * multiplier))
  )
}

/** OpenRouter 与 Velar 路由层的 reasoning 开关：off 显式关，ultra 抬 token 预算，其余只给力度。 */
export function mergeOpenRouterReasoning(
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
      max_tokens: isNumber(base.max_tokens) ? base.max_tokens : ModelTuning.reasoning.ultraCeil,
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

/** 按 provider 与具体模型算出这一轮要附加的 reasoning providerOptions；不需要时返回 null。 */
export function createThinkingDepthProviderOptions(
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

/** 两层选项合并：同名的厂商命名空间做浅合并，别的直接覆盖。 */
export function mergeProviderOptions(
  existing: Optional<Record<string, unknown>>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) }

  Object.entries(next).forEach(([key, value]) => {
    const current = merged[key]
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? { ...current, ...(value as Record<string, unknown>) }
        : value
  })

  return merged
}

/** Claude 的思考参数：自适应思考那一代发 effort，其余发固定 budget。 */
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

/** 这个模型名看起来是不是 OpenAI 的推理模型。 */
function matchesOpenAiReasoningModel(model: string): boolean {
  return /(?:^|\/)(?:o[34](?:-|$)|gpt-[45]|gpt-oss)/i.test(model)
}

/** 这个模型名看起来是不是支持 thinking 的 Claude。 */
function matchesClaudeReasoningModel(model: string): boolean {
  return [
    /claude-(?:opus|sonnet|haiku)-(?:latest|4(?:[.-]\d+)?)/i,
    /claude-(?:4(?:[.-]\d+)?)-(?:opus|sonnet|haiku)/i,
    /claude-(?:3[.-]7-sonnet|sonnet-3[.-]7)/i,
  ].some((matcher) => matcher.test(model))
}

/** 这个模型名看起来是不是自适应思考那一代的 Claude。 */
function matchesAdaptiveClaudeThinkingModel(model: string): boolean {
  return [
    /claude-(?:opus|sonnet)-(?:latest|4[.-](?:6|7)(?:\D|$))/i,
    /claude-4[.-](?:6|7)(?:\D|$).*(?:opus|sonnet)/i,
  ].some((matcher) => matcher.test(model))
}

/** 这个模型名看起来是不是支持 thinking 的 Gemini。 */
function matchesGoogleReasoningModel(model: string): boolean {
  return /gemini-(?:2\.5|3(?:[.-]|$))/i.test(model)
}

/** 把这一轮的推理档位注进 Velar 路由的请求体；注不进去就保留原请求，宁可这一轮不带 reasoning。 */
export function injectVelarThinkingRouting(
  init: Parameters<typeof fetch>[1],
  thinkingDepth?: LooseOptional<ThinkingDepth>,
  reasoningLevel?: LooseOptional<ReasoningLevel>
): Parameters<typeof fetch>[1] {
  if (!thinkingDepth && !reasoningLevel) return init
  if (!isString(init?.body)) return init

  try {
    const body = JSON.parse(init.body)
    if (!isPlainObject(body)) return init

    return {
      ...init,
      body: JSON.stringify({
        ...body,
        reasoning: mergeOpenRouterReasoning(body.reasoning, thinkingDepth, reasoningLevel),
      }),
    }
  } catch (error) {
    // 注入失败一律保留原始请求体：宁可这一轮不带 reasoning，也不能让路由参数把请求打坏（§2.4）。
    Log.tag('VelarModelAdapter').debug('注入 Velar reasoning 路由失败，保留原始请求体', { error })
    return init
  }
}
