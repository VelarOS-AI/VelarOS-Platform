import { isNumber } from '@velaros-ai/core'

import { OpenRouterAutoModelId, OpenRouterFreeModelId, VelarAutoModelId } from '../../contract/constants.js'
import type { ChatProviderId } from '../../types/model'
import type { ProviderModelDefinition, SharedProviderCatalog } from '../../types/providers'

/** OpenRouter 精选目录：这是规则数据，改名单和改规则一起审。 */
const OpenRouterCompatibleModelCatalog: ProviderModelDefinition[] = [
  { id: OpenRouterAutoModelId, contextWindow: 2_000_000 },
  { id: OpenRouterFreeModelId, contextWindow: 200_000 },
  { id: '~anthropic/claude-sonnet-latest', contextWindow: 1_000_000 },
  { id: '~anthropic/claude-opus-latest', contextWindow: 1_000_000 },
  { id: '~anthropic/claude-haiku-latest', contextWindow: 200_000 },
  { id: 'anthropic/claude-opus-4.7', contextWindow: 1_000_000 },
  { id: 'anthropic/claude-opus-4.6', contextWindow: 1_000_000 },
  { id: 'anthropic/claude-opus-4.6-fast', contextWindow: 1_000_000 },
  { id: 'anthropic/claude-sonnet-4.6', contextWindow: 1_000_000 },
  { id: 'anthropic/claude-opus-4.5', contextWindow: 200_000 },
  { id: 'anthropic/claude-sonnet-4.5', contextWindow: 200_000 },
  { id: '~openai/gpt-latest', contextWindow: 1_050_000 },
  { id: '~openai/gpt-mini-latest', contextWindow: 400_000 },
  { id: 'openai/gpt-5.5-pro', contextWindow: 1_050_000 },
  { id: 'openai/gpt-5.5', contextWindow: 1_050_000 },
  { id: 'openai/gpt-5.4-pro', contextWindow: 1_050_000 },
  { id: 'openai/gpt-5.4', contextWindow: 1_050_000 },
  { id: 'openai/gpt-5.4-mini', contextWindow: 400_000 },
  { id: 'openai/gpt-5.3-codex', contextWindow: 400_000 },
  { id: 'openai/gpt-5.3-chat', contextWindow: 128_000 },
  { id: 'openai/o3-pro', contextWindow: 200_000 },
  { id: 'openai/o3', contextWindow: 200_000 },
  { id: 'openai/o4-mini-high', contextWindow: 200_000 },
  { id: '~google/gemini-pro-latest', contextWindow: 1_048_576 },
  { id: '~google/gemini-flash-latest', contextWindow: 1_048_576 },
  { id: 'google/gemini-3.1-pro-preview', contextWindow: 1_048_576 },
  { id: 'google/gemini-3.1-pro-preview-customtools', contextWindow: 1_048_576 },
  { id: 'google/gemini-3.1-flash-lite-preview', contextWindow: 1_048_576 },
  { id: 'google/gemini-3-flash-preview', contextWindow: 1_048_576 },
  { id: 'google/gemini-2.5-pro', contextWindow: 1_048_576 },
  { id: 'google/gemini-2.5-flash', contextWindow: 1_048_576 },
  { id: 'deepseek/deepseek-v4-pro', contextWindow: 1_048_576 },
  { id: 'deepseek/deepseek-v4-flash', contextWindow: 1_048_576 },
  { id: 'deepseek/deepseek-v3.2-speciale', contextWindow: 163_840 },
  { id: 'deepseek/deepseek-v3.2', contextWindow: 131_072 },
  { id: 'deepseek/deepseek-r1-0528', contextWindow: 163_840 },
  { id: 'deepseek/deepseek-r1', contextWindow: 64_000 },
  { id: 'x-ai/grok-4.20-multi-agent', contextWindow: 2_000_000 },
  { id: 'x-ai/grok-4.20', contextWindow: 2_000_000 },
  { id: 'x-ai/grok-4.1-fast', contextWindow: 2_000_000 },
  { id: 'x-ai/grok-code-fast-1', contextWindow: 256_000 },
  { id: 'x-ai/grok-4', contextWindow: 256_000 },
  { id: 'qwen/qwen3.6-max-preview', contextWindow: 262_144 },
  { id: 'qwen/qwen3.6-plus', contextWindow: 1_000_000 },
  { id: 'qwen/qwen3.5-plus-20260420', contextWindow: 1_000_000 },
  { id: 'qwen/qwen3-max-thinking', contextWindow: 262_144 },
  { id: 'qwen/qwen3-coder-next', contextWindow: 262_144 },
  { id: 'qwen/qwen3.6-flash', contextWindow: 1_000_000 },
  { id: '~moonshotai/kimi-latest', contextWindow: 256_000 },
  { id: 'moonshotai/kimi-k2.6', contextWindow: 256_000 },
  { id: 'moonshotai/kimi-k2.5', contextWindow: 262_144 },
  { id: 'moonshotai/kimi-k2-thinking', contextWindow: 262_144 },
  { id: 'z-ai/glm-5.1', contextWindow: 202_752 },
  { id: 'z-ai/glm-5-turbo', contextWindow: 202_752 },
  { id: 'z-ai/glm-5', contextWindow: 202_752 },
  { id: 'z-ai/glm-4.6', contextWindow: 204_800 },
  { id: 'mistralai/mistral-large-2512', contextWindow: 262_144 },
  { id: 'mistralai/mistral-medium-3.1', contextWindow: 131_072 },
  { id: 'mistralai/codestral-2508', contextWindow: 256_000 },
  { id: 'mistralai/devstral-2512', contextWindow: 262_144 },
  { id: 'mistralai/mistral-small-2603', contextWindow: 262_144 },
  { id: 'meta-llama/llama-4-maverick', contextWindow: 1_048_576 },
  { id: 'meta-llama/llama-4-scout', contextWindow: 327_680 },
  { id: 'meta-llama/llama-3.3-70b-instruct', contextWindow: 131_072 },
  { id: 'minimax/minimax-m2.7', contextWindow: 196_608 },
  { id: 'minimax/minimax-m2.5', contextWindow: 196_608 },
  { id: 'minimax/minimax-m1', contextWindow: 1_000_000 },
  { id: 'perplexity/sonar-pro-search', contextWindow: 200_000 },
  { id: 'perplexity/sonar-reasoning-pro', contextWindow: 128_000 },
  { id: 'perplexity/sonar-deep-research', contextWindow: 128_000 },
  { id: 'amazon/nova-premier-v1', contextWindow: 1_000_000 },
  { id: 'amazon/nova-pro-v1', contextWindow: 300_000 },
  { id: 'amazon/nova-2-lite-v1', contextWindow: 1_000_000 },
  { id: 'cohere/command-a', contextWindow: 256_000 },
  { id: 'ai21/jamba-large-1.7', contextWindow: 256_000 },
]

