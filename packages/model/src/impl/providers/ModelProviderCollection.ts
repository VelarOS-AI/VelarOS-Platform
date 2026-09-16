import { isBlank, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, ModelProviderOperationalManifests } from '../../contract/constants.js'
import type {
  AgentProviderRuntimeConfig,
  ChatProviderId,
  ModelProviderAdapterKind,
  ModelProviderOperationalManifest,
  ModelProviderPreset,
  ModelSelection,
  ProviderModelResolution,
} from '../../types/model'
import type { ModelProviderConfiguredInput, SharedProviderCatalog } from '../../types/providers'
import type { ProviderScriptRegistryPort } from '../../types/scripts'
import {
  isEmbeddingCapableManifest,
  resolveDefaultEmbeddingModel,
} from '../../utils/catalog/embedding'
import {
  asOperationalManifests,
  createScriptOperationalManifest,
} from '../../utils/catalog/manifests'
import {
  getSharedProviderCatalogOrNull,
  resolveSharedProviderModelSelection,
} from '../../utils/catalog/model-selection'
import { trimTrailingPathSeparators } from '../../utils/urls'



/** 一个产品装配独占的 provider 集合要什么。 */
export interface ModelProviderCollectionOptions {
  /**
   * 宿主给的环境变量，用来回落 API Key。
   *
   * 浏览器与 worker 宿主只传自己愿意暴露的值；可移植的集合永远不会去发现进程级环境。
   */
  environment?: Readonly<Record<string, string | undefined>>
}

/**
 * 一个产品装配独占的 provider 集合。
 *
 * 内置 provider 是不可变的模块数据；注入的 provider script 只经本实例持有的注册表读，
 * 所以一个装配永远不会变成另一个装配的隐式 provider 兜底。
 */
export interface ModelProviderCollectionApi {
  /** 列出全部运营清单：内置的加上本装配注入的 provider script。 */
  listOperationalManifests(): ModelProviderOperationalManifest[]
  /** 列出全部预设：运营清单加上静态目录算出来的建议模型与缺省模型。 */
  listPresets(): ModelProviderPreset[]
  /** 取一个 provider 的运营清单；不认识这个 provider 就抛。 */
  requireOperationalManifest(provider: ChatProviderId): ModelProviderOperationalManifest
  /** 取用某一种适配器的全部 provider id；装配适配器时按它分配。 */
  getProviderIdsByAdapterKind(adapterKind: ModelProviderAdapterKind): ChatProviderId[]
  /** 取一个 provider 的目录；不认识这个 provider 就抛。 */
  requireCatalog(provider: ChatProviderId): SharedProviderCatalog
  /** 在同一个 provider 内选一个可用模型，并说明有没有发生回退。 */
  resolveModelSelection(provider: ChatProviderId, currentModel?: string): ProviderModelResolution
  /** 在同一个 provider 内选一个可用模型，只要结果。 */
  resolveModel(provider: ChatProviderId, currentModel?: string): string
  /** 这个 provider 的 API Key 环境变量名；没有约定就返回空串。 */
  getApiKeyEnvironmentName(provider: ChatProviderId): string
  /** 取这次调用要用的 API Key：selection 里写了就用它，否则读登记的环境变量。 */
  resolveApiKey(
    selection: Pick<ModelSelection, 'apiKey' | 'provider'>,
    env?: Readonly<Record<string, string | undefined>>
  ): string
  /** 取这次调用必需的 API Key；这个 provider 要 key 却拿不到时按 credentialMissing 抛。 */
  requireApiKey(
    selection: Pick<ModelSelection, 'apiKey' | 'provider'>,
    env?: Readonly<Record<string, string | undefined>>
  ): string
  /** 取这次调用的 baseURL：selection 里写了就用它，否则用清单里的缺省地址；末尾分隔符一律去掉。 */
  resolveBaseURL(selection: Pick<ModelSelection, 'baseURL' | 'provider'>): string
  /** 这个 provider 的缺省运行时配置，产品首次配置照着它建。 */
  getDefaultRuntimeConfig(provider: ChatProviderId): AgentProviderRuntimeConfig
  /** 把产品存的运行时配置补齐成"每个 provider 一条"，缺的字段用缺省值兜。 */
  normalizeRuntimeConfigs(
    runtimeConfigs: readonly AgentProviderRuntimeConfig[]
  ): AgentProviderRuntimeConfig[]
  /** 在一批运行时配置里找某个 provider 那条；没有就返回 null。 */
  findRuntimeConfig(
    runtimeConfigs: readonly AgentProviderRuntimeConfig[],
    provider: ChatProviderId
  ): Nullable<AgentProviderRuntimeConfig>
  /** 这条运行时配置算不算"配好了"：启用、有适配器、凭据齐（或这个 provider 不要凭据）。 */
  isRuntimeConfigured(input: ModelProviderConfiguredInput): boolean
  /** 这个 provider 的默认 embedding 模型；没有就返回空串。 */
  defaultEmbeddingModel(provider: ChatProviderId): string
  /** 这个 provider 的适配器能不能造 embedding 请求。 */
  isEmbeddingCapable(provider: ChatProviderId): boolean
}

