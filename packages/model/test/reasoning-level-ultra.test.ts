/**
 * @test-meta
 * title: reasoningLevel=ultra 的请求字节
 * summary: 模型运行时 · 用户选"最强思考"时各家 provider 发出去的推理预算比 high 高一档。
 * area: package
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'

import { languageModelWrappers } from '../src/impl/adapters/LanguageModelWrappers'
import type { ThinkingDepth } from '../src/index'
import {
  createThinkingDepthProviderOptions,
  mergeOpenRouterReasoning,
} from '../src/utils/wire/reasoning'

/** 非自适应思考的 Claude：走 `thinking.budgetTokens`，是数字预算。 */
const AnthropicBudgetModelId = 'claude-sonnet-4-5'
/** 自适应思考那一代的 Claude：只有 effort 枚举，没有数字预算。 */
const AnthropicAdaptiveModelId = 'claude-sonnet-4-6'
const OpenAiModelId = 'gpt-5.5'
const GoogleModelId = 'gemini-2.5-pro'

const Depths: readonly ThinkingDepth[] = ['fast', 'balanced', 'deep']

const ChatCallOptions: LanguageModelV3CallOptions = {
  prompt: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
}

/** 取 Anthropic 这一轮发出去的 `thinking.budgetTokens`。 */
function anthropicBudget(depth: ThinkingDepth, level: string, maxOutputTokens?: number): unknown {
  const options = createThinkingDepthProviderOptions(
    'anthropic',
    AnthropicBudgetModelId,
    depth,
    level,
    maxOutputTokens
  ) as { anthropic: { thinking: { budgetTokens: number } } }

  return options.anthropic.thinking.budgetTokens
}

/** 取 Google 这一轮发出去的 `thinkingConfig.thinkingBudget`。 */
function googleBudget(depth: ThinkingDepth, level: string, maxOutputTokens?: number): unknown {
  const options = createThinkingDepthProviderOptions(
    'google',
    GoogleModelId,
    depth,
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

describe('reasoningLevel=ultra', () => {
  test('Anthropic 数字预算：同一个 depth 下 ultra 严格大于 high', () => {
    Depths.forEach((depth) => {
      expect(anthropicBudget(depth, 'ultra')).toBeGreaterThan(
        anthropicBudget(depth, 'high') as number
      )
    })
    // 拿不到本次输出上限时按 ultraFloor 走，与 depth 无关。
    expect(Depths.map((depth) => anthropicBudget(depth, 'ultra'))).toEqual([16_000, 16_000, 16_000])
    expect(Depths.map((depth) => anthropicBudget(depth, 'high'))).toEqual([8192, 8192, 8192])
  })

  test('Google 数字预算：同一个 depth 下 ultra 严格大于 high', () => {
    Depths.forEach((depth) => {
      expect(googleBudget(depth, 'ultra')).toBeGreaterThan(googleBudget(depth, 'high') as number)
    })
    expect(Depths.map((depth) => googleBudget(depth, 'ultra'))).toEqual([16_000, 16_000, 16_000])
    expect(Depths.map((depth) => googleBudget(depth, 'high'))).toEqual([8192, 8192, 8192])
  })

  test('拿得到本次输出上限时按比例换算，并且始终严格小于输出上限', () => {
    // 24 000 × ultraRatio = 14 400；high 走 deep 档比例上限 12 000。
    expect(anthropicBudget('balanced', 'ultra', 24_000)).toBe(14_400)
    expect(anthropicBudget('balanced', 'high', 24_000)).toBe(12_000)
    expect(googleBudget('balanced', 'ultra', 24_000)).toBe(14_400)

    // 输出上限很小的时候也不会发出一个 ≥ 上限的预算（Anthropic 的 budget_tokens < max_tokens）。
    expect(anthropicBudget('deep', 'ultra', 4096)).toBe(2457)
    expect(anthropicBudget('deep', 'ultra', 4096) as number).toBeLessThan(4096)
    expect(anthropicBudget('deep', 'ultra', 4096)).toBeGreaterThan(
      anthropicBudget('deep', 'high', 4096) as number
    )
  })

  test('只有 effort 枚举的两家：ultra 与 high 一样，是 provider 能力所限', () => {
    // 自适应思考那一代的 Claude 没有数字预算可抬。
    expect(
      createThinkingDepthProviderOptions('anthropic', AnthropicAdaptiveModelId, 'balanced', 'ultra')
    ).toEqual(
      createThinkingDepthProviderOptions('anthropic', AnthropicAdaptiveModelId, 'balanced', 'high')
    )
    // OpenAI 只有 reasoningEffort 三档。
    expect(
      createThinkingDepthProviderOptions('openai', OpenAiModelId, 'balanced', 'ultra')
    ).toEqual({ openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } })
    expect(createThinkingDepthProviderOptions('openai', OpenAiModelId, 'balanced', 'ultra')).toEqual(
      createThinkingDepthProviderOptions('openai', OpenAiModelId, 'balanced', 'high')
    )
  })

  test('包装层用本轮真实的 maxOutputTokens 重算预算', async () => {
    const { model, calls } = createRecordingLanguageModel()
    const wrapped = languageModelWrappers.withThinkingDepth(
      model,
      'anthropic',
      AnthropicBudgetModelId,
      'balanced',
      'ultra'
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

  test('路由层的 ultra 预算与内置适配器同一套换算，钳不住就退回只发 effort', () => {
    expect(mergeOpenRouterReasoning({}, 'deep', 'ultra')).toEqual({
      effort: 'high',
      max_tokens: 16_000,
    })
    expect(mergeOpenRouterReasoning({}, 'deep', 'ultra', 24_000)).toEqual({
      effort: 'high',
      max_tokens: 14_400,
    })
    // 本轮输出上限低到放不下合法预算时不发 max_tokens，退回与 high 相同的字节，而不是发一个会被拒的数。
    expect(mergeOpenRouterReasoning({}, 'deep', 'ultra', 1000)).toEqual({ effort: 'high' })
    // 调用方自己写死的值优先。
    expect(mergeOpenRouterReasoning({ max_tokens: 4096 }, 'deep', 'ultra', 24_000)).toEqual({
      effort: 'high',
      max_tokens: 4096,
    })
  })
})
