import { isBlank, isEmpty, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ProviderModelCatalogAttribution } from '../../contract/requires'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ModelProviderPreset,
  ModelProviderValidationKind,
  ProviderModelCatalog,
  ProviderModelCatalogEntry,
  ValidateProviderRuntimeRequest,
} from '../../types/model'
import type { RemoteProviderModelEntry } from '../../types/providers'
import type { ProviderScriptRegistryPort } from '../../types/scripts'
import { resolveProviderModelContextWindow } from '../../utils/catalog/context-windows'
import { filterModelsForPurpose } from '../../utils/catalog/embedding'
import {
  canListRemoteProviderModels,
  createEmptyRemoteCatalog,
  createProviderModelListRequest,
  createProviderValidationRequest,
  normalizeProviderErrorMessage,
  readRemoteModelEntries,
} from '../../utils/catalog-http'
import { ModelTuning } from '../../utils/tuning'

import type { ModelProviderCollectionApi } from './ModelProviderCollection'
import { ProviderModelCatalogCache } from './ProviderModelCatalogCache'

/** 建目录服务要什么：provider 集合必给，其余按宿主能力注入。 */
export interface ProviderModelCatalogServiceOptions {
  /** 本装配的 provider 集合。 */
  readonly providerCollection: ModelProviderCollectionApi
  /** 只有暴露 provider script 的装配才要传。 */
  readonly providerScriptRegistry?: ProviderScriptRegistryPort
  /** 宿主注入的 transport，让测试与非浏览器运行时都显式。 */
  readonly fetch?: typeof globalThis.fetch
  /** 一次目录或凭据探测的硬超时，毫秒，包含响应正文读取。 */
  readonly timeoutMs?: number
  /** OpenRouter 的请求归属信息。 */
  readonly attribution?: ProviderModelCatalogAttribution
}

/**
 * provider 无关的动态模型发现。
 *
 * provider 的端点形状、鉴权头与响应解析属于 model 域；
 * 什么时候发现、凭据存哪、目录怎么投影到 IPC 与界面，是产品的事。
 * 一个装配只有一份，缓存、归属与失效都跟着这一份走。
 */
export interface ProviderModelCatalogApi {
  /** 按远端协议或供应商脚本验证凭据；缺密钥不请求网络，专用运行时返回不支持直接探测。 */
  validateProviderRuntime(
    request: ValidateProviderRuntimeRequest
  ): Promise<{ ok: boolean; message: Nullable<string> }>
  /** 列出这个鉴权作用域下的模型；每次调用都强制刷新一次快照。 */
  listProviderModels(
    request: ListProviderModelsRequest,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalog>
  /** 取某个具体模型的能力；命中未过期的快照就不再发请求。 */
  resolveModelCapabilities(
    request: ListProviderModelsRequest & { model: string },
    signal?: AbortSignal
  ): Promise<ProviderModelCatalogEntry | undefined>
  /** 宿主更新目录来源后显式失效；不给请求就整张表清掉。 */
  invalidateProviderModels(request?: ListProviderModelsRequest): void
  /** 设置请求归属信息；不改变模型或鉴权作用域。 */
  setAttribution(attribution: ProviderModelCatalogAttribution): void
}

export class ProviderModelCatalogService implements ProviderModelCatalogApi {
  private readonly providerCollection: ModelProviderCollectionApi
  private readonly providerScriptRegistry?: ProviderScriptRegistryPort
  private readonly fetch: typeof globalThis.fetch
  private readonly timeoutMs: number
  private attribution: ProviderModelCatalogAttribution
  private readonly snapshots = new ProviderModelCatalogCache()
  private readonly scriptVersions = new WeakMap<object, number>()
  private nextScriptVersion = 1

  public constructor(options: ProviderModelCatalogServiceOptions) {
    this.providerCollection = options.providerCollection
    this.providerScriptRegistry = options.providerScriptRegistry
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = Math.max(1, options.timeoutMs ?? ModelTuning.catalog.requestTimeoutMs)
    this.attribution = options.attribution ?? {}
  }

