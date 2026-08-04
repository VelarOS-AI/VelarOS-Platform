import { isBlank, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  getSharedProviderCatalog,
  type ProviderModelResolution,
  resolveProviderModelSelection,
  type SharedProviderCatalog,
} from './ModelCatalog'
import type {
  AgentProviderRuntimeConfig,
  ChatProviderId,
  ModelSelection,
  ProviderScriptManifest,
} from './ModelContracts'
import {
  getModelProviderOperationalManifest,
  type ModelProviderAdapterKind,
  type ModelProviderOperationalManifest,
  ModelProviderOperationalManifests,
} from './ProviderManifest'
import type { ProviderScriptRegistryPort } from './ProviderScriptRegistryPort'

export interface ModelProviderPreset extends ModelProviderOperationalManifest {
  modelSuggestions: string[]
  defaultModel: string
}

export interface ModelProviderAvailabilityOptions {
  env?: Readonly<Record<string, string | undefined>>
  supportsProvider?: (provider: ChatProviderId) => boolean
}

export interface ModelProviderConfiguredInput extends ModelProviderAvailabilityOptions {
  runtimeConfig: AgentProviderRuntimeConfig
  providerRuntimeConfigs?: readonly AgentProviderRuntimeConfig[]
  apiKeyOverride?: LooseOptional<string>
}

export interface ModelProviderCollectionOptions {
  /**
   * Host-owned environment values used for API-key fallback.
   *
   * Browser and worker hosts should pass only the values they intentionally
   * expose. The portable collection never reads a process-global environment.
   */
  environment?: Readonly<Record<string, string | undefined>>
}

/**
 * Explicit provider collection owned by one product composition.
 *
 * Static built-ins are immutable module data. Injected provider scripts are
 * read only through this instance's registry, so one composition can never
 * become another composition's implicit provider fallback.
 */
export class ModelProviderCollection {
  private readonly environment: Readonly<Record<string, string | undefined>>

  constructor(
    private readonly providerScripts: ProviderScriptRegistryPort,
    options: ModelProviderCollectionOptions = {}
  ) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
  }

  public listOperationalManifests(): ModelProviderOperationalManifest[] {
    return [
      ...ModelProviderOperationalManifests,
      ...this.providerScripts.listProviderManifests().map((manifest) =>
        this.createScriptOperationalManifest(manifest)
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
    const builtIn = getModelProviderOperationalManifest(provider)
    if (builtIn) return builtIn

    const script = this.providerScripts.getProviderScript(provider)
    if (script) return this.createScriptOperationalManifest(script.manifest)

    throw new AppError('VALIDATION', `未知模型 provider：${provider}`)
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

    const manifest = getModelProviderOperationalManifest(provider)
    const catalog = getSharedProviderCatalog(provider)
    if (!manifest || !catalog) {
      throw new AppError('VALIDATION', `未知模型 provider：${provider}`)
    }
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
      return resolveProviderModelSelection(provider, currentModel)
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

    throw new AppError(
      'VALIDATION',
      `${manifest.label} 的 API Key 未配置，请在产品模型设置中补充。`
    )
  }

  public resolveBaseURL(selection: Pick<ModelSelection, 'baseURL' | 'provider'>): string {
    const raw = isBlank(selection.baseURL)
      ? this.requireOperationalManifest(selection.provider).defaultBaseURL
      : selection.baseURL
    const trimmed = raw.trim()
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
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

  private createScriptOperationalManifest(
    manifest: ProviderScriptManifest
  ): ModelProviderOperationalManifest {
    return {
      id: manifest.id,
      label: manifest.label,
      description: manifest.description,
      defaultBaseURL: manifest.defaultBaseURL,
      defaultApiKey: manifest.defaultApiKey,
      apiKeyOptional: manifest.apiKeyOptional,
      baseURLConfigurable: manifest.baseURLConfigurable,
      enabledByDefault: manifest.enabledByDefault,
      adapterKind: 'provider-script',
      validationKind: 'provider-script',
      providerScript: manifest,
    }
  }
}