const VelarSharedProviderCatalog = {
  provider: 'velar',
  defaultModel: VelarAutoModelId,
  models: [
    { id: VelarAutoModelId, contextWindow: 200_000 },
    { id: 'velar/embedding', contextWindow: 8_192 },
  ],
} satisfies SharedProviderCatalog

/**
 * Velar Dev 的目录由 Cloud 按账号授权动态下发。
 *
 * Platform 只把 Cloud 公共模型 ID 当作不透明字符串传递，不能在本地维护一份会漂移的
 * 静态目录，也不能在目录不可用时回退到 Velar 或 OpenRouter。
 */
const VelarDevSharedProviderCatalog = {
  provider: 'velar-dev',
  defaultModel: '',
  models: [],
} satisfies SharedProviderCatalog

const CustomProviderCatalog = {
  provider: 'custom',
  defaultModel: '',
  models: [],
} satisfies SharedProviderCatalog

const DeepSeekProviderCatalog = {
  provider: 'deepseek',
  defaultModel: 'deepseek-v4-flash',
  models: [
    { id: 'deepseek-v4-flash', contextWindow: 1_048_576 },
    { id: 'deepseek-v4-pro', contextWindow: 1_048_576 },
    { id: 'deepseek-chat', contextWindow: 1_048_576 },
    { id: 'deepseek-reasoner', contextWindow: 1_048_576 },
  ],
} satisfies SharedProviderCatalog

