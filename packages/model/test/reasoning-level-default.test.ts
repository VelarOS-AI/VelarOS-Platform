/**
 * @test-meta
 * title: 思考力度的默认档与各家请求字节
 * summary: 模型运行时 · 宿主不给思考力度时按 medium 发，给了就按力度发；解析链路与包装层同一口径。
 * area: package
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'

import { languageModelWrappers } from '../src/impl/adapters/LanguageModelWrappers'
import { ReasoningFallback } from '../src/impl/adapters/ReasoningFallback'
import type { ChatProviderId } from '../src/index'
import { createModelRuntimeComposition } from '../src/index'
import { createReasoningProviderOptions } from '../src/utils/wire/reasoning'

const AnthropicModelId = 'claude-sonnet-4-6'
const OpenAiModelId = 'gpt-5.5'
const GoogleModelId = 'gemini-2.5-pro'
const OpenRouterModelId = 'anthropic/claude-sonnet-4.6'

const RuntimeContext = {
  providerRuntimeConfigs: [
    {
      provider: 'anthropic',
      enabled: true,
      apiKey: 'sk-test',
      baseURL: '',
      defaultModel: AnthropicModelId,
    },
    {
      provider: 'openai',
      enabled: true,
      apiKey: 'sk-test',
      baseURL: '',
      defaultModel: OpenAiModelId,
    },
    {
      provider: 'google',
      enabled: true,
      apiKey: 'sk-test',
      baseURL: '',
      defaultModel: GoogleModelId,
    },
  ],
  openRouter: { useFreeModelsForDebug: false },
}

const ChatCallOptions: LanguageModelV3CallOptions = {
  prompt: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  ],
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

async function resolveProviderOptions(
  provider: ChatProviderId,
  model: string,
  reasoningLevel?: string
): Promise<unknown> {
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const resolved = await composition.agentModelRuntime.resolveRoleRuntime(
    { provider, model, apiKey: 'sk-test', baseURL: '', reasoningLevel },
    RuntimeContext
  )

  return resolved.modelRequestOptions?.providerOptions
}

describe('思考力度的默认档', () => {
  test('没给力度时按 medium 发，与输入框的默认档一致', () => {
    expect(createReasoningProviderOptions('openai', OpenAiModelId)).toEqual({
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    })
    expect(createReasoningProviderOptions('anthropic', AnthropicModelId)).toEqual(
      createReasoningProviderOptions('anthropic', AnthropicModelId, 'medium')
    )
    expect(createReasoningProviderOptions('google', GoogleModelId)).toEqual(
      createReasoningProviderOptions('google', GoogleModelId, 'medium')
    )
    // 非推理模型一个参数都不发。
    expect(createReasoningProviderOptions('anthropic', 'claude-3-5-haiku')).toBeNull()
  })

  test('适配器包装层把这一档的参数合进本次调用', async () => {
    const { model, calls } = createRecordingLanguageModel()
    const wrapped = languageModelWrappers.withReasoning(
      model,
      'anthropic',
      AnthropicModelId,
      'low',
      new ReasoningFallback()
    )
    await (wrapped as LanguageModelV3).doGenerate(ChatCallOptions)

    expect(calls).toEqual([
      {
        anthropic: {
          sendReasoning: true,
          thinking: { type: 'adaptive', display: 'summarized' },
          effort: 'low',
        },
      },
    ])
  })

  test('不选档位时的默认请求字节没变', async () => {
    expect(await resolveProviderOptions('anthropic', AnthropicModelId)).toEqual({
      anthropic: {
        sendReasoning: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'medium',
      },
    })
    expect(await resolveProviderOptions('openai', OpenAiModelId)).toEqual({
      openai: { reasoningEffort: 'medium', reasoningSummary: 'auto' },
    })
  })

  test('OpenRouter 没给力度按 medium，给了按力度发 effort', async () => {
    const composition = createModelRuntimeComposition({
      environment: {},
      providerScripts: { configPaths: [] },
    })
    const bodies: Array<Record<string, unknown>> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init: { body?: unknown }) => {
      void input
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: OpenRouterModelId,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    try {
      const unset = composition.agentModelRuntime.createAgentProvider({
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseURL: '',
      })
      await unset(OpenRouterModelId).doGenerate(ChatCallOptions)

      const high = composition.agentModelRuntime.createAgentProvider({
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseURL: '',
        reasoningLevel: 'high',
      })
      await high(OpenRouterModelId).doGenerate(ChatCallOptions)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(bodies.map((body) => body.reasoning)).toEqual([{ effort: 'medium' }, { effort: 'high' }])
  })
})
