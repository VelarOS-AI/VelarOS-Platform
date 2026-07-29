import { first, isBlank, isEmpty, isNumber } from '@velaros-ai/core'

import type { ChatProviderId } from './ModelContracts'


import {
  DirectOpenAICompatibleProviderIds,
  OpenRouterCompatibleProviderIds,
} from './ProviderManifest'

export {
  DirectOpenAICompatibleProviderIds,
  OpenRouterCompatibleProviderIds,
} from './ProviderManifest'

export const OpenRouterAutoModelId = 'openrouter/auto'
export const OpenRouterFreeModelId = 'openrouter/free'
export const VelarAutoModelId = 'velar/auto'

export function isOpenRouterCompatibleProvider(providerId: ChatProviderId): boolean {
  return OpenRouterCompatibleProviderIds.includes(
    providerId as (typeof OpenRouterCompatibleProviderIds)[number]
  )
}

export function isDirectOpenAICompatibleProvider(providerId: ChatProviderId): boolean {
  return DirectOpenAICompatibleProviderIds.includes(
    providerId as (typeof DirectOpenAICompatibleProviderIds)[number]
  )
}

export const CustomModelProviderIds = [
  'velar',
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'deepseek',
  ...DirectOpenAICompatibleProviderIds,
  'custom',
] as const satisfies readonly ChatProviderId[]

export interface ModelCapabilityProfile {
  quality: number
  speed: number
  efficiency: number
  reasoning: number
  reliability: number
  classification: number
  planning: number
  scouting: number
  coding: number
  verification: number
  synthesis: number
}

export interface ProviderModelDefinition {
  id: string
  contextWindow?: number
  openAiOnly?: boolean
}

export interface SharedProviderCatalog {
  provider: ChatProviderId
  defaultModel: string
  models: ProviderModelDefinition[]
}

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
  provider: 'freellmapi',
  defaultModel: 'auto',
  models: [{ id: 'auto', contextWindow: 200_000 }],
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

/**
 * 不暴露 `Set` 的可变 API，同时保留高效的 `has` 与迭代语义。
 *
 * `Object.freeze(new Set())` 仍可调用 `add`，所以发布 API 必须使用只读门面。
 */
class ReadonlySetSnapshot<T> implements ReadonlySet<T> {
  readonly #values: Set<T>

  constructor(values: Iterable<T>) {
    this.#values = new Set(values)
    Object.freeze(this)
  }

  public get size(): number {
    return this.#values.size
  }

  public has(value: T): boolean {
    return this.#values.has(value)
  }

  public entries(): ReturnType<ReadonlySet<T>['entries']> {
    return this.#values.entries()
  }

  public keys(): ReturnType<ReadonlySet<T>['keys']> {
    return this.#values.keys()
  }

  public values(): ReturnType<ReadonlySet<T>['values']> {
    return this.#values.values()
  }

