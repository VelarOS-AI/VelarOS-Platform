import { toNullable } from '@velaros-ai/core'

import { ModelProviderOperationalManifests } from '../../contract/constants.js'
import type { ModelEnvironmentPort } from '../../contract/requires'
import type {
  ChatProviderId,
  ModelProviderOperationalManifest,
  ProviderModelResolution,
  ProviderScriptRuntimeMetadata,
} from '../../types/model'
import type { SharedProviderCatalog } from '../../types/providers'
import {
  resolveProviderModelContextWindow,
  resolveProviderScriptContextWindow,
  resolveProviderScriptMetadataContextWindow,
} from '../../utils/catalog/context-windows'
import {
  filterVisibleProviderModels,
  getSharedProviderCatalogOrNull,
  isOpenRouterCompatibleProvider,
  listSharedProviderModels,
  listSharedProviderSuggestedModels,
  resolveSharedProviderModelSelection,
} from '../../utils/catalog/model-selection'

import { LocalModelEnvironment } from './LocalModelEnvironment'

/**
 * 内置 provider 的静态目录与选型规则，外加本机 Ollama 的地址与模型解析。
 *
 * 这一份是**可移植**的：整条引用链不碰 Node 内置模块，渲染进程经 `./catalog` 入口直接加载。
 * 要读环境变量的三个 Ollama 方法都收一个可选的 `ModelEnvironmentPort`——本类自己从不去摸
 * `process.env` 或浏览器全局，谁要给值谁传进来。实例是 `modelCatalog`。
 */
export interface ModelCatalogApi {
  /** 取一个内置 provider 的运营清单；不是内置 provider 时返回 null。 */
  manifest(providerId: ChatProviderId): Nullable<ModelProviderOperationalManifest>
  /** 取一个 provider 的静态目录；没有这个 provider 时返回 null。 */
  catalog(providerId: ChatProviderId): Nullable<SharedProviderCatalog>
  /** 这个 provider 静态目录里的全部模型 id。 */
  models(providerId: ChatProviderId): string[]
  /** 这个 provider 推荐给用户看的模型。 */
  suggestedModels(providerId: ChatProviderId): string[]
  /** 一份模型清单在某个 provider 下的可见子集。 */
  visibleModels(providerId: ChatProviderId, models: string[]): string[]
  /** 在同一个 provider 内选一个可用模型，并说明有没有发生回退。 */
  resolveModelSelection(
    providerId: ChatProviderId,
    currentModel?: string
  ): ProviderModelResolution
  /** 在同一个 provider 内选一个可用模型，只要结果。 */
  resolveModel(providerId: ChatProviderId, currentModel?: string): string
  /** 这个 provider 走不走 OpenRouter 的路由语义。 */
  isOpenRouterCompatible(providerId: ChatProviderId): boolean
  /** 按 provider 实际选中的模型查已知上下文窗口；查不到返回 null，由调用方保留自己的安全回退值。 */
  contextWindow(provider: string, model: string): Nullable<number>
  /** 只提取 provider script 运行时明确声明的窗口，不把静态查表或默认估计升级成 metadata。 */
  scriptMetadataContextWindow(
    metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
  ): number | undefined
  /** 显式运行时窗口优先于当前鉴权作用域目录；缺失时再按具体 provider/model 静态查表。 */
  scriptContextWindow(input: {
    providerId: ChatProviderId
    runtimeModel: string
    metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
    catalogContextWindow?: number
  }): number | undefined
  /** 本机 Ollama 的服务地址；返回值一定带 `/v1`。环境变量由 `environment` 给，不给就只认缺省值。 */
  resolveOllamaBaseURL(defaultBaseURL: string, environment?: ModelEnvironmentPort): string
  /** 本机 Ollama 的聊天模型名；环境变量没给就用调用方的缺省值。 */
  resolveOllamaChatModel(defaultModel?: string, environment?: ModelEnvironmentPort): string
  /** 本机 Ollama 的上下文窗口；环境变量与缺省值都没有时返回 null。 */
  resolveOllamaContextWindow(
    defaultContextWindow?: number,
    environment?: ModelEnvironmentPort
  ): Nullable<number>
  /** 本机 Ollama 在界面上可见的模型：环境变量里的那个加上当前选中的那个，去重。 */
  resolveOllamaVisibleChatModels(
    defaultModel?: string,
    selectedModel?: string,
    environment?: ModelEnvironmentPort
  ): string[]
}

export class ModelCatalog implements ModelCatalogApi {
  public manifest(providerId: ChatProviderId): Nullable<ModelProviderOperationalManifest> {
    return toNullable(
      ModelProviderOperationalManifests.find((manifest) => manifest.id === providerId)
    )
  }

  public catalog(providerId: ChatProviderId): Nullable<SharedProviderCatalog> {
    return getSharedProviderCatalogOrNull(providerId)
  }

  public models(providerId: ChatProviderId): string[] {
    return listSharedProviderModels(providerId)
  }

  public suggestedModels(providerId: ChatProviderId): string[] {
    return listSharedProviderSuggestedModels(providerId)
  }

  public visibleModels(providerId: ChatProviderId, models: string[]): string[] {
    return filterVisibleProviderModels(providerId, models)
  }

  public resolveModelSelection(
    providerId: ChatProviderId,
    currentModel?: string
  ): ProviderModelResolution {
    return resolveSharedProviderModelSelection(providerId, currentModel)
  }

  public resolveModel(providerId: ChatProviderId, currentModel?: string): string {
    return resolveSharedProviderModelSelection(providerId, currentModel).model
  }

  public isOpenRouterCompatible(providerId: ChatProviderId): boolean {
    return isOpenRouterCompatibleProvider(providerId)
  }

  public contextWindow(provider: string, model: string): Nullable<number> {
    return resolveProviderModelContextWindow(provider, model)
  }

  public scriptMetadataContextWindow(
    metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
  ): number | undefined {
    return resolveProviderScriptMetadataContextWindow(metadata)
  }

  public scriptContextWindow(input: {
    providerId: ChatProviderId
    runtimeModel: string
    metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
    catalogContextWindow?: number
  }): number | undefined {
    return resolveProviderScriptContextWindow(input)
  }

  public resolveOllamaBaseURL(
    defaultBaseURL: string,
    environment?: ModelEnvironmentPort
  ): string {
    return new LocalModelEnvironment({}, environment).resolveOllamaBaseURL(defaultBaseURL)
  }

  public resolveOllamaChatModel(
    defaultModel = '',
    environment?: ModelEnvironmentPort
  ): string {
    return new LocalModelEnvironment({}, environment).resolveOllamaChatModel(defaultModel)
  }

  public resolveOllamaContextWindow(
    defaultContextWindow?: number,
    environment?: ModelEnvironmentPort
  ): Nullable<number> {
    return new LocalModelEnvironment({}, environment).resolveOllamaContextWindow(defaultContextWindow)
  }

  public resolveOllamaVisibleChatModels(
    defaultModel = '',
    selectedModel = '',
    environment?: ModelEnvironmentPort
  ): string[] {
    return new LocalModelEnvironment({}, environment).resolveOllamaVisibleChatModels(defaultModel, selectedModel)
  }
}

/** 整个进程共用的模型目录；渲染进程经 `./catalog` 入口拿到的就是它。 */
export const modelCatalog: ModelCatalogApi = new ModelCatalog()
