import { isBlank, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { OllamaProviderId, OpenRouterAutoModelId, OpenRouterFreeModelId } from '../../contract/constants.js'
import type {
  ResolvedAgentModelRuntime,
} from '../../types/adapters'
import type {
  AgentProviderAdapterConfig,
  ChatProviderId,
  ModelRequestOptions,
  ModelRuntimeContext,
  ModelSelection,
  OpenRouterRoutingConfig,
  ProviderScriptRuntimeMetadata,
  ReasoningLevel,
  ThinkingDepth,
} from '../../types/model'
import type { ProviderScriptRegistryPort } from '../../types/scripts'
import {
  resolveProviderScriptContextWindow,
  resolveProviderScriptMetadataContextWindow,
} from '../../utils/catalog/context-windows'
import { isOpenRouterCompatibleProvider } from '../../utils/catalog/model-selection'
import {
  buildResolutionTrace,
  createUnavailableProviderError,
  mergeFallbackReason,
  mergeModelRequestOptionLayers,
  mergeModelRequestOptions,
  UnknownModelInputModalities,
} from '../../utils/resolution'
import { createThinkingDepthProviderOptions } from '../../utils/wire/reasoning'
import type { LocalModelEnvironmentApi } from '../providers/LocalModelEnvironment'
import { LocalModelEnvironment } from '../providers/LocalModelEnvironment'
import type { ModelProviderCollectionApi } from '../providers/ModelProviderCollection'
import type { ProviderModelCatalogApi } from '../providers/ProviderModelCatalogService'

import type { ModelAdapterRegistryApi } from './ModelAdapterRegistry'

/**
 * 把一次产品选择解析成 Agent 能直接用的运行时。
 *
 * 导览（§5.3b ⑥非显然妥协 / ③时序）——回退面刻意做窄。
 *
 * **只换模型不换 provider**：provider 不可用时抛 `providerUnavailable` 并给出自救动作
 * （§2.7），而不是悄悄换一家。判据是计费与数据流向——自动跨 provider 回退会让用户的密钥、
 * 隐私边界与账单在他不知情时改变。要放宽必须先有产品裁决，不是在这里加一个 `?? fallbackProvider`。
 *
 * **三个"模型名"不是一个东西，别合并**：目录解析结果、回给产品显示与记账的名字、
 * 真正发给服务商的名字。provider script 可以把前者映射成另一个后端模型，这时三者会分叉——
 * 上下文窗口按真正发出去的名字查，界面与 trace 按对外名字显示。
 *
 * **provider script 元数据失败不阻断**（§2.8）：捕获异常后回落成"按本地目录估算窗口"
 * 并把原因写进 `fallbackReason` 一路带到 trace，让用户看得见降级发生过。
 */
export interface AgentModelResolverApi {
  /** 解析一次产品选择；provider 不可用时抛，绝不换 provider。 */
  resolve(
    selection: ModelSelection,
    runtimeContext: ModelRuntimeContext,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime>
}

class AgentModelResolver implements AgentModelResolverApi {
  private readonly log = logRuntime.tag('AgentModelResolver')

  constructor(
    private readonly modelAdapterRegistry: ModelAdapterRegistryApi,
    private readonly providerScriptRegistry: ProviderScriptRegistryPort,
    private readonly providers: ModelProviderCollectionApi,
    private readonly localModelEnvironment: LocalModelEnvironmentApi = new LocalModelEnvironment(),
    private readonly modelCatalog?: Pick<ProviderModelCatalogApi, 'resolveModelCapabilities'>
  ) {}

  public async resolve(
    selection: ModelSelection,
    runtimeContext: ModelRuntimeContext,
    signal?: AbortSignal
  ): Promise<ResolvedAgentModelRuntime> {
    const modelResolution = this.providers.resolveModelSelection(
      selection.provider,
      selection.model
    )
    const runtimeConfig = this.providers.findRuntimeConfig(
      runtimeContext.providerRuntimeConfigs,
      selection.provider
    )
    if (!runtimeConfig) throw createUnavailableProviderError(selection.provider)

    const adapter = selection.adapter ?? runtimeConfig.adapter
    const effectiveRuntimeConfig = { ...runtimeConfig, adapter }
    if (
      !this.providers.isRuntimeConfigured({
        runtimeConfig: effectiveRuntimeConfig,
        providerRuntimeConfigs: runtimeContext.providerRuntimeConfigs,
        apiKeyOverride: selection.apiKey,
        supportsProvider: (provider) => this.modelAdapterRegistry.supportsProvider(provider),
      })
    ) {
      throw createUnavailableProviderError(selection.provider)
    }

    const apiKey = this.providers.resolveApiKey({
      provider: selection.provider,
      apiKey: isBlank(selection.apiKey) ? runtimeConfig.apiKey : selection.apiKey,
    })
    const baseURL = this.providers.resolveBaseURL({
      provider: selection.provider,
      baseURL: isBlank(selection.baseURL) ? runtimeConfig.baseURL : selection.baseURL,
    })
    const trace = buildResolutionTrace(
      selection.provider,
      selection.model,
      modelResolution.model,
      modelResolution.didFallback
    )
    const fallbackReason = modelResolution.didFallback
      ? `当前模型不可用，已在 ${selection.provider} 内回退到 ${modelResolution.model}`
      : undefined

    return this.createRuntime({
      providerId: selection.provider,
      model: modelResolution.model,
      apiKey,
      baseURL,
      thinkingDepth: selection.thinkingDepth,
      reasoningLevel: selection.reasoningLevel,
      openRouterConfig: runtimeContext.openRouter,
      adapter,
      resolutionTrace: trace,
      fallbackReason,
      signal,
    })
  }

  private async createRuntime(input: {
    providerId: ChatProviderId
    model: string
    apiKey: string
    baseURL: string
    thinkingDepth?: LooseOptional<ThinkingDepth>
    reasoningLevel?: LooseOptional<ReasoningLevel>
    openRouterConfig: OpenRouterRoutingConfig
    adapter?: LooseOptional<AgentProviderAdapterConfig>
    resolutionTrace: ResolvedAgentModelRuntime['resolutionTrace']
    fallbackReason?: string
    signal?: AbortSignal
  }): Promise<ResolvedAgentModelRuntime> {
    const resolvedModel = this.resolveRuntimeModel(
      input.providerId,
      input.model,
      input.openRouterConfig
    )
    const providerScriptMetadata = await this.resolveProviderScriptRuntimeMetadata({
      providerId: input.providerId,
      model: resolvedModel.model,
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      adapter: input.adapter,
      thinkingDepth: input.thinkingDepth,
      reasoningLevel: input.reasoningLevel,
      signal: input.signal,
    })
    const runtimeModel =
      providerScriptMetadata?.providerModel
      ?? providerScriptMetadata?.model
      ?? resolvedModel.model
    const externalModel = providerScriptMetadata?.model ?? resolvedModel.model
    // 已有完整的具体模型能力时直接执行，避免仅为静态兜底再等待目录服务。
    const needsModelDiscovery = !providerScriptMetadata?.inputModalities
      || !resolveProviderScriptMetadataContextWindow(providerScriptMetadata)
    const discoveredModel = needsModelDiscovery ? await this.modelCatalog?.resolveModelCapabilities({
      provider: input.providerId,
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      adapter: input.adapter,
      defaultModel: resolvedModel.model,
      model: runtimeModel,
      purpose: 'chat',
    }, input.signal) : undefined
    input.signal?.throwIfAborted()
    const catalogInputModalities = this.providers
      .requireCatalog(input.providerId)
      .models.find((candidate) => candidate.id === resolvedModel.model)?.inputModalities
    const catalogContextWindow = resolveProviderScriptContextWindow({
      providerId: input.providerId,
      runtimeModel,
      metadata: providerScriptMetadata,
      catalogContextWindow: discoveredModel?.contextWindow,
    })
    const contextWindow =
      input.providerId === OllamaProviderId
        ? toOptional(
          this.localModelEnvironment.resolveOllamaContextWindow(catalogContextWindow)
        )
        : catalogContextWindow
    const modelRequestOptions = mergeModelRequestOptions(
      mergeModelRequestOptionLayers(
        resolvedModel.requestOptions,
        providerScriptMetadata?.modelRequestOptions
      ),
      createThinkingDepthProviderOptions(
        input.providerId,
        runtimeModel,
        input.thinkingDepth ?? 'balanced',
        input.reasoningLevel
      )
    )
    const metadataFallbackReason = providerScriptMetadata?.fallbackReason
    const runtimeTrace = input.resolutionTrace.map((entry) => {
      if (entry.status !== 'selected' || entry.provider !== input.providerId) return entry

      const reason = mergeFallbackReason(entry.reason, metadataFallbackReason)
      return {
        ...entry,
        model: externalModel,
        providerModel: runtimeModel,
        reason: optionalWhen(!isBlank(reason), reason),
      }
    })

    return {
      provider: this.modelAdapterRegistry.createLanguageModelFactory({
        provider: input.providerId,
        apiKey: input.apiKey,
        baseURL: input.baseURL,
        adapter: input.adapter,
        thinkingDepth: input.thinkingDepth,
        reasoningLevel: toNullable(input.reasoningLevel),
        providerScriptRuntimeMetadata: providerScriptMetadata,
      }),
      providerId: input.providerId,
      model: externalModel,
      providerModel: runtimeModel,
      contextWindow,
      supportedInputModalities:
        providerScriptMetadata?.inputModalities ??
        discoveredModel?.inputModalities ??
        catalogInputModalities ??
        UnknownModelInputModalities,
      modelRequestOptions,
      resolutionSource: 'provider-collection',
      resolutionTrace: runtimeTrace,
      fallbackReason: toOptional(
        mergeFallbackReason(input.fallbackReason, metadataFallbackReason)
      ),
    }
  }

  private resolveRuntimeModel(
    providerId: ChatProviderId,
    model: string,
    openRouterConfig: OpenRouterRoutingConfig
  ): { model: string; requestOptions?: ModelRequestOptions } {
    if (!isOpenRouterCompatibleProvider(providerId)) return { model: this.providers.resolveModel(providerId, model) }

    const requestedModel = model.trim()
    if (
      requestedModel === OpenRouterFreeModelId
      || (
        openRouterConfig.useFreeModelsForDebug
        && (isBlank(requestedModel) || requestedModel === OpenRouterAutoModelId)
      )
    ) return {
        model: OpenRouterFreeModelId,
        requestOptions: { openRouter: { useFreeModelsForDebug: true } },
      }

    if (isBlank(requestedModel) || requestedModel === OpenRouterAutoModelId) return {
        model: OpenRouterAutoModelId,
        requestOptions: { openRouter: { allowedModels: [] } },
      }

    return { model: requestedModel }
  }

  private async resolveProviderScriptRuntimeMetadata(input: {
    providerId: ChatProviderId
    model: string
    apiKey: string
    baseURL: string
    adapter: LooseOptional<AgentProviderAdapterConfig>
    thinkingDepth: LooseOptional<ThinkingDepth>
    reasoningLevel: LooseOptional<ReasoningLevel>
    signal?: AbortSignal
  }): Promise<Nullable<ProviderScriptRuntimeMetadata>> {
    const manifest = this.providers.requireOperationalManifest(input.providerId)
    if (manifest.adapterKind !== 'provider-script') return null

    try {
      return await this.providerScriptRegistry.resolveRuntimeMetadata(
        {
          provider: input.providerId,
          apiKey: input.apiKey,
          baseURL: input.baseURL,
          adapter: input.adapter,
          thinkingDepth: input.thinkingDepth,
          reasoningLevel: toNullable(input.reasoningLevel),
        },
        input.model,
        input.signal
      )
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error
      const fallbackReason =
        `${manifest.label} 的 provider script 元数据不可用：${AppError.getMessage(error)}`
      this.log.warn('provider script model context fallback', {
        provider: input.providerId,
        error: AppError.getMessage(error),
      })
      return {
        model: input.model,
        providerModel: input.model,
        fallbackReason,
      }
    }
  }
}

export { AgentModelResolver }