  public forEach(
    callback: (value: T, valueAgain: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown
  ): void {
    for (const value of this.#values) {
      callback.call(thisArg, value, value, this)
    }
  }

  public [Symbol.iterator](): ReturnType<ReadonlySet<T>[typeof Symbol.iterator]> {
    return this.#values[Symbol.iterator]()
  }
}

export const DefaultProviderModels: Readonly<Partial<Record<ChatProviderId, string>>> = Object.fromEntries(
  SharedProviderCatalogs.map((catalog) => [catalog.provider, catalog.defaultModel])
) as Partial<Record<ChatProviderId, string>>

export const OpenAiOnlyModels: ReadonlySet<string> = new ReadonlySetSnapshot(
  SharedProviderCatalogMap.get('openai')
    ?.models.filter((model) => model.openAiOnly)
    .map((model) => model.id) ?? []
)

export const KnownTeamModelCapabilityOverrides: Record<string, Partial<ModelCapabilityProfile>> = {
  'deepseek/deepseek-v3.2': {
    quality: 0.88,
    speed: 0.79,
    efficiency: 0.82,
    reasoning: 0.85,
    reliability: 0.82,
    classification: 0.82,
    planning: 0.85,
    scouting: 0.82,
    coding: 0.88,
    verification: 0.85,
    synthesis: 0.81,
  },
  'deepseek/deepseek-r1-0528': {
    quality: 0.9,
    speed: 0.48,
    efficiency: 0.58,
    reasoning: 0.97,
    reliability: 0.8,
    classification: 0.78,
    planning: 0.95,
    scouting: 0.88,
    coding: 0.8,
    verification: 0.9,
    synthesis: 0.8,
  },
  'xiaomi/mimo-v2-pro': {
    quality: 0.79,
    speed: 0.88,
    efficiency: 0.8,
    reasoning: 0.78,
    reliability: 0.72,
    classification: 0.78,
    planning: 0.78,
    scouting: 0.77,
    coding: 0.76,
    verification: 0.76,
    synthesis: 0.76,
  },
  'minimax/minimax-m2.7': {
    quality: 0.82,
    speed: 0.74,
    efficiency: 0.76,
    reasoning: 0.8,
    reliability: 0.74,
    classification: 0.78,
    planning: 0.8,
    scouting: 0.79,
    coding: 0.78,
    verification: 0.79,
    synthesis: 0.78,
  },
  'minimax/minimax-m2.5': {
    quality: 0.78,
    speed: 0.83,
    efficiency: 0.8,
    reasoning: 0.77,
    reliability: 0.73,
    classification: 0.76,
    planning: 0.77,
    scouting: 0.76,
    coding: 0.75,
    verification: 0.75,
    synthesis: 0.76,
  },
  'minimax/minimax-m1': {
    quality: 0.74,
    speed: 0.85,
    efficiency: 0.84,
    reasoning: 0.72,
    reliability: 0.7,
    classification: 0.72,
    planning: 0.72,
    scouting: 0.72,
    coding: 0.72,
    verification: 0.72,
    synthesis: 0.72,
  },
  'openrouter/elephant-alpha': {
    quality: 0.8,
    speed: 0.68,
    efficiency: 0.71,
    reasoning: 0.83,
    reliability: 0.71,
    classification: 0.77,
    planning: 0.82,
    scouting: 0.8,
    coding: 0.75,
    verification: 0.79,
    synthesis: 0.84,
  },
  'nvidia/nemotron-3-super-120b-a12b': {
    quality: 0.81,
    speed: 0.64,
    efficiency: 0.69,
    reasoning: 0.84,
    reliability: 0.74,
    classification: 0.78,
    planning: 0.84,
    scouting: 0.82,
    coding: 0.77,
    verification: 0.82,
    synthesis: 0.8,
  },
  'openai/gpt-oss-120b': {
    quality: 0.82,
    speed: 0.7,
    efficiency: 0.73,
    reasoning: 0.84,
    reliability: 0.76,
    classification: 0.79,
    planning: 0.84,
    scouting: 0.82,
    coding: 0.82,
    verification: 0.83,
    synthesis: 0.81,
  },
  'z-ai/glm-5.1': {
    quality: 0.84,
    speed: 0.77,
    efficiency: 0.78,
    reasoning: 0.81,
    reliability: 0.75,
    classification: 0.8,
    planning: 0.81,
    scouting: 0.8,
    coding: 0.79,
    verification: 0.8,
    synthesis: 0.82,
  },
  'z-ai/glm-5': {
    quality: 0.81,
    speed: 0.74,
    efficiency: 0.77,
    reasoning: 0.79,
    reliability: 0.73,
    classification: 0.77,
    planning: 0.79,
    scouting: 0.78,
    coding: 0.77,
    verification: 0.78,
    synthesis: 0.79,
  },
  'stepfun/step-3.5-flash': {
    quality: 0.7,
    speed: 0.96,
    efficiency: 0.91,
    reasoning: 0.69,
    reliability: 0.69,
    classification: 0.74,
    planning: 0.69,
    scouting: 0.71,
    coding: 0.68,
    verification: 0.69,
    synthesis: 0.7,
  },
  'moonshotai/kimi-k2-thinking': {
    quality: 0.87,
    speed: 0.52,
    efficiency: 0.62,
    reasoning: 0.93,
    reliability: 0.78,
    classification: 0.79,
    planning: 0.92,
    scouting: 0.89,
    coding: 0.78,
    verification: 0.87,
    synthesis: 0.84,
  },
  'moonshotai/kimi-k2-0905': {
    quality: 0.83,
    speed: 0.73,
    efficiency: 0.76,
    reasoning: 0.81,
    reliability: 0.77,
    classification: 0.77,
    planning: 0.82,
    scouting: 0.81,
    coding: 0.77,
    verification: 0.8,
    synthesis: 0.84,
  },
  'qwen/qwen3-max-thinking': {
    quality: 0.9,
    speed: 0.49,
    efficiency: 0.59,
    reasoning: 0.96,
    reliability: 0.8,
    classification: 0.8,
    planning: 0.95,
    scouting: 0.89,
    coding: 0.8,
    verification: 0.9,
    synthesis: 0.83,
  },
  'qwen/qwen3-coder-next': {
    quality: 0.83,
    speed: 0.75,
    efficiency: 0.77,
    reasoning: 0.77,
    reliability: 0.76,
    classification: 0.73,
    planning: 0.77,
    scouting: 0.76,
    coding: 0.93,
    verification: 0.85,
    synthesis: 0.76,
  },
  'gpt-5.5': {
    quality: 0.97,
    speed: 0.62,
    efficiency: 0.46,
    reasoning: 0.98,
    reliability: 0.95,
    classification: 0.9,
    planning: 0.98,
    scouting: 0.92,
    coding: 0.93,
    verification: 0.94,
    synthesis: 0.92,
  },
  'gpt-5.4': {
    quality: 0.96,
    speed: 0.61,
    efficiency: 0.44,
    reasoning: 0.97,
    reliability: 0.94,
    classification: 0.89,
    planning: 0.97,
    scouting: 0.91,
    coding: 0.91,
    verification: 0.92,
    synthesis: 0.91,
  },
  'gpt-5.2': {
    quality: 0.92,
    speed: 0.64,
    efficiency: 0.5,
    reasoning: 0.93,
    reliability: 0.91,
    classification: 0.86,
    planning: 0.93,
    scouting: 0.88,
    coding: 0.87,
    verification: 0.89,
    synthesis: 0.88,
  },
  'gpt-5.4-mini': {
    quality: 0.77,
    speed: 0.93,
    efficiency: 0.84,
    reasoning: 0.76,
    reliability: 0.84,
    classification: 0.79,
    planning: 0.75,
    scouting: 0.76,
    coding: 0.72,
    verification: 0.74,
    synthesis: 0.77,
  },
  'gpt-5.2-codex': {
    quality: 0.9,
    speed: 0.67,
    efficiency: 0.54,
    reasoning: 0.87,
    reliability: 0.9,
    classification: 0.74,
    planning: 0.84,
    scouting: 0.79,
    coding: 0.96,
    verification: 0.93,
    synthesis: 0.79,
  },
  'gpt-5.1-codex-max': {
    quality: 0.94,
    speed: 0.57,
    efficiency: 0.42,
    reasoning: 0.9,
    reliability: 0.91,
    classification: 0.73,
    planning: 0.86,
    scouting: 0.79,
    coding: 0.98,
    verification: 0.94,
    synthesis: 0.79,
  },
  'gpt-5.3-codex': {
    quality: 0.85,
    speed: 0.74,
    efficiency: 0.64,
    reasoning: 0.8,
    reliability: 0.86,
    classification: 0.72,
    planning: 0.8,
    scouting: 0.76,
    coding: 0.91,
    verification: 0.88,
    synthesis: 0.76,
  },
  'gpt-5.3-codex-spark': {
    quality: 0.77,
    speed: 0.98,
    efficiency: 0.9,
    reasoning: 0.73,
    reliability: 0.82,
    classification: 0.69,
    planning: 0.71,
    scouting: 0.69,
    coding: 0.9,
    verification: 0.82,
    synthesis: 0.68,
  },
  'gpt-5.1-codex-mini': {
    quality: 0.74,
    speed: 0.9,
    efficiency: 0.86,
    reasoning: 0.71,
    reliability: 0.8,
    classification: 0.68,
    planning: 0.7,
    scouting: 0.69,
    coding: 0.85,
    verification: 0.8,
    synthesis: 0.68,
  },
  'gpt-4o-mini': {
    quality: 0.72,
    speed: 0.91,
    efficiency: 0.86,
    reasoning: 0.7,
    reliability: 0.8,
    classification: 0.76,
    planning: 0.69,
    scouting: 0.7,
    coding: 0.69,
    verification: 0.72,
    synthesis: 0.74,
  },
  'openai/gpt-4o-mini': {
    quality: 0.72,
    speed: 0.91,
    efficiency: 0.86,
    reasoning: 0.7,
    reliability: 0.8,
    classification: 0.76,
    planning: 0.69,
    scouting: 0.7,
    coding: 0.69,
    verification: 0.72,
    synthesis: 0.74,
  },
}

export const KnownModelContextWindows: ReadonlyMap<string, number> = new Map(
  SharedProviderCatalogs.flatMap((catalog) =>
    catalog.models
      .filter((model) => isNumber(model.contextWindow))
      .map((model) => [model.id, model.contextWindow!] as const)
  )
)

const OpenRouterCompatibleModelContextWindows = new Map(
  OpenRouterCompatibleModelCatalog.filter((model) => isNumber(model.contextWindow)).map(
    (model) => [model.id, model.contextWindow!] as const
  )
)

const DefaultModelContextWindow = 128_000
const KnownModelContextWindowFamilies: Array<{
  prefix: string
  contextWindow: number
}> = [
  { prefix: 'gpt-5', contextWindow: 400_000 },
  { prefix: 'gpt-4.1', contextWindow: 1_000_000 },
]

function dedupeModelsPreservingOrder(models: string[]): string[] {
  const normalizedModels: string[] = []
  const seen = new Set<string>()

  models.forEach((model) => {
    const trimmed = model.trim()
    if (!trimmed || seen.has(trimmed)) return

    seen.add(trimmed)
    normalizedModels.push(trimmed)
  })

  return normalizedModels
}

function buildModelLookupCandidates(model: string): string[] {
  const trimmed = model.trim().toLowerCase()
  if (!trimmed) return []

  const candidates: string[] = []
  const seen = new Set<string>()
  const queue = [trimmed]

  while (!isEmpty(queue)) {
    const candidate = queue.shift()
    if (!candidate || seen.has(candidate)) {
      continue
    }

    seen.add(candidate)
    candidates.push(candidate)

    const lastSlashIndex = candidate.lastIndexOf('/')
    if (lastSlashIndex >= 0 && lastSlashIndex < candidate.length - 1) {
      queue.push(candidate.slice(lastSlashIndex + 1))
    }

    ;[':', '@'].forEach((separator) => {
      const separatorIndex = candidate.indexOf(separator)
      if (separatorIndex > 0) {
        queue.push(candidate.slice(0, separatorIndex))
      }
    })
  }

  return candidates
}

function addCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || seen.has(trimmed)) return

  seen.add(trimmed)
  candidates.push(trimmed)
}