const AnthropicProviderCatalog = {
  provider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  models: [
    { id: 'claude-sonnet-4-6', contextWindow: 1_000_000 },
    { id: 'claude-opus-4-7', contextWindow: 1_000_000 },
    { id: 'claude-opus-4-6', contextWindow: 1_000_000 },
    { id: 'claude-opus-4-5', contextWindow: 200_000 },
    { id: 'claude-sonnet-4-5', contextWindow: 200_000 },
    { id: 'claude-haiku-4-5', contextWindow: 200_000 },
  ],
} satisfies SharedProviderCatalog

const GoogleProviderCatalog = {
  provider: 'google',
  defaultModel: 'gemini-3.1-pro-preview',
  models: [
    { id: 'gemini-3.1-pro-preview', contextWindow: 1_048_576 },
    { id: 'gemini-3.1-pro-preview-customtools', contextWindow: 1_048_576 },
    { id: 'gemini-3.1-flash-lite-preview', contextWindow: 1_048_576 },
    { id: 'gemini-3-flash-preview', contextWindow: 1_048_576 },
    { id: 'gemini-2.5-pro', contextWindow: 1_048_576 },
    { id: 'gemini-2.5-flash', contextWindow: 1_048_576 },
    { id: 'gemini-pro-latest', contextWindow: 1_048_576 },
    { id: 'gemini-flash-latest', contextWindow: 1_048_576 },
    { id: 'gemini-flash-lite-latest', contextWindow: 1_048_576 },
  ],
} satisfies SharedProviderCatalog

const XaiProviderCatalog = {
  provider: 'xai',
  defaultModel: 'grok-4.20',
  models: [
    { id: 'grok-4.20', contextWindow: 2_000_000 },
    { id: 'grok-4.20-reasoning', contextWindow: 2_000_000 },
    { id: 'grok-4.20-multi-agent', contextWindow: 2_000_000 },
    { id: 'grok-4.1-fast', contextWindow: 2_000_000 },
    { id: 'grok-code-fast-1', contextWindow: 256_000 },
    { id: 'grok-4', contextWindow: 256_000 },
  ],
} satisfies SharedProviderCatalog

const QwenProviderCatalog = {
  provider: 'qwen',
  defaultModel: 'qwen3.6-plus',
  models: [
    { id: 'qwen3.6-plus', contextWindow: 1_000_000 },
    { id: 'qwen3.6-max-preview', contextWindow: 262_144 },
    { id: 'qwen3.5-plus-20260420', contextWindow: 1_000_000 },
    { id: 'qwen3-max-thinking', contextWindow: 262_144 },
    { id: 'qwen3-coder-next', contextWindow: 262_144 },
    { id: 'qwen3.6-flash', contextWindow: 1_000_000 },
  ],
} satisfies SharedProviderCatalog

const MoonshotProviderCatalog = {
  provider: 'moonshot',
  defaultModel: 'kimi-k2.6',
  models: [
    { id: 'kimi-k2.6', contextWindow: 256_000 },
    { id: 'kimi-k2.5', contextWindow: 262_144 },
    { id: 'kimi-k2-thinking', contextWindow: 262_144 },
    { id: 'kimi-latest', contextWindow: 256_000 },
  ],
} satisfies SharedProviderCatalog

