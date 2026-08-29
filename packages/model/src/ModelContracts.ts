/** Built-in providers whose concrete integration is owned by Model Runtime. */
export type BuiltInChatProviderId =
  | 'velar'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'xai'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'mistral'
  | 'minimax'
  | 'groq'
  | 'volcengine'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible-gateway'
  | 'custom'

declare const InjectedChatProviderIdBrand: unique symbol

/** Provider ids introduced by a validated provider script. */
export type InjectedChatProviderId = string & {
  readonly [InjectedChatProviderIdBrand]: true
}

export type ChatProviderId = BuiltInChatProviderId | InjectedChatProviderId

export type ThinkingDepth = 'fast' | 'balanced' | 'deep'
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra'
export type ModelInputModality = 'text' | 'image' | 'audio'

export interface AgentProviderAdapterConfig {
  kind: 'js'
  providerId: string
  filename: string
  source: string
}

export interface ProviderModelCatalogEntry {
  id: string
  label: string
  contextWindow?: number
  /** Inputs the concrete model transport explicitly accepts. Missing means unknown, not unsupported. */
  inputModalities?: readonly ModelInputModality[]
  available?: boolean
  minPlan?: string
}

export interface ProviderScriptManifest {
  id: ChatProviderId
  label: string
  description: string
  defaultBaseURL: string
  defaultApiKey: string
  apiKeyOptional: boolean
  baseURLConfigurable: boolean
  enabledByDefault: boolean
  defaultModel: string
  models: ProviderModelCatalogEntry[]
  embeddingModel?: LooseOptional<string>
  embeddingModelLocked?: LooseOptional<boolean>
  inlineCompletionModel?: LooseOptional<string>
}

export interface AgentProviderRuntimeConfig {
  provider: ChatProviderId
  enabled: boolean
  apiKey: string
  baseURL: string
  defaultModel: string
  providerScript?: LooseOptional<ProviderScriptManifest>
  adapter?: LooseOptional<AgentProviderAdapterConfig>
}

export interface OpenRouterRoutingConfig {
  useFreeModelsForDebug: boolean
}

export type OpenRouterProviderSortMode = 'price' | 'throughput' | 'latency'
export type OpenRouterProviderSortPartition = 'model' | 'none'

export interface OpenRouterProviderSortPreference {
  by: OpenRouterProviderSortMode
  partition?: OpenRouterProviderSortPartition
}

export interface OpenRouterProviderRoutingPreferences {
  sort?: OpenRouterProviderSortMode | OpenRouterProviderSortPreference
  allow_fallbacks?: boolean
  require_parameters?: boolean
  data_collection?: 'allow' | 'deny'
  only?: string[]
  ignore?: string[]
}

export interface OpenRouterModelRequestOptions {
  allowedModels?: string[]
  useFreeModelsForDebug?: boolean
  providerPreferences?: OpenRouterProviderRoutingPreferences
}

export interface ModelRequestPolicy {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

/** Runtime-only metadata consumed by the product-owned model transport. */
export interface ModelRequestRuntimeContext {
  sessionId?: string
  [key: string]: unknown
}

export interface ModelRequestOptions {
  openRouter?: OpenRouterModelRequestOptions
  providerOptions?: Record<string, unknown>
  requestPolicy?: ModelRequestPolicy
  runtimeContext?: ModelRequestRuntimeContext
}

export interface ListProviderModelsRequest {
  provider: ChatProviderId
  apiKey: string
  baseURL: string
  defaultModel?: string
  purpose?: 'chat' | 'embedding'
  adapter?: LooseOptional<AgentProviderAdapterConfig>
}

export interface ValidateProviderRuntimeRequest {
  provider: ChatProviderId
  apiKey: string
  baseURL: string
  defaultModel?: string
  adapter?: LooseOptional<AgentProviderAdapterConfig>
}

/** Opaque-to-Agent provider selection interpreted only by Model Runtime. */
export interface ModelProviderSelection {
  provider: ChatProviderId
  apiKey: string
  baseURL: string
  adapter?: LooseOptional<AgentProviderAdapterConfig>
  thinkingDepth?: LooseOptional<ThinkingDepth>
  reasoningLevel?: LooseOptional<ReasoningLevel>
}

export interface ModelSelection extends ModelProviderSelection {
  model: string
}

/** Product-owned provider collection state interpreted only by Model Runtime. */
export interface ModelRuntimeContext {
  providerRuntimeConfigs: AgentProviderRuntimeConfig[]
  openRouter: OpenRouterRoutingConfig
}

export interface ProviderModelCatalog {
  provider: ChatProviderId
  source: 'remote' | 'preset'
  models: ProviderModelCatalogEntry[]
  fetchedAt: number
  error?: LooseOptional<string>
}
