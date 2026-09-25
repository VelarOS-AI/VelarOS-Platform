import type {
  AgentProviderRuntimeConfig,
  ChatProviderId,
  ModelInputModality,
  OpenRouterProviderRoutingPreferences,
  ProviderModelCatalog,
  ReasoningLevel,
} from './model'

/** 静态目录里的一条模型定义：id、已知窗口，以及它是不是只在 OpenAI 直连下可选。 */
export interface ProviderModelDefinition {
  id: string
  contextWindow?: number
  inputModalities?: readonly ModelInputModality[]
  openAiOnly?: boolean
}

/** 一个 provider 的静态目录：缺省模型加一串候选模型。 */
export interface SharedProviderCatalog {
  provider: ChatProviderId
  defaultModel: string
  models: ProviderModelDefinition[]
}

/** 判断 provider 是否可用时可以另给的两样东西：环境变量快照与适配器支持判定。 */
export interface ModelProviderAvailabilityOptions {
  env?: Readonly<Record<string, string | undefined>>
  supportsProvider?: (provider: ChatProviderId) => boolean
}

/** 判断某条运行时配置是否算「配好了」的全部入参。 */
export interface ModelProviderConfiguredInput extends ModelProviderAvailabilityOptions {
  runtimeConfig: AgentProviderRuntimeConfig
  providerRuntimeConfigs?: readonly AgentProviderRuntimeConfig[]
  apiKeyOverride?: LooseOptional<string>
}

/** 一次远端 `/models` 请求的地址与请求头。 */
export interface ProviderModelListRequest {
  readonly url: string
  readonly headers: ReadonlyArray<[string, string]>
}

/** 从远端 `/models` 响应里读出来的一条模型；字段缺席表示这家没给。 */
export interface RemoteProviderModelEntry {
  readonly id: string
  readonly label?: string
  readonly contextWindow?: number
  readonly inputModalities?: readonly ModelInputModality[]
}

/** 目录缓存里的一格：在飞的请求、已落定的快照、过期时刻与等待者计数。 */
export interface ProviderModelCatalogCacheEntry {
  controller: AbortController
  promise: Promise<ProviderModelCatalog>
  catalog?: ProviderModelCatalog
  expiresAt: number
  waiters: number
}

/** 归一化后的 OpenRouter 路由配置：真正发出去的模型、白名单、provider 偏好与这一轮的推理档位。 */
export interface OpenRouterRequestRouting {
  model: string
  allowedModels: string[]
  providerPreferences?: OpenRouterProviderRoutingPreferences
  useFreeModelsForDebug: boolean
  reasoningLevel?: LooseOptional<ReasoningLevel>
}