export function resolveOpenRouterCompatibleModelContextWindow(
  model: string,
  provider?: LooseOptional<string>
): Nullable<number> {
  const candidates: string[] = []
  const seen = new Set<string>()
  const normalizedProvider = provider?.trim().toLowerCase() ?? ''
  const normalizedModel = model.trim().toLowerCase()

  if (normalizedProvider && normalizedModel && !normalizedModel.includes('/')) {
    addCandidate(candidates, seen, `${normalizedProvider}/${normalizedModel}`)
  }

  buildModelLookupCandidates(model).forEach((candidate) => {
    addCandidate(candidates, seen, candidate)
  })

  for (const candidate of candidates) {
    const contextWindow = OpenRouterCompatibleModelContextWindows.get(candidate)
    if (isNumber(contextWindow)) return contextWindow
  }

  return null
}

function resolveKnownModelContextWindow(model: string): Nullable<number> {
  return resolveModelContextWindowCandidates(buildModelLookupCandidates(model))
}

function resolveModelContextWindowCandidates(
  lookupCandidates: readonly string[],
  includeCompatibleCatalog = false
): Nullable<number> {
  if (isEmpty(lookupCandidates)) return null

  for (const candidate of lookupCandidates) {
    const exactMatch = KnownModelContextWindows.get(candidate)
    if (isNumber(exactMatch)) return exactMatch

    if (includeCompatibleCatalog) {
      const compatibleMatch = OpenRouterCompatibleModelContextWindows.get(candidate)
      if (isNumber(compatibleMatch)) return compatibleMatch
    }
  }

  for (const candidate of lookupCandidates) {
    const familyMatch = KnownModelContextWindowFamilies.find(
      (entry) =>
        candidate === entry.prefix ||
        candidate.startsWith(`${entry.prefix}-`) ||
        candidate.startsWith(`${entry.prefix}.`)
    )
    if (familyMatch) return familyMatch.contextWindow
  }

  return null
}