  public async validateProviderRuntime(
    request: ValidateProviderRuntimeRequest
  ): Promise<{ ok: boolean; message: Nullable<string> }> {
    const preset = this.getProviderPreset(request.provider)
    if (
      !canListRemoteProviderModels(preset.validationKind) &&
      preset.validationKind !== 'provider-script'
    )
      return { ok: false, message: `${preset.label} 由专用运行时管理，请通过对应服务验证连接。` }
    const resolvedRequest = { ...request, apiKey: this.providerCollection.resolveApiKey(request) }
    if (isBlank(resolvedRequest.apiKey) && !preset.apiKeyOptional)
      return { ok: false, message: null }
    const baseURL = this.providerCollection.resolveBaseURL(request)
    const timers = new TimerScope({ name: 'ProviderRuntimeValidation' })
    try {
      return await timers.withTimeout(
        this.timeoutMs,
        async (signal) => {
          if (preset.validationKind === 'provider-script') {
            if (!this.providerScriptRegistry)
              return { ok: false, message: `${preset.label} provider script 未注入。` }
            return this.providerScriptRegistry.validateProviderRuntime({
              ...resolvedRequest,
              baseURL,
            })
          }
          const probe = createProviderValidationRequest(
            resolvedRequest,
            baseURL,
            preset.validationKind,
            this.attribution
          )
          const response = await this.fetch(probe.url, {
            method: 'GET',
            headers: [...probe.headers],
            signal,
          })
          if (response.ok) {
            await response.body?.cancel()
            return { ok: true, message: null }
          }
          return {
            ok: false,
            message: normalizeProviderErrorMessage(
              preset.label,
              response.status,
              await response.text()
            ),
          }
        },
        { label: `model.provider.validate:${request.provider}` }
      )
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      )
        return { ok: false, message: `${preset.label} 校验请求超时` }
      throw error
    } finally {
      timers.dispose()
    }
  }

