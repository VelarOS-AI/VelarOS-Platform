import {
  isArray,
  isFiniteNumber,
  isNumber,
  isPlainObject,
  isString,
  Log,
  optionalWhen,
} from '@velaros-ai/core'

import { DefaultReasoningLevel } from '../../contract/constants'
import type { ReasoningEffort } from '../../types/adapters'
import type { ChatProviderId, ReasoningLevel } from '../../types/model'
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

/** reasoning 力度。ultra 与 high 同为 high effort（力度轴上限），差异体现在 budget。 */
export function resolveReasoningEffort(level: ReasoningLevel): ReasoningEffort {
  switch (level) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    default:
      return 'high'
  }
}

/**
 * thinking budget：low、medium、high 各有一档，ultra 在 high 之上再抬一档。
 *
 * 抬高的口径：拿不到本次请求的 `maxOutputTokens` 时按 `ultraFloor` 走，拿得到就按 `ultraRatio`
 * 换算再钳到 `ultraCeil`。比例小于 1 顺带保证了「预算严格小于输出上限」，这是 Anthropic
 * `budget_tokens < max_tokens` 的硬约束；`ultraCeil` 同时低于两家的 thinking budget 合法上限
 * （Gemini 2.5 Flash 24 576 / Pro 32 768，Claude 一系被匹配到的最小输出上限 32 000）。
 */
export function resolveReasoningBudget(
  maxOutputTokens: Optional<number>,
  level: ReasoningLevel
): number {
  const base = resolveTierBudget(maxOutputTokens, level === 'ultra' ? 'high' : level)
  if (level !== 'ultra') return base

  const boosted = hasUsableOutputBudget(maxOutputTokens)
    ? Math.min(
        ModelTuning.reasoning.ultraCeil,
        Math.floor(maxOutputTokens * ModelTuning.reasoning.ultraRatio)
      )
    : ModelTuning.reasoning.ultraFloor
  return Math.max(base, boosted)
}

/** low、medium、high 三档的 thinking budget；没有输出预算可换算时走各档常量。 */
function resolveTierBudget(
  maxOutputTokens: Optional<number>,
  tier: Exclude<ReasoningLevel, 'ultra'>
): number {
  if (!hasUsableOutputBudget(maxOutputTokens)) {
    switch (tier) {
      case 'low':
        return ModelTuning.reasoning.budgetLow
      case 'high':
        return ModelTuning.reasoning.budgetHigh
      default:
        return ModelTuning.reasoning.budgetMedium
    }
  }

  const multiplier =
    tier === 'low'
      ? ModelTuning.reasoning.lowMultiplier
      : tier === 'high'
        ? ModelTuning.reasoning.highMultiplier
        : 1
  const maxBudget =
    tier === 'high' ? ModelTuning.reasoning.budgetMaxHigh : ModelTuning.reasoning.budgetMax

  return Math.max(
    ModelTuning.reasoning.budgetMin,
    Math.min(
      maxBudget,
      Math.floor(maxOutputTokens * ModelTuning.reasoning.budgetRatio * multiplier)
    )
  )
}

/**
 * 路由层 ultra 档的数字预算；算不出安全值就返回 null，让这一轮退回只发 effort。
 *
 * 路由层的 `max_tokens` 是整轮输出的总额，`reasoning.max_tokens` 必须严格小于它（Anthropic 的硬约束，
 * 由路由原样透传）。低于 `budgetMin` 的数各家都会拒，所以钳不进 `[budgetMin, max_tokens)` 时宁可少发。
 */
function resolveOpenRouterUltraBudget(maxOutputTokens?: number): Nullable<number> {
  const budget = resolveReasoningBudget(maxOutputTokens, 'ultra')
  if (!hasUsableOutputBudget(maxOutputTokens)) return budget

  return budget < maxOutputTokens ? budget : null
}

/**
 * OpenRouter 与 Velar 路由层的 reasoning 参数：ultra 在力度之外再发 token 预算，其余只给力度。
 *
 * `maxOutputTokens` 是本次请求体里的 `max_tokens`，给了就按它换算 ultra 的预算，这样 ultra 在这一层与在
 * 内置适配器上走的是同一套换算（`resolveReasoningBudget`）。调用方已经写死的字段一律优先，不覆盖显式意图。
 */
export function mergeOpenRouterReasoning(
  existing: unknown,
  level: ReasoningLevel,
  maxOutputTokens?: number
): Record<string, unknown> {
  const base = isPlainObject(existing) ? existing : {}
  const effort = isString(base.effort) ? base.effort : resolveReasoningEffort(level)
  if (level !== 'ultra') return { ...base, effort }

  // ultra：高 effort 之外再抬高 token 预算，使其在支持 max_tokens 的 provider 上区别于 high。
  const budget = isNumber(base.max_tokens)
    ? base.max_tokens
    : resolveOpenRouterUltraBudget(maxOutputTokens)

  return isNumber(budget) ? { ...base, effort, max_tokens: budget } : { ...base, effort }
}

