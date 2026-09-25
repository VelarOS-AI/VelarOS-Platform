import type {
  ModelInputModalities,
  ModelProviderAdapterKinds,
  ModelProviderOperationalManifests,
  ModelProviderValidationKinds,
  ReasoningLevels,
  VelarCloudManagedProviderIds,
} from '../contract/constants.js'

/** 由 VelarOS Cloud 托管的 provider id。 */
export type VelarCloudManagedProviderId = (typeof VelarCloudManagedProviderIds)[number]

/** Built-in providers whose concrete integration is owned by Model Runtime. */
export type BuiltInChatProviderId = (typeof ModelProviderOperationalManifests)[number]['id']

/** Provider ids introduced by a validated provider script. */
export type InjectedChatProviderId = string & {
  readonly __velarosInjectedProviderId: true
}

export type ChatProviderId = BuiltInChatProviderId | InjectedChatProviderId

export type ReasoningLevel = (typeof ReasoningLevels)[number]
export type ModelInputModality = (typeof ModelInputModalities)[number]
export type ModelProviderAdapterKind = (typeof ModelProviderAdapterKinds)[number]
export type ModelProviderValidationKind = (typeof ModelProviderValidationKinds)[number]

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

/** 一个内置或注入 provider 的运营清单：设置页、连通性校验与适配器装配都读它。 */
export interface ModelProviderOperationalManifest {
  id: ChatProviderId
  label: string
  defaultBaseURL: string
  description: string
  adapterKind: ModelProviderAdapterKind
  validationKind: ModelProviderValidationKind
  defaultApiKeyEnv?: string
  defaultApiKey?: string
  apiKeyOptional?: boolean
  compatibilityNote?: string
  enabledByDefault?: boolean
  debugOnly?: boolean
  baseURLConfigurable?: boolean
  managedByCloud?: boolean
  providerScript?: ProviderScriptManifest
}

/** 运营清单加上当前静态目录算出来的建议模型与缺省模型。 */
export interface ModelProviderPreset extends ModelProviderOperationalManifest {
  modelSuggestions: string[]
  defaultModel: string
}

/** 目录解析结果：选中的模型，以及它是不是从请求的模型回退来的。 */
export interface ProviderModelResolution {
  model: string
  didFallback: boolean
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

/** provider script 解析出来的具体运行时元数据；缺席的字段一律按未知处理。 */
export interface ProviderScriptRuntimeMetadata {
  model?: LooseOptional<string>
  providerModel?: LooseOptional<string>
  contextWindow?: LooseOptional<number>
  /** Authoritative concrete-model input contract. Missing means unknown; the provider may attempt it. */
  inputModalities?: LooseOptional<readonly ModelInputModality[]>
  fallbackReason?: LooseOptional<string>
  config?: unknown
  modelRequestOptions?: LooseOptional<ModelRequestOptions>
}

/** 注册表交给外面的 provider script 描述：只有 manifest，脚本本体不出边界。 */
export interface ProviderScriptDescriptor {
  readonly manifest: ProviderScriptManifest
}

export interface ModelPricingEntry {
  provider: string
  model: string
  aliases: readonly string[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  /** 命中提示缓存的输入单价；缺席时约价把缓存读按 `inputUsdPerMillion` 计（偏高的上界）。 */
  cacheReadUsdPerMillion?: LooseOptional<number>
  /** 写入提示缓存的输入单价；缺席时约价把缓存写按 `inputUsdPerMillion` 计。 */
  cacheWriteUsdPerMillion?: LooseOptional<number>
  source: string
}

export interface ModelPricingCatalog {
  currency: 'USD'
  version: string
  updatedAt: string
  expiresAt: string
  entries: readonly ModelPricingEntry[]
}

/** 约价用的单价对；缺席表示这一轮不算钱。 */
export interface ModelPricingRates {
  readonly inputPerMillion: Nullable<number>
  readonly outputPerMillion: Nullable<number>
}

/** 一次模型调用的 token 与费用。 */
export interface ModelRunUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cachedInputTokens: number
  readonly totalTokens: number
  readonly cost: Nullable<number>
}

/** 多次调用的合计，外加最后一轮的上下文占用。 */
export interface ModelUsageSummary extends ModelRunUsage {
  readonly runs: number
  readonly lastContextTokens: number
}

/** 排一次重试要的入参：第几次重试、退避基数与上限。 */
export interface ModelProviderRetryOptions {
  readonly retryIndex: number
  readonly initialDelayMs?: number
  readonly maxDelayMs?: number
  readonly now?: number
}

/** 重试裁决：判成哪一类瞬时故障、等多久、给用户看什么。 */
export interface ModelProviderRetryDecision {
  readonly kind: 'network' | 'rate-limit' | 'provider'
  readonly delayMs: number
  readonly message: string
}

/** 凭据来自哪里：产品配置、环境变量、这个 provider 不要凭据，或者缺。 */
export type ModelProfileCredentialSource = 'config' | 'environment' | 'not-required' | 'missing'
