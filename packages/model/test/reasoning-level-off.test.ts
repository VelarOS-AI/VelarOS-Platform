/**
 * @test-meta
 * title: reasoningLevel=off 的请求字节
 * summary: 模型运行时 · 用户选"关思考"时各家 provider 发出去的推理参数。
 * area: package
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from '@ai-sdk/provider'
import { describe, expect, test } from 'bun:test'

import { languageModelWrappers } from '../src/impl/adapters/LanguageModelWrappers'
import type { ChatProviderId } from '../src/index'
import { createModelRuntimeComposition } from '../src/index'
import { createThinkingDepthProviderOptions } from '../src/utils/wire/reasoning'

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

describe('reasoningLevel=off', () => {
  test('Anthropic 发厂商的关闭写法，而不是自适应思考', () => {
    expect(
      createThinkingDepthProviderOptions('anthropic', AnthropicModelId, 'balanced', 'off')
    ).toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    // 非推理模型仍然什么都不发。
    expect(
      createThinkingDepthProviderOptions('anthropic', 'claude-3-5-haiku', 'balanced', 'off')
    ).toBeNull()
  })

  test('OpenAI 与 Google 一个推理参数都不发', () => {
    expect(
      createThinkingDepthProviderOptions('openai', OpenAiModelId, 'balanced', 'off')
    ).toBeNull()
    expect(createThinkingDepthProviderOptions('google', GoogleModelId, 'deep', 'off')).toBeNull()
  })

  test('缺 thinkingDepth 时 off 一样生效，其它档仍按 thinkingDepth 走', () => {
    expect(
      createThinkingDepthProviderOptions('anthropic', AnthropicModelId, undefined, 'off')
    ).toEqual({ anthropic: { thinking: { type: 'disabled' } } })
    // 只有 off 与 thinkingDepth 无关：没有 thinkingDepth 的其它档仍然什么都不发。
    expect(
      createThinkingDepthProviderOptions('anthropic', AnthropicModelId, undefined, 'ultra')
    ).toBeNull()
    // 有 thinkingDepth 时 level 是用户的显式选择，力度按 level 走而不是按 depth 走。
    expect(
      createThinkingDepthProviderOptions('anthropic', AnthropicModelId, 'balanced', 'ultra')
    ).toEqual({
      anthropic: {
        sendReasoning: true,
        thinking: { type: 'adaptive', display: 'summarized' },
        effort: 'high',
      },
    })
  })

  test('适配器包装层把关闭写法合进本次调用', async () => {
    const { model, calls } = createRecordingLanguageModel()
    const wrapped = languageModelWrappers.withThinkingDepth(
      model,
      'anthropic',
      AnthropicModelId,
      'deep',
      'off'
    )
    await (wrapped as LanguageModelV3).doGenerate(ChatCallOptions)

    expect(calls).toEqual([{ anthropic: { thinking: { type: 'disabled' } } }])
  })

  test('解析链路上 off 不再带出推理参数', async () => {
    expect(await resolveProviderOptions('anthropic', AnthropicModelId, 'off')).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    })
    expect(await resolveProviderOptions('openai', OpenAiModelId, 'off')).toBeUndefined()
    expect(await resolveProviderOptions('google', GoogleModelId, 'off')).toBeUndefined()
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

  test('OpenRouter 发路由层的关闭开关，其它档仍发 effort', async () => {
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
      const off = composition.agentModelRuntime.createAgentProvider({
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseURL: '',
        reasoningLevel: 'off',
      })
      await off(OpenRouterModelId).doGenerate(ChatCallOptions)

      const deep = composition.agentModelRuntime.createAgentProvider({
        provider: 'openrouter',
        apiKey: 'sk-test',
        baseURL: '',
        thinkingDepth: 'deep',
      })
      await deep(OpenRouterModelId).doGenerate(ChatCallOptions)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(bodies.map((body) => body.reasoning)).toEqual([
      { enabled: false, exclude: true },
      { effort: 'high' },
    ])
  })
})
