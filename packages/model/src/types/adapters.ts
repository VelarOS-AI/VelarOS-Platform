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
  /** 输入框选的思考力度；adapter 按 provider 能力映射为 reasoning/thinking 参数，缺席时按 medium。 */
  reasoningLevel?: LooseOptional<ReasoningLevel>
  /** OpenAI 显式缓存断点能力；缺席时仅官方端点使用已知型号默认值。 */
  openaiExplicitCacheBreakpoints?: boolean
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

/** 提示词缓存包装层怎么出线：这条线路认不认会话缓存键。 */
export interface PromptCacheWireOptions {
  /** 会话缓存键译成 OpenAI 的 `prompt_cache_key` 发出去；不认这个字段的线路只剥掉内部标记。 */
  readonly sessionKey: boolean
  /** true 翻译 OpenAI 断点；false 明确禁用并拒绝手写断点冲突；缺席保留其它线路与显式字段合同。 */
  readonly openaiBreakpoints?: boolean
  /** 原生 Anthropic 线路的总断点预算；先保留调用方实际落点，再为内部标记分配余量。 */
  readonly anthropicBreakpointLimit?: number
}

/** 按这一轮的输出上限算 reasoning 选项；这一档不发 reasoning 时返回 null。 */
export type ReasoningProviderOptionsResolver = (
  maxOutputTokens?: number
) => Nullable<ModelCallProviderOptions>
