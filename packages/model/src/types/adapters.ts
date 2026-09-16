import type { OpenAIProviderSettings } from '@ai-sdk/openai'
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'

import type {
  AgentProviderAdapterConfig,
  ChatProviderId,
  ModelInputModality,
  ModelRequestOptions,
  ProviderScriptRuntimeMetadata,
  ReasoningLevel,
  ThinkingDepth,
} from './model'

export interface ModelAdapterConfig {
  /** 聊天 provider id。 */
  provider: ChatProviderId
  /** UI 配置或环境变量中的 API key。 */
  apiKey: string
  /** provider base URL，已按 preset 做过默认值解析。 */
  baseURL: string
  /** 用户上传的自定义 provider adapter。 */
  adapter?: LooseOptional<AgentProviderAdapterConfig>
  /** 本次请求期望的模型运行策略；adapter 会按 provider 能力映射为 reasoning/thinking 参数。 */
  thinkingDepth?: LooseOptional<ThinkingDepth>
  /** Composer 思考力度 5 档；存在时优先于 thinkingDepth 决定 reasoning 开关/力度/预算。 */
  reasoningLevel?: LooseOptional<ReasoningLevel>
  /** 本地 provider script 已解析的运行时元数据；执行阶段复用它，避免同一轮运行二次解析漂移。 */
  providerScriptRuntimeMetadata?: LooseOptional<ProviderScriptRuntimeMetadata>
}

/** embedding 请求的 provider 无关描述。 */
export interface EmbeddingRequest {
  url: string
  headers: Record<string, string>
  body?: unknown
  execute?: () => Promise<unknown>
}

/** 延迟到具体 modelId 才创建 AI SDK LanguageModel。 */
export type LanguageModelFactory = (modelId: string, options?: ModelRequestOptions) => LanguageModel

/** Agent 侧拿到的 provider：就是一个按 modelId 造语言模型的工厂。 */
export type AgentProvider = LanguageModelFactory

/** 一次解析的结果：发得出去的 provider 工厂，加上界面与记账要的那几个名字。 */
export interface ResolvedAgentModelRuntime {
  provider: LanguageModelFactory
  providerId: string
  model: string
  providerModel: string
  contextWindow?: number
  /** Explicit concrete-model input contract; unknown metadata allows a provider attempt. */
  supportedInputModalities: readonly ModelInputModality[]
  modelRequestOptions?: ModelRequestOptions
  resolutionSource: 'provider-collection'
  resolutionTrace: ModelResolutionTraceEntry[]
  fallbackReason?: string
}

/** 解析轨迹的一行：这个 provider/模型被选中还是跳过，跳过的话为什么。 */
export interface ModelResolutionTraceEntry {
  provider: string
  model: string
  providerModel?: string
  status: 'selected' | 'skipped'
  reason?: string
}

/** OpenAI 系 SDK 允许替换的 fetch。 */
export type OpenAIModelFetch = NonNullable<OpenAIProviderSettings['fetch']>

/** 那个 fetch 的第二个参数，也就是请求初始化选项。 */
export type OpenAIModelFetchInit = Parameters<OpenAIModelFetch>[1]

/** 一次调用上挂着的厂商选项表。 */
export type ModelCallProviderOptions = NonNullable<LanguageModelV3CallOptions['providerOptions']>

/**
 * 发给服务商的 reasoning 力度三档；五档 `ReasoningLevel` 与三档 `ThinkingDepth` 都映射到它。
 *
 * 它是出线前的 wire 细节，不是产品面的轴：产品只选 level 或 depth，映射由本包做，所以它不放在
 * 可移植数据文件里。
 */
export type ReasoningEffort = 'low' | 'medium' | 'high'