function buildProviderModelLookupCandidates(provider: string, model: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const normalizedProvider = provider.trim().toLowerCase()
  const normalizedModel = model.trim().toLowerCase()

  buildModelLookupCandidates(normalizedModel).forEach((candidate) => {
    addCandidate(candidates, seen, candidate)
  })

  const providerAlias =
    normalizedProvider === 'vertex'
      ? 'google'
      : normalizedProvider === 'bedrock'
        ? 'anthropic'
        : normalizedProvider
  if (providerAlias && normalizedModel && !normalizedModel.includes('/')) {
    addCandidate(candidates, seen, `${providerAlias}/${normalizedModel}`)
  }

  if (normalizedProvider === 'bedrock') {
    const withoutInferenceProfile = normalizedModel.replace(/^(?:global|us|eu|apac)\./u, '')
    const namespaceSeparator = withoutInferenceProfile.indexOf('.')
    if (namespaceSeparator > 0 && namespaceSeparator < withoutInferenceProfile.length - 1) {
      const namespace = withoutInferenceProfile.slice(0, namespaceSeparator)
      const providerModel = withoutInferenceProfile.slice(namespaceSeparator + 1)
      addCandidate(candidates, seen, providerModel)
      addCandidate(candidates, seen, `${namespace}/${providerModel}`)

      const modelWithoutBedrockRevision = providerModel.replace(/-\d{8}-v\d+(?::\d+)?$/u, '')
      addCandidate(candidates, seen, modelWithoutBedrockRevision)
      addCandidate(candidates, seen, `${namespace}/${modelWithoutBedrockRevision}`)
    }
  }

  return candidates
}