/**
 * 按 provider 与具体模型算出这一轮要附加的 reasoning providerOptions；不需要时返回 null。
 *
 * `level` 是用户在输入框选的思考力度；没给时按 `DefaultReasoningLevel`（medium）发。
 * `maxOutputTokens` 是本次调用的输出上限，只有逐轮包装层（`ReasoningLanguageModel`）拿得到；
 * 解析期先按缺省算一版，包装层每轮再用真实值重算，两处走的是同一套换算。
 *
 * **ultra 在哪几家能看出来**：Anthropic 非自适应与 Google 发的是数字预算，ultra 严格高于 high；
 * OpenAI 与自适应 Claude 那一代只有 `effort` 枚举（low/medium/high），没有数字预算可抬，ultra 与 high
 * 发出去的字节必然相同——这是 provider 能力所限，不为了"看起来有区别"硬造一个厂商不认的值。
 */
export function createReasoningProviderOptions(
  provider: ChatProviderId,
  model: string,
  level?: LooseOptional<ReasoningLevel>,
  maxOutputTokens?: number
): Nullable<Record<string, unknown>> {
  const effective = level ?? DefaultReasoningLevel

  switch (provider) {
    case 'openai':
      return matchesOpenAiReasoningModel(model)
        ? {
            openai: {
              reasoningEffort: resolveReasoningEffort(effective),
              reasoningSummary: 'auto',
            },
          }
        : null
    case 'anthropic':
      return matchesClaudeReasoningModel(model)
        ? {
            anthropic: createAnthropicThinkingOptions(model, effective, maxOutputTokens),
          }
        : null
    case 'google':
      return matchesGoogleReasoningModel(model)
        ? {
            google: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: resolveReasoningBudget(maxOutputTokens, effective),
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

/**
 * Claude 的思考参数：自适应思考那一代发 effort，其余发数字 budget。
 *
 * 数字那一支不另外钳 `maxOutputTokens`：`@ai-sdk/anthropic` 发出去的 `max_tokens` 是
 * 「本次输出上限 + budgetTokens」，`budget_tokens < max_tokens` 天然成立；它对已知模型会把
 * `max_tokens` 压回该模型的输出上限，而这里被 `matchesClaudeReasoningModel` 匹配到的模型里
 * 最小的那个也有 32 000，仍高于 `ultraCeil`。
 */
function createAnthropicThinkingOptions(
  model: string,
  level: ReasoningLevel,
  maxOutputTokens?: number
): Record<string, unknown> {
  if (matchesAdaptiveClaudeThinkingModel(model))
    return {
      sendReasoning: true,
      thinking: {
        type: 'adaptive',
        display: 'summarized',
      },
      effort: resolveReasoningEffort(level),
    }

  return {
    sendReasoning: true,
    thinking: {
      type: 'enabled',
      budgetTokens: resolveReasoningBudget(maxOutputTokens, level),
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

/**
 * 把这一轮的思考力度注进 Velar 路由的请求体（没给按 `DefaultReasoningLevel`）；注不进去就保留原请求，
 * 宁可这一轮不带 reasoning。
 */
export function injectVelarThinkingRouting(
  init: Parameters<typeof fetch>[1],
  reasoningLevel?: LooseOptional<ReasoningLevel>
): Parameters<typeof fetch>[1] {
  if (!isString(init?.body)) return init

  try {
    const body = JSON.parse(init.body)
    if (!isPlainObject(body)) return init

    return {
      ...init,
      body: JSON.stringify({
        ...body,
        reasoning: mergeOpenRouterReasoning(
          body.reasoning,
          reasoningLevel ?? DefaultReasoningLevel,
          // 请求体里的输出上限就是这一轮真实的 maxOutputTokens，拿它换算 ultra 的预算。
          optionalWhen(isNumber, body.max_tokens)
        ),
      }),
    }
  } catch (error) {
    // 注入失败一律保留原始请求体：宁可这一轮不带 reasoning，也不能让路由参数把请求打坏（§2.4）。
    Log.tag('VelarModelAdapter').debug('注入 Velar reasoning 路由失败，保留原始请求体', { error })
    return init
  }
}

/**
 * Chat Completions 流式分块里的思考增量；不是这种分块或这一块没有思考时返回空串。
 *
 * `@ai-sdk/openai` 的 chat 模型不解析思考字段，走 Chat Completions 的通道（兼容网关、DeepSeek、
 * OpenRouter、Velar）只能从原始分块里取：DeepSeek 与多数兼容网关写 `reasoning_content`，OpenRouter
 * 写 `reasoning`。Responses、Anthropic、Google 的原始事件没有 `choices`，它们的思考由 SDK 解析成
 * 思考分片，不走这里。
 */
export function readChatCompletionReasoning(chunk: unknown): string {
  if (!isPlainObject(chunk) || !isArray(chunk.choices)) return ''
  const [choice] = chunk.choices
  const delta = isPlainObject(choice) ? choice.delta : undefined
  if (!isPlainObject(delta)) return ''
  const text = isString(delta.reasoning_content) ? delta.reasoning_content : delta.reasoning
  return isString(text) ? text : ''
}
