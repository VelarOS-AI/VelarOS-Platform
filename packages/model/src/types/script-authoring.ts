import type { createAnthropic } from '@ai-sdk/anthropic'
import type { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { createOpenAI } from '@ai-sdk/openai'

import type { AppError } from '@velaros-ai/core/error'
import type { logRuntime } from '@velaros-ai/core/logger'

import type { ProviderScriptHostBridge } from '../contract/requires'

import type { EmbeddingRequest, LanguageModelFactory, ModelAdapterConfig } from './adapters'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ProviderModelCatalogEntry,
  ProviderScriptManifest,
  ProviderScriptRuntimeMetadata,
  ReasoningEffort,
  ReasoningLevel,
  ThinkingDepth,
} from './model'

/**
 * 交给 provider script 的能力包。
 *
 * 脚本以宿主同权执行，所以这里给的是真 SDK 工厂与真 `require`；
 * 入口必须是显式登记（`.velaros/dev.json` 或插件安装链的 `registerSource`）。
 */
export interface ProviderScriptHelpers {
  /** OpenAI 系 SDK 的 provider 工厂。 */
  createOpenAI: typeof createOpenAI
  /** Anthropic SDK 的 provider 工厂。 */
  createAnthropic: typeof createAnthropic
  /** Google SDK 的 provider 工厂。 */
  createGoogleGenerativeAI: typeof createGoogleGenerativeAI
  /** 全局 fetch。 */
  fetch: typeof fetch
  /** 以脚本自己的路径为基准的 require。 */
  require: NodeRequire
  /** 以本包为基准的 require，用来拿宿主的 node_modules。 */
  hostRequire: NodeRequire
  /** 带脚本路径标签的日志器。 */
  log: ReturnType<typeof logRuntime.tag>
  /** 脚本可能要用的几个路径。 */
  paths: {
    /** 注册表的工作目录。 */
    cwd: string
    /** 注册表的用户目录。 */
    homeDir: string
    /** 生效的配置文件路径。 */
    configPath: string
    /** 生效的配置文件所在目录。 */
    configDir: string
    /** 配置文件所属的 `.velaros` 目录。 */
    velarosDir: string
    /** 脚本自己的路径。 */
    scriptPath: string
    /** 脚本所在目录。 */
    scriptDir: string
  }
  /** 宿主桥上的三件能力，宿主没注入时已按降级处理包过一层。 */
  host: {
    /** 用系统默认程序打开一个链接。 */
    openExternal: ProviderScriptHostBridge['openExternal']
    /** 宿主的用户数据目录。 */
    getUserDataPath: ProviderScriptHostBridge['getUserDataPath']
    /** 宿主应用的版本号。 */
    getAppVersion: ProviderScriptHostBridge['getAppVersion']
  }
  /** 思考力度与预算的换算，和本包内置适配器用的是同一套。 */
  reasoning: {
    /** off 档：这次请求完全不发 reasoning。 */
    isReasoningDisabledByLevel: (level?: LooseOptional<ReasoningLevel>) => boolean
    /** 合并 OpenRouter 风格的 reasoning 开关。 */
    mergeOpenRouterReasoning: (
      existing: unknown,
      depth?: LooseOptional<ThinkingDepth>,
      level?: LooseOptional<ReasoningLevel>
    ) => Record<string, unknown>
    /** 算这次请求的 thinking budget。 */
    resolveReasoningBudget: (
      maxOutputTokens?: number,
      level?: LooseOptional<ReasoningLevel>,
      depth?: LooseOptional<ThinkingDepth>
    ) => number
    /** 算这次请求的 reasoning 力度。 */
    resolveReasoningEffort: (
      level?: LooseOptional<ReasoningLevel>,
      depth?: LooseOptional<ThinkingDepth>
    ) => ReasoningEffort
  }
  /** 本仓的错误类，脚本抛它才能被统一按码处理。 */
  AppError: typeof AppError
}

/** 造语言模型或 embedding 请求时交给脚本的入参。 */
export interface ProviderScriptInput {
  /** 这次调用的适配器配置。 */
  config: ModelAdapterConfig
  /** 脚本的能力包。 */
  helpers: ProviderScriptHelpers
  /** 同一轮里已经解析好的运行时元数据，避免二次解析漂移。 */
  runtimeMetadata?: LooseOptional<ProviderScriptRuntimeMetadata>
}

/** 校验、列模型、解析运行时元数据时交给脚本的入参。 */
export interface ProviderScriptRuntimeInput {
  /** 这次要处理的 provider id。 */
  provider: ChatProviderId
  /** 已解析好的 API Key。 */
  apiKey: string
  /** 已解析好的 baseURL。 */
  baseURL: string
  /** 产品当前选中的缺省模型。 */
  defaultModel?: LooseOptional<string>
  /** 这次列模型是给聊天用还是给 embedding 用。 */
  purpose?: LooseOptional<ListProviderModelsRequest['purpose']>
  /** 这次要解析的具体模型。 */
  model?: LooseOptional<string>
  /** 这次调用的适配器配置，解析运行时元数据时给。 */
  config?: LooseOptional<ModelAdapterConfig>
  /** 脚本的能力包。 */
  helpers: ProviderScriptHelpers
  /** 取消信号；长请求必须响应它。 */
  signal?: AbortSignal
}

/**
 * provider script 作者要实现的契约。
 *
 * 只有 `manifest` 必给，其余成员按需实现：没有 `createLanguageModelFactory` 就只能用来列模型与校验，
 * 没有 `createEmbeddingRequest` 就按"这个 provider 不支持 embedding"处理。
 */
export interface ProviderScriptDefinition {
  /** 这个 provider 的清单：id、标签、模型目录与缺省模型。 */
  manifest: ProviderScriptManifest
  /** 造语言模型工厂；返回值必须是函数。 */
  createLanguageModelFactory?: (input: ProviderScriptInput) => LanguageModelFactory
  /** 造 embedding 请求。 */
  createEmbeddingRequest?: (
    input: ProviderScriptInput & {
      model: string
      texts: string[]
    }
  ) => EmbeddingRequest
  /** 校验一份运行时配置能不能连通；抛错即判不通过。 */
  validate?: (input: ProviderScriptRuntimeInput) => Promise<void> | void
  /** 列出当前鉴权作用域下可用的模型。 */
  listModels?: (
    input: ProviderScriptRuntimeInput
  ) => Promise<ProviderModelCatalogEntry[]> | ProviderModelCatalogEntry[]
  /** 解析某个模型的具体运行时元数据：真正发出去的模型名、窗口与输入形态。 */
  resolveRuntimeMetadata?: (
    input: ProviderScriptRuntimeInput
  ) => Promise<ProviderScriptRuntimeMetadata> | ProviderScriptRuntimeMetadata
}

/** 已加载并归一化好的一份 provider script。 */
export interface LoadedProviderScript {
  providerId: ChatProviderId
  label: string
  manifest: ProviderScriptManifest
  scriptPath: string
  configPath: string
  definition: ProviderScriptDefinition
  helpers: ProviderScriptHelpers
}