  public async listProviderModels(
    request: ListProviderModelsRequest,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalog> {
    return this.loadCatalogSnapshot(request, true, signal)
  }

  /** 运行时与设置页复用同一份鉴权作用域目录，首次读取和过期后查询均可取消。 */
  public async resolveModelCapabilities(
    request: ListProviderModelsRequest & { model: string },
    signal?: AbortSignal
  ): Promise<ProviderModelCatalogEntry | undefined> {
    const catalog = await this.loadCatalogSnapshot(request, false, signal)
    return catalog.models.find((entry) => entry.id === request.model)
  }

  public invalidateProviderModels(request?: ListProviderModelsRequest): void {
    this.snapshots.invalidate(request ? this.createSnapshotKey(request) : undefined)
  }

  public setAttribution(attribution: ProviderModelCatalogAttribution): void {
    this.attribution = { ...attribution }
  }

  private createSnapshotKey(request: ListProviderModelsRequest): string {
    const script = this.providerScriptRegistry?.getProviderScript(request.provider)
    if (script && !this.scriptVersions.has(script)) {
      this.scriptVersions.set(script, this.nextScriptVersion++)
    }
    // 密钥参与精确隔离；私有缓存既不序列化也不输出这个键，避免弱 hash 碰撞串用能力。
    return JSON.stringify([
      request.provider,
      this.providerCollection.resolveBaseURL(request),
      this.providerCollection.resolveApiKey(request),
      toNullable(request.adapter),
      request.purpose ?? 'chat',
      request.defaultModel ?? '',
      script ? this.scriptVersions.get(script) : 0,
    ])
  }

  private loadCatalogSnapshot(
    request: ListProviderModelsRequest,
    refresh: boolean,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalog> {
    return this.snapshots.load(
      this.createSnapshotKey(request),
      async (operationSignal) => {
        const timers = new TimerScope({ name: 'ProviderModelCatalogSnapshot' })
        try {
          return await timers.withTimeout(
            this.timeoutMs,
            (timeoutSignal) => this.fetchProviderModels(request, timeoutSignal),
            { signal: operationSignal }
          )
        } catch (error) {
          operationSignal.throwIfAborted()
          return createEmptyRemoteCatalog(request.provider, Date.now(), AppError.getMessage(error))
        } finally {
          timers.dispose()
        }
      },
      { refresh, signal }
    )
  }

  private async fetchProviderModels(
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

    if (!canListRemoteProviderModels(preset.validationKind))
      return this.createPresetCatalog(request.provider, fetchedAt, request.purpose)

    if (
      isBlank(resolvedRequest.apiKey) &&
      !preset.apiKeyOptional &&
      preset.validationKind !== 'openrouter-key'
    )
      return createEmptyRemoteCatalog(
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
        preset,
        signal
      )
      return {
        provider: request.provider,
        source: 'remote',
        models: filterModelsForPurpose(request.purpose, remoteModels),
        fetchedAt,
      }
    } catch (error) {
      return createEmptyRemoteCatalog(request.provider, fetchedAt, AppError.getMessage(error))
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

  private async listProviderScriptModels(
    request: ListProviderModelsRequest,
    preset: ModelProviderPreset,
    fetchedAt: number
  ): Promise<ProviderModelCatalog> {
    if (!this.providerScriptRegistry?.supportsProvider(request.provider))
      return createEmptyRemoteCatalog(
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
        models: filterModelsForPurpose(
          request.purpose,
          this.normalizeModels(request.provider, models)
        ),
        fetchedAt,
      }
    } catch (error) {
      return createEmptyRemoteCatalog(request.provider, fetchedAt, AppError.getMessage(error))
    }
  }

  private async listRemoteProviderModels(
    request: ListProviderModelsRequest,
    baseURL: string,
    preset: ModelProviderPreset,
    signal?: AbortSignal
  ): Promise<ProviderModelCatalogEntry[]> {
    const listRequest = createProviderModelListRequest(
      request,
      baseURL,
      preset.validationKind,
      this.attribution
    )
    const headers = new Headers()
    for (const [name, value] of listRequest.headers) headers.append(name, value)
    // 外层目录请求拥有完整期限，响应头与正文读取共用同一取消信号。
    const response = await this.fetch(listRequest.url, { method: 'GET', headers, signal })
    if (!response.ok) {
      const responseText = (await response.text()).trim()
      throw new AppError(
        'NETWORK',
        normalizeProviderErrorMessage(preset.label, response.status, responseText)
      )
    }

    return this.parseRemoteProviderModels(
      request.provider,
      preset.validationKind,
      await response.json()
    )
  }

  private parseRemoteProviderModels(
    provider: ChatProviderId,
    validationKind: ModelProviderValidationKind,
    payload: unknown
  ): ProviderModelCatalogEntry[] {
    return this.normalizeModels(provider, readRemoteModelEntries(validationKind, payload))
  }

  private normalizeModels(
    provider: ChatProviderId,
    values: ReadonlyArray<RemoteProviderModelEntry | ProviderModelCatalogEntry>
  ): ProviderModelCatalogEntry[] {
    const seen = new Set<string>()
    const models: ProviderModelCatalogEntry[] = []
    // preset 取一次就够：`getProviderPreset` 每次都重建全部 provider 预设与目录，
    // 放在循环里时 OpenRouter 的几百条 `/models` 会把它重建几百遍。
    const presetModels = this.getProviderPreset(provider).providerScript?.models

    for (const value of values) {
      const id = value.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const presetModel = presetModels?.find((candidate) => candidate.id === id)
      models.push({
        id,
        label: value.label?.trim() || presetModel?.label || id,
        contextWindow: toOptional(
          value.contextWindow ??
            presetModel?.contextWindow ??
            resolveProviderModelContextWindow(provider, id)
        ),
        inputModalities: [value.inputModalities, presetModel?.inputModalities].find(
          (modalities) => !isEmpty(modalities ?? [])
        ),
      })
    }

    return models
  }

  private createPresetCatalog(
    provider: ChatProviderId,
    fetchedAt: number,
    purpose: ListProviderModelsRequest['purpose'] = 'chat'
  ): ProviderModelCatalog {
    const preset = this.getProviderPreset(provider)
    const values =
      purpose === 'embedding'
        ? [this.providerCollection.defaultEmbeddingModel(provider), ...preset.modelSuggestions]
        : preset.modelSuggestions
    return {
      provider,
      source: 'preset',
      models: filterModelsForPurpose(
        purpose,
        this.normalizeModels(
          provider,
          values.map((id) => ({ id }))
        )
      ),
      fetchedAt,
    }
  }
}
