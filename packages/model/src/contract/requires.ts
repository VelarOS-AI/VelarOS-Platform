import type { ToolSet } from 'ai'

import type { ModelAdapterRegistryApi } from '../impl/composition/ModelAdapterRegistry'
import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from '../types/adapters'
import type { ChatProviderId } from '../types/model'
import type {
  ModelRequestEnvelope,
  ModelRequestGenerateTextInput,
  ModelRequestGenerateTextResult,
  ModelRequestObjectOutput,
  ModelRequestObjectOutputInput,
  ModelRequestOutput,
  ModelRequestStreamTextInput,
  ModelRequestStreamTextResult,
  ModelRequestTextOutput,
} from '../types/requests'

/**
 * 宿主给的环境变量读取口。
 *
 * 可移植宿主（渲染进程、worker、测试）实现它就只暴露自己愿意给的那几个值，
 * 不必把整个进程环境递给本包；缺席时装配自己读一次 `process.env` 快照。
 */
export interface ModelEnvironmentPort {
  /** 读一个环境变量；没有就返回 undefined。 */
  read(name: string): string | undefined
}

/**
 * Velar Cloud 的连接绑定。
 *
 * 宿主登录并拿到授权后注册；账户认证挂在这个 `fetch` 上，本包只负责把请求交给它。
 */
export interface VelarCloudModelRuntimeBinding {
  /** Cloud 模型网关地址；末尾分隔符由本包去掉。 */
  readonly baseURL: string
  /** 带账户认证的 fetch；聊天与 embedding 都必须走它，否则请求没有身份。 */
  readonly fetch: typeof fetch
}

/**
 * OpenRouter 要的请求归属信息。
 *
 * 宿主产品自己决定报哪个站点与标题；本包只在列模型时把它们写进请求头。
 */
export interface ProviderModelCatalogAttribution {
  /** OpenRouter 的 HTTP-Referer 值。 */
  readonly referer?: string
  /** OpenRouter 的 X-Title 值。 */
  readonly title?: string
}

/**
 * 宿主可替换的请求 transport。
 *
 * 缺席时用内置的 AI SDK transport；产品要接自己的观测、重放或假实现时注入这个口。
 */
export interface ModelRequestTransport {
  /** 发一次非流式请求。 */
  generateText<TOutput extends ModelRequestOutput = ModelRequestTextOutput>(
    envelope: ModelRequestEnvelope<ModelRequestGenerateTextInput<TOutput>>
  ): ModelRequestGenerateTextResult<TOutput>
  /** 发一次流式请求。 */
  streamText<TToolSet extends ToolSet = ToolSet>(
    envelope: ModelRequestEnvelope<ModelRequestStreamTextInput<TToolSet>>
  ): ModelRequestStreamTextResult<TToolSet>
  /** 按 schema 造一个结构化输出描述，交给上面两个方法用。 */
  createObjectOutput<TOutput>(
    input: ModelRequestObjectOutputInput<TOutput>
  ): ModelRequestObjectOutput<TOutput>
}

/**
 * 自定义模型适配器的扩展点。
 *
 * 内置的七个适配器都实现它；宿主要接一家本包没内置、又不方便写成 provider script 的服务商时，
 * 实现这个接口并从装配选项的 `adapters` 传进来。传进来的适配器排在内置适配器之前匹配。
 */
export interface ModelProviderAdapter {
  /** 这个适配器认不认这个 provider。 */
  supports(provider: ChatProviderId): boolean
  /** 按这次调用的配置造一个语言模型工厂。 */
  createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory
  /** 按这次调用的配置造一个 embedding 请求；不支持 embedding 时抛 embeddingUnsupported。 */
  createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest
}

/**
 * 宿主装配模型运行时对象图时给的东西，全部可选。
 *
 * 一个宿主一份；不传就用各自的缺省实现（环境读一次 `process.env` 快照、
 * provider script 按 `.velaros/dev.json` 的候选路径找、目录服务用全局 `fetch`）。
 */
export interface CreateModelRuntimeCompositionOptions {
  /** 环境变量快照；缺席时装配自己读一次 `process.env`。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** provider script 注册表的配置来源与宿主桥。 */
  readonly providerScripts?: ProviderScriptRegistryOptions
  /** 远端模型目录服务的 transport、超时与归属信息。 */
  readonly providerCatalog?: {
    /** 宿主注入的 fetch；缺席时用全局 fetch。 */
    readonly fetch?: typeof globalThis.fetch
    /** 一次目录请求的硬超时，毫秒；缺席时用包内可调参数表里的值。 */
    readonly timeoutMs?: number
    /** OpenRouter 的请求归属信息。 */
    readonly attribution?: ProviderModelCatalogAttribution
  }
  /** 宿主自带的适配器，排在内置适配器之前匹配。 */
  readonly adapters?: readonly ModelProviderAdapter[]
}

/**
 * provider script 注册表要什么。
 *
 * 全部可选：不给配置路径就按 `<cwd>/.velaros/dev.json` 与 `<home>/.velaros/dev.json` 找。
 */
export interface ProviderScriptRegistryOptions {
  /** 找配置文件的工作目录；缺席时用 `process.cwd()`。 */
  cwd?: string
  /** 找配置文件的用户目录；缺席时用 `os.homedir()`。 */
  homeDir?: string
  /** 配置文件候选路径，按顺序找到第一个存在的为准。 */
  configPaths?: readonly string[]
  /** 宿主桥；宿主还没注入时相关能力降级记账，不阻断加载。 */
  hostBridge?: Partial<ProviderScriptHostBridge>
  /** 加载前清不清 require 缓存；开发时改脚本要靠它生效。 */
  clearRequireCache?: boolean
  /** provider 脚本运行时元数据探测的宿主级硬上限，毫秒。 */
  runtimeMetadataTimeoutMs?: number
}

/**
 * 宿主桥：provider script 要开外链、要知道用户数据目录与应用版本时经它拿。
 *
 * 宿主在启动流程里注入；缺席时开外链只记一条警告，目录与版本回落到本地约定值。
 */
export interface ProviderScriptHostBridge {
  /** 用系统默认程序打开一个链接，OAuth 之类的登录流程要它。 */
  openExternal(url: string): Promise<void> | void
  /** 宿主的用户数据目录。 */
  getUserDataPath(): string
  /** 宿主应用的版本号。 */
  getAppVersion(): string
}

/** 挂进内核时要什么：产品自己的适配器注册表，内核不会去造也不会去发现一个。 */
export interface CreateModelKernelModuleOptions {
  /** 产品持有的模型适配器注册表，通常取自 `createModelRuntimeComposition(...).modelAdapterRegistry`。 */
  registry: ModelAdapterRegistryApi
}
import type { LanguageModel } from 'ai'

import type { ModelDriverLimits } from '../types/driver.js'

/** 供应商模型实例与窗口参数；驱动复用同一编码、预算和流式转换。 */
export interface AiSdkDriverOptions {
  /** 已由宿主配置好凭据和连接的供应商模型。 */
  readonly model: LanguageModel
  /** 模型记录中的稳定身份。 */
  readonly id: string
  /** 来自模型配置的输入、输出与总窗口上限。 */
  readonly limits: ModelDriverLimits
}

import type { ModelDriver as KernelModelDriver } from '@velaros-ai/kernel'

/** Model 适配器实现 Kernel 的唯一模型协议。 */
export interface ModelDriver extends KernelModelDriver {}
