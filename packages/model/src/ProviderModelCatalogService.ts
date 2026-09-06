import {
  isArray,
  isBlank,
  isEmpty,
  isPlainObject,
  isString,
  optionalWhen,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  filterEmbeddingModelCandidates,
  resolveDefaultEmbeddingModelForProvider,
} from './EmbeddingModelSelection'
import { resolveModelContextWindow } from './ModelCatalog'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ModelInputModality,
  ProviderModelCatalog,
  ProviderModelCatalogEntry,
} from './ModelContracts'
import type { ModelProviderCollection, ModelProviderPreset } from './ModelProviderCollection'
import type { ModelProviderValidationKind } from './ProviderManifest'
import type { ProviderScriptRegistryPort } from './ProviderScriptRegistryPort'

interface ProviderModelListRequest {
  readonly url: string
  readonly headers: ReadonlyArray<[string, string]>
}

interface RemoteProviderModelEntry {
  readonly id: string
  readonly label?: string
  readonly contextWindow?: number
  readonly inputModalities?: readonly ModelInputModality[]
}

export interface ProviderModelCatalogAttribution {
  /** OpenRouter HTTP-Referer value supplied by the host product. */
  readonly referer?: string
  /** OpenRouter X-Title value supplied by the host product. */
  readonly title?: string
}

export interface ProviderModelCatalogServiceOptions {
  readonly providerCollection: ModelProviderCollection
  /** Required only when the product composition exposes provider scripts. */
  readonly providerScriptRegistry?: ProviderScriptRegistryPort
  /** Host-injected transport keeps tests and non-browser runtimes explicit. */
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
  readonly attribution?: ProviderModelCatalogAttribution
}

const DefaultProviderModelCatalogTimeoutMs = 15_000

/**
 * Provider-neutral dynamic model discovery.
 *
 * Provider endpoint shapes, authentication headers and response parsing belong to the Model
 * domain. Products own when discovery runs, where credentials are stored, and how the resulting
 * catalog is projected through their IPC and UI boundaries.
 */
export class ProviderModelCatalogService {
  private readonly providerCollection: ModelProviderCollection
  private readonly providerScriptRegistry?: ProviderScriptRegistryPort
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly attribution: ProviderModelCatalogAttribution

