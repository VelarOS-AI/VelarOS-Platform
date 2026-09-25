/**
 * @test-meta
 * title: 五档思考力度的请求字节
 * summary: 模型运行时 · 按数字预算发的型号五档逐档递增；发 effort 的型号按型号退到它支持的最高档。
 * area: package
 */
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'

import type { ReasoningLevel } from '../src/contracts'
import { languageModelWrappers } from '../src/impl/adapters/LanguageModelWrappers'
import { ReasoningFallback } from '../src/impl/adapters/ReasoningFallback'
import {
  createReasoningProviderOptions,
  fitReasoningLevel,
  mergeOpenRouterReasoning,
} from '../src/utils/wire/reasoning'

/** 非自适应思考的 Claude：走 `thinking.budgetTokens`，是数字预算。 */
const AnthropicBudgetModelId = 'claude-sonnet-4-5'
/** 自适应思考那一代的 Claude：只有 effort 枚举，没有数字预算。 */
const AnthropicAdaptiveModelId = 'claude-sonnet-4-6'
const OpenAiModelId = 'gpt-5.5'
const GoogleModelId = 'gemini-2.5-pro'

const ChatCallOptions: LanguageModelV3CallOptions = {
  prompt: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
}

/** 取 Anthropic 这一轮发出去的 `thinking.budgetTokens`。 */
function anthropicBudget(level: ReasoningLevel, maxOutputTokens?: number): unknown {
  const options = createReasoningProviderOptions(
    'anthropic',
    AnthropicBudgetModelId,
    level,
    maxOutputTokens
  ) as { anthropic: { thinking: { budgetTokens: number } } }

  return options.anthropic.thinking.budgetTokens
}

/** 取 Google 这一轮发出去的 `thinkingConfig.thinkingBudget`。 */
function googleBudget(level: ReasoningLevel, maxOutputTokens?: number): unknown {
  const options = createReasoningProviderOptions(
    'google',
    GoogleModelId,
    level,
    maxOutputTokens
  ) as { google: { thinkingConfig: { thinkingBudget: number } } }

  return options.google.thinkingConfig.thinkingBudget
}

/** 只记录调用参数的语言模型替身：用来看清楚包装层最终合并出什么 providerOptions。 */
function createRecordingLanguageModel(): {
  model: LanguageModelV3
  calls: Array<LanguageModelV3CallOptions['providerOptions']>
} {
  const calls: Array<LanguageModelV3CallOptions['providerOptions']> = []
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'test',
    supportedUrls: {},
    doGenerate: (options) => {
      calls.push(options.providerOptions)
      return Promise.resolve({
        content: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      } as unknown as LanguageModelV3GenerateResult)
    },
    doStream: () => {
      throw new Error('未使用')
    },
  }

  return { model, calls }
}