const ZhipuProviderCatalog = {
  provider: 'zhipu',
  defaultModel: 'glm-5.1',
  models: [
    { id: 'glm-5.1', contextWindow: 202_752 },
    { id: 'glm-5-turbo', contextWindow: 202_752 },
    { id: 'glm-5', contextWindow: 202_752 },
    { id: 'glm-4.6', contextWindow: 204_800 },
  ],
} satisfies SharedProviderCatalog

const MistralProviderCatalog = {
  provider: 'mistral',
  defaultModel: 'mistral-medium-3.1',
  models: [
    { id: 'mistral-large-2512', contextWindow: 262_144 },
    { id: 'mistral-medium-3.1', contextWindow: 131_072 },
    { id: 'mistral-medium-latest', contextWindow: 131_072 },
    { id: 'codestral-2508', contextWindow: 256_000 },
    { id: 'devstral-2512', contextWindow: 262_144 },
    { id: 'mistral-small-2603', contextWindow: 262_144 },
    { id: 'mistral-small-latest', contextWindow: 262_144 },
  ],
} satisfies SharedProviderCatalog

const MiniMaxProviderCatalog = {
  provider: 'minimax',
  defaultModel: 'MiniMax-M2.7',
  models: [
    { id: 'MiniMax-M2.7', contextWindow: 196_608 },
    { id: 'MiniMax-M2.7-highspeed', contextWindow: 196_608 },
    { id: 'MiniMax-M2.5', contextWindow: 196_608 },
    { id: 'MiniMax-M1', contextWindow: 1_000_000 },
  ],
} satisfies SharedProviderCatalog

const GroqProviderCatalog = {
  provider: 'groq',
  defaultModel: 'llama-3.3-70b-versatile',
  models: [
    { id: 'llama-3.3-70b-versatile', contextWindow: 131_072 },
    { id: 'openai/gpt-oss-120b', contextWindow: 131_072 },
    { id: 'openai/gpt-oss-20b', contextWindow: 131_072 },
    { id: 'deepseek-r1-distill-llama-70b', contextWindow: 131_072 },
    { id: 'qwen/qwen3-32b', contextWindow: 131_072 },
  ],
} satisfies SharedProviderCatalog

const VolcengineProviderCatalog = {
  provider: 'volcengine',
  defaultModel: 'doubao-seed-1-6',
  models: [
    { id: 'doubao-seed-1-6', contextWindow: 256_000 },
    { id: 'doubao-seed-1-6-thinking', contextWindow: 256_000 },
    { id: 'doubao-seed-1-6-flash', contextWindow: 256_000 },
    { id: 'doubao-seed-1-6-lite', contextWindow: 256_000 },
  ],
} satisfies SharedProviderCatalog

const OllamaProviderCatalog = {
  provider: 'ollama',
  defaultModel: 'gpt-oss:20b',
  models: [
    { id: 'gpt-oss:20b', contextWindow: 128_000 },
    { id: 'llama3.3:70b', contextWindow: 128_000 },
    { id: 'qwen3:32b', contextWindow: 128_000 },
    { id: 'deepseek-r1:32b', contextWindow: 128_000 },
    { id: 'gemma3:27b', contextWindow: 128_000 },
  ],
} satisfies SharedProviderCatalog

const LmStudioProviderCatalog = {
  provider: 'lmstudio',
  defaultModel: 'openai/gpt-oss-20b',
  models: [
    { id: 'openai/gpt-oss-20b', contextWindow: 128_000 },
    { id: 'openai/gpt-oss-120b', contextWindow: 128_000 },
    { id: 'qwen/qwen3-coder-30b', contextWindow: 128_000 },
    { id: 'qwen/qwen3-32b', contextWindow: 128_000 },
    { id: 'deepseek/deepseek-r1-0528-qwen3-8b', contextWindow: 128_000 },
  ],
} satisfies SharedProviderCatalog

const OpenAICompatibleGatewayProviderCatalog = {
  provider: 'openai-compatible-gateway',
  defaultModel: '',
  models: [],
} satisfies SharedProviderCatalog