export class ModelProviderCollection implements ModelProviderCollectionApi {
  private readonly environment: Readonly<Record<string, string | undefined>>

  constructor(
    private readonly providerScripts: ProviderScriptRegistryPort,
    options: ModelProviderCollectionOptions = {}
  ) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
  }

  public listOperationalManifests(): ModelProviderOperationalManifest[] {
    return [
      ...asOperationalManifests(ModelProviderOperationalManifests),
      ...this.providerScripts.listProviderManifests().map((manifest) =>
        createScriptOperationalManifest(manifest)
      ),
    ]
  }

  public listPresets(): ModelProviderPreset[] {
    return this.listOperationalManifests().map((manifest) => {
      const catalog = this.requireCatalog(manifest.id)
      return {
        ...manifest,
        modelSuggestions: catalog.models.map((model) => model.id),
        defaultModel: catalog.defaultModel,
      }
    })
  }

  public requireOperationalManifest(provider: ChatProviderId): ModelProviderOperationalManifest {
    const builtIn = asOperationalManifests(ModelProviderOperationalManifests).find(
      (manifest) => manifest.id === provider
    )
    if (builtIn) return builtIn

    const script = this.providerScripts.getProviderScript(provider)
    if (script) return createScriptOperationalManifest(script.manifest)

    throw new AppError(ModelErrorCodes.providerUnknown, `未知模型 provider：${provider}`)
  }

  public getProviderIdsByAdapterKind(
    adapterKind: ModelProviderAdapterKind
  ): ChatProviderId[] {
    return this.listOperationalManifests()
      .filter((manifest) => manifest.adapterKind === adapterKind)
      .map((manifest) => manifest.id)
  }

  public requireCatalog(provider: ChatProviderId): SharedProviderCatalog {
    const script = this.providerScripts.getProviderScript(provider)
    if (script) return {
        provider,
        defaultModel: script.manifest.defaultModel,
        models: script.manifest.models.map((model) => ({
          id: model.id,
          contextWindow: model.contextWindow,
          inputModalities: model.inputModalities,
        })),
      }

    const catalog = getSharedProviderCatalogOrNull(provider)
    if (!catalog) {
      throw new AppError(ModelErrorCodes.providerUnknown, `未知模型 provider：${provider}`)
    }
    this.requireOperationalManifest(provider)
    return {
      provider: catalog.provider,
      defaultModel: catalog.defaultModel,
      models: catalog.models.map((model) => ({ ...model })),
    }
  }

  public resolveModelSelection(
    provider: ChatProviderId,
    currentModel?: string
  ): ProviderModelResolution {
    const script = this.providerScripts.getProviderScript(provider)
    if (!script) {
      this.requireOperationalManifest(provider)
      return resolveSharedProviderModelSelection(provider, currentModel)
    }

    const requestedModel = currentModel?.trim() ?? ''
    const models = script.manifest.models.map((model) => model.id)
    if (requestedModel && models.includes(requestedModel)) return { model: requestedModel, didFallback: false }

    return {
      model: script.manifest.defaultModel,
      didFallback:
        requestedModel.length > 0 && requestedModel !== script.manifest.defaultModel,
    }
  }

  public resolveModel(provider: ChatProviderId, currentModel?: string): string {
    return this.resolveModelSelection(provider, currentModel).model
  }

  public getApiKeyEnvironmentName(provider: ChatProviderId): string {
    return this.requireOperationalManifest(provider).defaultApiKeyEnv ?? ''
  }

  public resolveApiKey(
    selection: Pick<ModelSelection, 'apiKey' | 'provider'>,
    env: Readonly<Record<string, string | undefined>> = this.environment
  ): string {
    if (!isBlank(selection.apiKey)) return selection.apiKey

    const envName = this.getApiKeyEnvironmentName(selection.provider)
    return envName ? env[envName] ?? '' : ''
  }

  public requireApiKey(
    selection: Pick<ModelSelection, 'apiKey' | 'provider'>,
    env: Readonly<Record<string, string | undefined>> = this.environment
  ): string {
    const apiKey = this.resolveApiKey(selection, env)
    if (!isBlank(apiKey)) return apiKey

    const manifest = this.requireOperationalManifest(selection.provider)
    if (manifest.apiKeyOptional) return ''

    // 判据与文案都收在这一处：同一个"缺 key"以前在适配器基类里还有一份，两句话不一样，
    // 产品按文字分支时会漏掉其中一条。现在只有这一句，并且带 credentialMissing 码。
    throw new AppError(
      ModelErrorCodes.credentialMissing,
      `${manifest.label} 的 API Key 未配置，请在产品模型设置中补充。`
    )
  }

  public resolveBaseURL(selection: Pick<ModelSelection, 'baseURL' | 'provider'>): string {
    const raw = isBlank(selection.baseURL)
      ? this.requireOperationalManifest(selection.provider).defaultBaseURL
      : selection.baseURL

    return trimTrailingPathSeparators(raw)
  }

  public getDefaultRuntimeConfig(provider: ChatProviderId): AgentProviderRuntimeConfig {
    const manifest = this.requireOperationalManifest(provider)
    const catalog = this.requireCatalog(provider)
    return {
      provider,
      enabled: manifest.enabledByDefault ?? true,
      apiKey: manifest.defaultApiKey ?? '',
      baseURL: manifest.defaultBaseURL,
      defaultModel: catalog.defaultModel,
      providerScript: manifest.providerScript,
    }
  }

  public normalizeRuntimeConfigs(
    runtimeConfigs: readonly AgentProviderRuntimeConfig[]
  ): AgentProviderRuntimeConfig[] {
    const byProvider = new Map(runtimeConfigs.map((config) => [config.provider, config]))
    return this.listOperationalManifests().map((manifest) => ({
      ...this.getDefaultRuntimeConfig(manifest.id),
      ...byProvider.get(manifest.id),
    }))
  }

  public findRuntimeConfig(
    runtimeConfigs: readonly AgentProviderRuntimeConfig[],
    provider: ChatProviderId
  ): Nullable<AgentProviderRuntimeConfig> {
    return toNullable(
      this.normalizeRuntimeConfigs(runtimeConfigs).find(
        (config) => config.provider === provider
      )
    )
  }

  public isRuntimeConfigured(input: ModelProviderConfiguredInput): boolean {
    const {
      runtimeConfig,
      providerRuntimeConfigs = [],
      apiKeyOverride,
      env = this.environment,
      supportsProvider,
    } = input
    if (!runtimeConfig.enabled) return false
    if (supportsProvider && !supportsProvider(runtimeConfig.provider)) return false

    const config =
      this.findRuntimeConfig(providerRuntimeConfigs, runtimeConfig.provider)
      ?? runtimeConfig
    const manifest = this.requireOperationalManifest(runtimeConfig.provider)
    if (manifest.adapterKind === 'custom-js') return !isBlank(config.adapter?.source ?? runtimeConfig.adapter?.source ?? '')
    if (manifest.apiKeyOptional) return true
    if (!isBlank(apiKeyOverride ?? '')) return true
    if (!isBlank(runtimeConfig.apiKey)) return true
    if (!isBlank(config.apiKey)) return true

    const envName = this.getApiKeyEnvironmentName(runtimeConfig.provider)
    return !isBlank(envName ? env[envName] ?? '' : '')
  }

  public defaultEmbeddingModel(provider: ChatProviderId): string {
    return resolveDefaultEmbeddingModel(this.requireOperationalManifest(provider), provider)
  }

  public isEmbeddingCapable(provider: ChatProviderId): boolean {
    return isEmbeddingCapableManifest(this.requireOperationalManifest(provider))
  }
}
