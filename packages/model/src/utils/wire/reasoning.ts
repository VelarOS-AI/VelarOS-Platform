import { APICallError } from '@ai-sdk/provider'

import { isArray, isFiniteNumber, isNumber, isPlainObject, isString, Log } from '@velaros-ai/core'

import { DefaultReasoningLevel, ReasoningLevels } from '../../contract/constants'
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

/**
 * 各型号支持的最高思考力度，先匹配先得，型号名可以带路由前缀（`openai/gpt-5.5`）。
 *
 * 没登记的推理型号按 high：OpenAI、Anthropic、OpenRouter 的推理型号都认 low / medium / high。依据各家官方
 * 文档（2026-09-25 核对）；自适应思考的 Claude 各型号支持的档不一，统一放到 max，真被拒了由调用处往下退档
 * 重发（见 `isReasoningRejection`）。按数字预算发的型号（Claude 4.5 及更早、Gemini）五档都换成预算，不查
 * 这张表。
 */
const ReasoningCeilings: ReadonlyArray<{
  readonly model: RegExp
  readonly ceiling: ReasoningLevel
}> = [
  { model: /(?:^|\/)gpt-5\.[245](?:-\d{4}-\d{2}-\d{2})?$/i, ceiling: 'xhigh' },
  { model: /(?:^|\/)gpt-5\.1-codex-max(?:$|-)/i, ceiling: 'xhigh' },
  { model: /claude-(?:opus|sonnet|haiku)-(?:4[.-][67]|5)(?:$|\D)/i, ceiling: 'max' },
]

/** 思考参数被拒时报错里会提到的字样。 */
const ReasoningRejectionPattern = /reason|effort|think|budget/i

/** SDK 抛的调用错误是不是因为思考参数被拒：400 / 422，且报错提到思考相关的字段。 */
export function isReasoningRejection(error: unknown): boolean {
  return (
    APICallError.isInstance(error) &&
    [400, 422].includes(error.statusCode ?? 0) &&
    ReasoningRejectionPattern.test(`${error.message} ${error.responseBody ?? ''}`)
  )
}

/** 原始响应是不是因为思考参数被拒；读的是响应副本，原响应照常交给调用方。 */
export async function isReasoningRejected(response: Response): Promise<boolean> {
  if (![400, 422].includes(response.status)) return false
  try {
    return ReasoningRejectionPattern.test(await response.clone().text())
  } catch (error) {
    Log.tag('AiSdkModelDriver').debug('读取被拒响应正文失败，按不是思考参数被拒处理', { error })
    return false
  }
}

/** 选的档超过这个型号支持的最高档时退到那一档，永远不往上。 */
export function fitReasoningLevel(level: ReasoningLevel, model: string): ReasoningLevel {
  const ceiling = ReasoningCeilings.find((entry) => entry.model.test(model))?.ceiling ?? 'high'
  return ReasoningLevels.indexOf(level) > ReasoningLevels.indexOf(ceiling) ? ceiling : level
}

/**
 * 按数字预算发的型号这一档的 thinking budget：拿不到本次输出上限时用这一档的常量，拿得到就按比例换算，
 * 再钳到这一档的上限与 `budgetMin` 之间。
 *
 * 各档的比例与上限逐档递增，高一档的预算不会比低一档少。比例都小于 1，预算严格小于输出上限（Anthropic
 * `budget_tokens < max_tokens` 的硬约束）；最高一档的上限 24 000 低于两家的 thinking budget 合法上限
 * （Gemini 2.5 Flash 24 576 / Pro 32 768，Claude 一系被匹配到的最小输出上限 32 000）。
 */
export function resolveReasoningBudget(
  maxOutputTokens: Optional<number>,
  level: ReasoningLevel
): number {
  const budget = ModelTuning.reasoning.budgets[level]
  if (!hasUsableOutputBudget(maxOutputTokens)) return budget.fallback

  return Math.max(
    ModelTuning.reasoning.budgetMin,
    Math.min(budget.cap, Math.floor(maxOutputTokens * budget.ratio))
  )
}

/**
 * OpenRouter 与 Velar 路由层的 reasoning 参数：只发 effort（OpenRouter 的 effort 与 max_tokens 只能二选一），
 * 按型号退到它支持的最高档。调用方已经写了 effort 或 max_tokens 的，一律原样保留，不覆盖显式意图。
 */
export function mergeOpenRouterReasoning(
  existing: unknown,
  level: ReasoningLevel,
  model: string
): Record<string, unknown> {
  const base = isPlainObject(existing) ? existing : {}
  if (isString(base.effort) || isNumber(base.max_tokens)) return base

  return { ...base, effort: fitReasoningLevel(level, model) }
}

/**
 * 按 provider 与具体模型算出这一轮要附加的 reasoning providerOptions；不需要时返回 null。
 *
 * `level` 是用户在输入框选的思考力度；没给时按 `DefaultReasoningLevel`（medium）发。OpenAI 与自适应思考
 * 的 Claude 发 effort，按型号退到它支持的最高档；Anthropic 非自适应与 Google 发数字预算，五档各不相同。
 * `maxOutputTokens` 是本次调用的输出上限，只有逐轮包装层（`ReasoningLanguageModel`）拿得到；
 * 解析期先按缺省算一版，包装层每轮再用真实值重算，两处走的是同一套换算。
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
              reasoningEffort: fitReasoningLevel(effective, model),
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
 * 最小的那个也有 32 000，仍高于最高一档的预算上限。
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
      effort: fitReasoningLevel(level, model),
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
    /claude-(?:opus|sonnet|haiku)-(?:latest|[45](?:[.-]\d+)?)/i,
    /claude-(?:4(?:[.-]\d+)?)-(?:opus|sonnet|haiku)/i,
    /claude-(?:3[.-]7-sonnet|sonnet-3[.-]7)/i,
  ].some((matcher) => matcher.test(model))
}

/** 这个模型名看起来是不是自适应思考那一代的 Claude（4.6、4.7 与 5 系）。 */
function matchesAdaptiveClaudeThinkingModel(model: string): boolean {
  return [
    /claude-(?:opus|sonnet|haiku)-5(?:$|[.-])/i,
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
          isString(body.model) ? body.model : ''
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