/**
 * 根据 provider 实际选中的模型 ID 查询已知窗口；无法识别时返回 null，
 * 由调用方保留自己的安全回退值。
 */
export function resolveProviderModelContextWindow(
  provider: string,
  model: string
): Nullable<number> {
  return resolveModelContextWindowCandidates(
    buildProviderModelLookupCandidates(provider, model),
    true
  )
}

export interface ProviderModelResolution {
  model: string
  didFallback: boolean
}

export function getSharedProviderCatalog(
  providerId: ChatProviderId
): Nullable<SharedProviderCatalog> {
  return SharedProviderCatalogMap.get(providerId) ?? null
}

export function getSharedProviderModels(providerId: ChatProviderId): string[] {
  return getSharedProviderCatalog(providerId)?.models.map((model) => model.id) ?? []
}

export function getSharedProviderSuggestedModels(providerId: ChatProviderId): string[] {
  return (getSharedProviderCatalog(providerId)?.models ?? [])
    .filter((model) => !model.openAiOnly)
    .map((model) => model.id)
}

export function getVisibleProviderModels(providerId: ChatProviderId, models: string[]): string[] {
  const visibleModels =
    providerId === 'openai' ? models : models.filter((model) => !OpenAiOnlyModels.has(model))

  return dedupeModelsPreservingOrder(visibleModels)
}

export function resolveProviderModelSelection(
  providerId: ChatProviderId,
  currentModel?: string
): ProviderModelResolution {
  const requestedModel = currentModel?.trim() ?? ''
  const suggestions = getVisibleProviderModels(providerId, getSharedProviderModels(providerId))

  if (
    CustomModelProviderIds.includes(providerId as (typeof CustomModelProviderIds)[number]) &&
    !isBlank(requestedModel)
  )
    return {
      model: requestedModel,
      didFallback: false,
    }

  if (!isBlank(requestedModel) && suggestions.includes(requestedModel))
    return {
      model: requestedModel,
      didFallback: false,
    }

  return {
    model: first(suggestions) ?? requestedModel,
    didFallback: !isBlank(requestedModel) && (first(suggestions) ?? '') !== requestedModel,
  }
}

export function getResolvedProviderModel(
  providerId: ChatProviderId,
  currentModel?: string
): string {
  return resolveProviderModelSelection(providerId, currentModel).model
}

export function resolveModelContextWindow(model: string): number {
  return resolveKnownModelContextWindow(model) ?? DefaultModelContextWindow
}