describe('五档思考力度', () => {
  test('数字预算：五档逐档递增，拿不到输出上限时走各档常量', () => {
    const levels: ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(levels.map((level) => anthropicBudget(level))).toEqual([
      2048, 4096, 8192, 16_000, 24_000,
    ])
    expect(levels.map((level) => googleBudget(level))).toEqual([2048, 4096, 8192, 16_000, 24_000])
  })

  test('拿得到本次输出上限时按比例换算，并且始终严格小于输出上限', () => {
    expect(anthropicBudget('high', 24_000)).toBe(12_000)
    expect(anthropicBudget('xhigh', 24_000)).toBe(14_400)
    expect(anthropicBudget('max', 24_000)).toBe(18_000)
    expect(googleBudget('xhigh', 24_000)).toBe(14_400)

    // 输出上限很小的时候也不会发出一个 ≥ 上限的预算（Anthropic 的 budget_tokens < max_tokens）。
    expect(anthropicBudget('max', 4096) as number).toBeLessThan(4096)
    expect(anthropicBudget('xhigh', 4096)).toBe(2457)
    expect(anthropicBudget('xhigh', 4096)).toBeGreaterThan(anthropicBudget('high', 4096) as number)
  })

  test('发 effort 的型号：选的档超过它支持的最高档就退到那一档，永远不往上', () => {
    expect(fitReasoningLevel('max', 'gpt-5.5')).toBe('xhigh')
    expect(fitReasoningLevel('xhigh', 'openai/gpt-5.5')).toBe('xhigh')
    expect(fitReasoningLevel('xhigh', 'gpt-5.1-codex-max')).toBe('xhigh')
    expect(fitReasoningLevel('max', 'claude-opus-5-5')).toBe('max')
    // 没登记的推理型号按 high 封顶，低于封顶的档原样发。
    expect(fitReasoningLevel('xhigh', 'gpt-5.1-codex-mini')).toBe('high')
    expect(fitReasoningLevel('max', 'o4-mini')).toBe('high')
    expect(fitReasoningLevel('max', 'velaros/auto')).toBe('high')
    expect(fitReasoningLevel('low', 'gpt-5.5')).toBe('low')

    expect(createReasoningProviderOptions('openai', OpenAiModelId, 'max')).toEqual({
      openai: { reasoningEffort: 'xhigh', reasoningSummary: 'auto' },
    })
    // 自适应思考的 Claude（4.6、4.7、5 系）发 effort，放到 max；型号不认时由退档重发兜底。
    expect(createReasoningProviderOptions('anthropic', AnthropicAdaptiveModelId, 'max')).toEqual({
      anthropic: {
        sendReasoning: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      },
    })
    expect(createReasoningProviderOptions('anthropic', 'claude-opus-5-5', 'max')).toEqual({
      anthropic: {
        sendReasoning: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'max',
      },
    })
  })

  test('包装层用本轮真实的 maxOutputTokens 重算预算', async () => {
    const { model, calls } = createRecordingLanguageModel()
    const wrapped = languageModelWrappers.withReasoning(
      model,
      'anthropic',
      AnthropicBudgetModelId,
      'xhigh',
      new ReasoningFallback()
    )

    await (wrapped as LanguageModelV3).doGenerate(ChatCallOptions)
    await (wrapped as LanguageModelV3).doGenerate({ ...ChatCallOptions, maxOutputTokens: 24_000 })

    expect(calls).toEqual([
      {
        anthropic: {
          sendReasoning: true,
          thinking: { type: 'enabled', budgetTokens: 16_000 },
        },
      },
      {
        anthropic: {
          sendReasoning: true,
          thinking: { type: 'enabled', budgetTokens: 14_400 },
        },
      },
    ])
  })

  test('型号不认这一档时往下退档重发，同一个型号之后直接从能用的那一档发', async () => {
    const efforts: unknown[] = []
    const model: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async (options) => {
        const effort = (options.providerOptions?.anthropic as { effort?: string } | undefined)
          ?.effort
        efforts.push(effort)
        if (effort === 'max' || effort === 'xhigh')
          throw new APICallError({
            message: `effort: '${effort}' is not supported by this model`,
            url: 'https://api.anthropic.test/v1/messages',
            requestBodyValues: {},
            statusCode: 400,
          })
        return {
          content: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        } as unknown as LanguageModelV3GenerateResult
      },
      doStream: () => {
        throw new Error('未使用')
      },
    }
    const wrapped = languageModelWrappers.withReasoning(
      model,
      'anthropic',
      AnthropicAdaptiveModelId,
      'max',
      new ReasoningFallback()
    ) as LanguageModelV3

    await wrapped.doGenerate(ChatCallOptions)
    await wrapped.doGenerate(ChatCallOptions)
    expect(efforts).toEqual(['max', 'xhigh', 'high', 'high'])
  })

  test('路由层只发 effort，按型号退档；调用方写死的字段原样保留', () => {
    expect(mergeOpenRouterReasoning({}, 'max', 'openai/gpt-5.5')).toEqual({ effort: 'xhigh' })
    expect(mergeOpenRouterReasoning({}, 'xhigh', 'openrouter/auto')).toEqual({ effort: 'high' })
    expect(mergeOpenRouterReasoning({}, 'medium', 'anthropic/claude-sonnet-4.6')).toEqual({
      effort: 'medium',
    })
    expect(mergeOpenRouterReasoning({ max_tokens: 4096 }, 'max', 'openai/gpt-5.5')).toEqual({
      max_tokens: 4096,
    })
    expect(mergeOpenRouterReasoning({ effort: 'low' }, 'max', 'openai/gpt-5.5')).toEqual({
      effort: 'low',
    })
  })
})