  public constructor(options: ProviderModelCatalogServiceOptions) {
    this.providerCollection = options.providerCollection
    this.providerScriptRegistry = options.providerScriptRegistry
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DefaultProviderModelCatalogTimeoutMs)
    this.attribution = options.attribution ?? {}
  }

  public async listProviderModels(
    request: ListProviderModelsRequest,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalog> {
    const fetchedAt = Date.now()
    const preset = this.getProviderPreset(request.provider)
    const resolvedRequest = {
      ...request,
      apiKey: this.providerCollection.resolveApiKey(request),
    }

    if (preset.validationKind === 'provider-script')
      return this.listProviderScriptModels(resolvedRequest, preset, fetchedAt)

    if (!this.canListRemoteProviderModels(preset.validationKind))
      return this.createPresetCatalog(request.provider, fetchedAt, request.purpose)

    if (
      isBlank(resolvedRequest.apiKey)
      && !preset.apiKeyOptional
      && preset.validationKind !== 'openrouter-key'
    )
      return this.createEmptyRemoteCatalog(
        request.provider,
        fetchedAt,
        `${preset.label} API Key 未配置。`
      )

    const baseURL = this.providerCollection.resolveBaseURL({
      provider: request.provider,
      baseURL: request.baseURL,
    })

    try {
      const remoteModels = await this.listRemoteProviderModels(
        resolvedRequest,
        baseURL,
        preset.validationKind,
        signal
      )
      return {
        provider: request.provider,
        source: 'remote',
        models: this.filterModelsForPurpose(request.purpose, remoteModels),
        fetchedAt,
      }
    } catch (error) {
      return this.createEmptyRemoteCatalog(
        request.provider,
        fetchedAt,
        AppError.getMessage(error)
      )
    }
  }

  private getProviderPreset(provider: ChatProviderId): ModelProviderPreset {
    const preset = this.providerCollection
      .listPresets()
      .find((candidate) => candidate.id === provider)
    if (preset) return preset

    this.providerCollection.requireOperationalManifest(provider)
    throw new AppError('VALIDATION', `未知模型 provider：${provider}`)
  }

  private canListRemoteProviderModels(validationKind: ModelProviderValidationKind): boolean {
    return (
      validationKind === 'openrouter-key'
      || validationKind === 'openai-compatible-models'
      || validationKind === 'anthropic-models'
      || validationKind === 'google-models'
    )
  }

  private async listProviderScriptModels(
    request: ListProviderModelsRequest,
    preset: ModelProviderPreset,
    fetchedAt: number
  ): Promise<ProviderModelCatalog> {
    if (!this.providerScriptRegistry?.supportsProvider(request.provider))
      return this.createEmptyRemoteCatalog(
        request.provider,
        fetchedAt,
        `${preset.label} provider script 未注入。`
      )

    try {
      const models = await this.providerScriptRegistry.listProviderModels({
        ...request,
        baseURL: this.providerCollection.resolveBaseURL(request),
      })
      if (isEmpty(models))
        return this.createPresetCatalog(request.provider, fetchedAt, request.purpose)

      return {
        provider: request.provider,
        source: 'remote',
        models: this.filterModelsForPurpose(
          request.purpose,
          this.normalizeModels(request.provider, models)
        ),
        fetchedAt,
      }
    } catch (error) {
      return this.createEmptyRemoteCatalog(
        request.provider,
        fetchedAt,
        AppError.getMessage(error)
      )
    }
  }

  private async listRemoteProviderModels(
    request: ListProviderModelsRequest,
    baseURL: string,
    validationKind: ModelProviderValidationKind,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalogEntry[]> {
    const listRequest = this.createProviderModelListRequest(request, baseURL, validationKind)
    const response = await this.fetchWithTimeout(listRequest, signal)
    if (!response.ok) {
      const responseText = (await response.text()).trim()
      throw new AppError(
        'NETWORK',
        this.normalizeProviderErrorMessage(request.provider, response.status, responseText)
      )
    }

    return this.parseRemoteProviderModels(
      request.provider,
      validationKind,
      await response.json()
    )
  }

  private async fetchWithTimeout(
    request: ProviderModelListRequest,
    signal?: AbortSignal
  ): Promise<Response> {
    const timers = new TimerScope({ name: 'ProviderModelCatalogService' })
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()
    const timeout = timers.after(
      this.timeoutMs,
      () => controller.abort(new Error('Provider model catalog request timed out.')),
      { unref: true }
    )

    try {
      const headers = new Headers()
      for (const [name, value] of request.headers) headers.append(name, value)
      return await this.fetch(request.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new AppError('TIMEOUT', '模型列表请求超时')
      }
      throw error
    } finally {
      timeout.cancel()
      signal?.removeEventListener('abort', forwardAbort)
      timers.dispose()
    }
  }

  private createProviderModelListRequest(
    request: ListProviderModelsRequest,
    baseURL: string,
    validationKind: ModelProviderValidationKind
  ): ProviderModelListRequest {
    switch (validationKind) {
      case 'anthropic-models':
        return {
          url: this.appendPath(baseURL, 'models'),
          headers: [
            ['Content-Type', 'application/json'],
            ['anthropic-version', '2023-06-01'],
            ['x-api-key', request.apiKey],
          ],
        }

      case 'google-models': {
        const url = new URL(this.appendPath(baseURL, 'models'))
        url.searchParams.set('key', request.apiKey)
        url.searchParams.set('pageSize', '1000')
        return {
          url: url.toString(),
          headers: [['Content-Type', 'application/json']],
        }
      }

      case 'openrouter-key':
        return {
          url: this.appendPath(baseURL, 'models'),
          headers: [
            ...this.optionalBearerHeader(request.apiKey),
            ['Content-Type', 'application/json'],
            ...this.optionalHeader('HTTP-Referer', this.attribution.referer),
            ...this.optionalHeader('X-Title', this.attribution.title),
          ],
        }

      case 'openai-compatible-models':
      default:
        return {
          url: this.appendPath(baseURL, 'models'),
          headers: [
            ...this.optionalBearerHeader(request.apiKey),
            ['Content-Type', 'application/json'],
          ],
        }
    }
  }

  private appendPath(baseURL: string, path: string): string {
    let end = baseURL.length
    while (end > 0 && baseURL[end - 1] === '/') end -= 1
    const url = new URL(`${baseURL.slice(0, end)}/${path}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('VALIDATION', `模型目录地址协议不受支持：${url.protocol}`)
    }
    return url.toString()
  }

  private optionalBearerHeader(apiKey: string): Array<[string, string]> {
    return isBlank(apiKey) ? [] : [['Authorization', `Bearer ${apiKey}`]]
  }

  private optionalHeader(name: string, value?: string): Array<[string, string]> {
    const normalized = value?.trim() ?? ''
    return normalized ? [[name, normalized]] : []
  }

  private parseRemoteProviderModels(
    provider: ChatProviderId,
    validationKind: ModelProviderValidationKind,
    payload: unknown
  ): ProviderModelCatalogEntry[] {
    return this.normalizeModels(provider, this.readRemoteModelEntries(validationKind, payload))
  }

  private readRemoteModelEntries(
    validationKind: ModelProviderValidationKind,
    payload: unknown
  ): RemoteProviderModelEntry[] {
    if (!isPlainObject(payload)) return []

    if (validationKind === 'google-models')
      return isArray(payload.models)
        ? payload.models.flatMap((item): RemoteProviderModelEntry[] => {
            if (!isPlainObject(item)) return []
            const rawName = isString(item.name) ? item.name : ''
            const id = rawName.startsWith('models/')
              ? rawName.slice('models/'.length)
              : rawName
            if (!id.trim()) return []
            return [
              {
                id,
                label: optionalWhen(isString, item.displayName),
              },
            ]
          })
        : []

    return isArray(payload.data)
      ? payload.data.flatMap((item): RemoteProviderModelEntry[] => {
          if (!isPlainObject(item) || !isString(item.id) || !item.id.trim()) return []
          const architecture = isPlainObject(item.architecture) ? item.architecture : null
          const inputModalities =
            architecture && isArray(architecture.input_modalities)
              ? architecture.input_modalities.filter(this.isModelInputModality)
              : null
          return [
            {
              id: item.id,
              ...(isString(item.display_name)
                ? { label: item.display_name }
                : isString(item.displayName)
                  ? { label: item.displayName }
                  : isString(item.name)
                    ? { label: item.name }
                    : {}),
              ...(inputModalities?.length ? { inputModalities } : {}),
            },
          ]
        })
      : []
  }

  private normalizeModels(
    provider: ChatProviderId,
    values: ReadonlyArray<RemoteProviderModelEntry | ProviderModelCatalogEntry>
  ): ProviderModelCatalogEntry[] {
    const seen = new Set<string>()
    const models: ProviderModelCatalogEntry[] = []

    for (const value of values) {
      const id = value.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const presetModel = this.getProviderPreset(provider).providerScript?.models.find(
        (candidate) => candidate.id === id
      )
      models.push({
        id,
        label: value.label?.trim() || presetModel?.label || id,
        contextWindow: value.contextWindow ?? resolveModelContextWindow(id),
        ...(value.inputModalities?.length
          ? { inputModalities: value.inputModalities }
          : presetModel?.inputModalities?.length
            ? { inputModalities: presetModel.inputModalities }
            : {}),
      })
    }

    return models
  }

  private filterModelsForPurpose(
    purpose: ListProviderModelsRequest['purpose'],
    models: ProviderModelCatalogEntry[]
  ): ProviderModelCatalogEntry[] {
    if (purpose !== 'embedding') return models
    const embeddingIds = new Set(filterEmbeddingModelCandidates(models.map((model) => model.id)))
    return models.filter((model) => embeddingIds.has(model.id))
  }

  private createPresetCatalog(
    provider: ChatProviderId,
    fetchedAt: number,
    purpose: ListProviderModelsRequest['purpose'] = 'chat'
  ): ProviderModelCatalog {
    const preset = this.getProviderPreset(provider)
    const values = purpose === 'embedding'
      ? [
          resolveDefaultEmbeddingModelForProvider(this.providerCollection, provider),
          ...preset.modelSuggestions,
        ]
      : preset.modelSuggestions
    return {
      provider,
      source: 'preset',
      models: this.filterModelsForPurpose(
        purpose,
        this.normalizeModels(provider, values.map((id) => ({ id })))
      ),
      fetchedAt,
    }
  }

  private createEmptyRemoteCatalog(
    provider: ChatProviderId,
    fetchedAt: number,
    error: string
  ): ProviderModelCatalog {
    return {
      provider,
      source: 'remote',
      models: [],
      fetchedAt,
      error,
    }
  }

  private normalizeProviderErrorMessage(
    provider: ChatProviderId,
    status: number,
    rawText: string
  ): string {
    const preset = this.getProviderPreset(provider)
    const text = rawText.trim()
    let message = text

    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string }
        message?: string
      }
      message = parsed.error?.message || parsed.message || text
    } catch {
      // arch-guard:silent-catch-ok Provider 错误正文允许是纯文本或 HTML；下方仍会归一化并返回明确错误。
    }

    if (
      status === 401
      || /missing authentication header|invalid api key|authentication/iu.test(message)
    )
      return `${preset.label} API Key 不可用`
    return message ? message.slice(0, 160) : `HTTP ${status}`
  }

  private readonly isModelInputModality = (value: unknown): value is ModelInputModality =>
    value === 'text' || value === 'image' || value === 'audio'
}