const sharedProviderCatalogs = [
  {
    provider: 'openrouter',
    defaultModel: OpenRouterAutoModelId,
    models: OpenRouterCompatibleModelCatalog,
  },
  {
    provider: 'openai',
    defaultModel: 'gpt-5.5',
    models: [
      { id: 'gpt-5.5', contextWindow: 1_050_000 },
      { id: 'gpt-5.4', contextWindow: 1_050_000 },
      { id: 'gpt-5.2-codex', contextWindow: 400_000 },
      { id: 'gpt-5.1-codex-max', contextWindow: 400_000 },
      { id: 'gpt-5.4-mini', contextWindow: 400_000 },
      { id: 'gpt-5.3-codex', contextWindow: 400_000 },
      { id: 'gpt-5.3-codex-spark', contextWindow: 128_000 },
      { id: 'gpt-5.2', contextWindow: 400_000 },
      { id: 'gpt-5.1-codex-mini', contextWindow: 400_000 },
      { id: 'gpt-4o-mini', contextWindow: 128_000, openAiOnly: true },
      { id: 'openai/gpt-4o-mini', contextWindow: 128_000, openAiOnly: true },
    ],
  },
  AnthropicProviderCatalog,
  GoogleProviderCatalog,
  DeepSeekProviderCatalog,
  XaiProviderCatalog,
  QwenProviderCatalog,
  MoonshotProviderCatalog,
  ZhipuProviderCatalog,
  MistralProviderCatalog,
  MiniMaxProviderCatalog,
  GroqProviderCatalog,
  VolcengineProviderCatalog,
  OllamaProviderCatalog,
  LmStudioProviderCatalog,
  OpenAICompatibleGatewayProviderCatalog,
  CustomProviderCatalog,
  VelarSharedProviderCatalog,
  VelarDevSharedProviderCatalog,
] as const satisfies readonly SharedProviderCatalog[]

export const SharedProviderCatalogs: readonly SharedProviderCatalog[] = sharedProviderCatalogs.map(
  (catalog) => ({
    provider: catalog.provider,
    defaultModel: catalog.defaultModel,
    models: catalog.models.map((model) => ({ ...model })),
  })
)

const SharedProviderCatalogMap = new Map(
  SharedProviderCatalogs.map(
    (catalog) => [catalog.provider, catalog] satisfies [ChatProviderId, SharedProviderCatalog]
  )
)

/** 按 provider id 取静态目录；没有这个 provider 时返回 undefined。 */
export function findSharedProviderCatalogDefinition(
  providerId: string
): SharedProviderCatalog | undefined {
  return SharedProviderCatalogMap.get(providerId as SharedProviderCatalog['provider'])
}

/** 只在 OpenAI 直连下可选的模型 id；别的 provider 的可见目录里要滤掉它们。 */
export function listOpenAiOnlyModelIds(): string[] {
  return (
    SharedProviderCatalogMap.get('openai')
      ?.models.filter((model) => model.openAiOnly)
      .map((model) => model.id) ?? []
  )
}

/** 全部静态目录里声明过窗口的模型，摊平成「模型 id → 窗口」的条目。 */
export function listKnownModelContextWindowEntries(): Array<readonly [string, number]> {
  return SharedProviderCatalogs.flatMap((catalog) =>
    catalog.models
      .filter((model) => isNumber(model.contextWindow))
      .map((model) => [model.id, model.contextWindow!] as const)
  )
}

/** OpenRouter 精选目录里声明过窗口的模型；它与整表分开查，因为同名模型在两边窗口可能不同。 */
export function listOpenRouterCompatibleContextWindowEntries(): Array<readonly [string, number]> {
  return OpenRouterCompatibleModelCatalog.filter((model) => isNumber(model.contextWindow)).map(
    (model) => [model.id, model.contextWindow!] as const
  )
}
