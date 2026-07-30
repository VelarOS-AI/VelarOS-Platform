import { isBlank, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import { LocalModelEnvironment, OllamaProviderId } from './LocalModelEnvironment'
import type { LanguageModelFactory } from './ModelAdapter'
import type { ModelAdapterRegistryPort } from './ModelAdapterRegistryPort'
import {
  isOpenRouterCompatibleProvider,
  OpenRouterAutoModelId,
  OpenRouterFreeModelId,
  resolveModelContextWindow,
} from './ModelCatalog'
import type {
  AgentProviderAdapterConfig,
  ChatProviderId,
  ModelRequestOptions,
  ModelRuntimeContext,
  ModelSelection,
  OpenRouterRoutingConfig,
  ReasoningLevel,
  ThinkingDepth,
} from './ModelContracts'
import type { ModelProviderCollection } from './ModelProviderCollection'
import { resolveProviderScriptContextWindow } from './ProviderScriptContextWindow'
import {
  type ProviderScriptRegistryPort,
  type ProviderScriptRuntimeMetadata,
} from './ProviderScriptRegistryPort'
import { createThinkingDepthProviderOptions } from './ThinkingDepthModelOptions'

interface ResolvedAgentModelRuntime {
  provider: LanguageModelFactory
  providerId: string
  model: string
  providerModel: string
  contextWindow?: number
  modelRequestOptions?: ModelRequestOptions
  resolutionSource: 'provider-collection'
  resolutionTrace: Array<{
    provider: string
    model: string
    providerModel?: string
    status: 'selected' | 'skipped'
    reason?: string
  }>
  fallbackReason?: string
}

type ResolutionTraceEntry = ResolvedAgentModelRuntime['resolutionTrace'][number]

/**
 * Resolves one explicit product selection against this composition's provider
 * collection. Fallback is restricted to another model of the same provider;
 * this resolver never switches providers.
 *
 * 导览（§5.3b ⑥非显然妥协 / ③时序）——回退面刻意做窄。
 *
 * **只换模型不换 provider**：provider 不可用时抛 `createUnavailableProviderError` 并给出自救动作
 * （§2.7），而不是悄悄换一家。判据是计费与数据流向——自动跨 provider 回退会让用户的密钥、
 * 隐私边界与账单在他不知情时改变。要放宽必须先有产品裁决，不是在这里加一个 `?? fallbackProvider`。
 *
 * **三个"模型名"不是一个东西，别合并**：`resolvedModel.model`（目录解析结果）、
 * `externalModel`（回给产品显示与记账的名字）、`runtimeModel`（真正发给服务商的名字）。
 * provider script 可以把前者映射成另一个后端模型，这时三者会分叉——上下文窗口按 runtimeModel 查，
 * UI 与 trace 按 externalModel 显示。
 *
 * **provider script 元数据失败不阻断**（§2.8）：`resolveProviderScriptRuntimeMetadata` 捕获异常后
 * 回落成"按本地目录估算窗口"并把原因写进 `fallbackReason` 一路带到 trace，让用户看得见降级发生过。
 */
class AgentModelResolver {
  private readonly log = logRuntime.tag('AgentModelResolver')

  constructor(
    private readonly modelAdapterRegistry: ModelAdapterRegistryPort,
    private readonly providerScriptRegistry: ProviderScriptRegistryPort,
    private readonly providers: ModelProviderCollection,
    private readonly localModelEnvironment = new LocalModelEnvironment()
  ) {}

  public async resolve(
    selection: ModelSelection,
    runtimeContext: ModelRuntimeContext
  ): Promise<ResolvedAgentModelRuntime> {
    const modelResolution = this.providers.resolveModelSelection(
      selection.provider,
      selection.model
    )
    const runtimeConfig = this.providers.findRuntimeConfig(
      runtimeContext.providerRuntimeConfigs,
      selection.provider
    )
    if (!runtimeConfig) throw this.createUnavailableProviderError(selection.provider)

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
      throw this.createUnavailableProviderError(selection.provider)
    }

    const apiKey = this.providers.resolveApiKey({
      provider: selection.provider,
      apiKey: isBlank(selection.apiKey) ? runtimeConfig.apiKey : selection.apiKey,
    })
    const baseURL = this.providers.resolveBaseURL({
      provider: selection.provider,
      baseURL: isBlank(selection.baseURL) ? runtimeConfig.baseURL : selection.baseURL,
    })
    const trace = this.buildResolutionTrace(
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
    })
  }

  private buildResolutionTrace(
    provider: ChatProviderId,
    requestedModel: string,
    selectedModel: string,
    didFallback: boolean
  ): ResolutionTraceEntry[] {
    if (!didFallback) return [{ provider, model: selectedModel, status: 'selected' }]

    return [
      {
        provider,
        model: requestedModel,
        status: 'skipped',
        reason: '所选模型已不在当前 provider 的可用目录中',
      },
      { provider, model: selectedModel, status: 'selected' },
    ]
  }

  private createUnavailableProviderError(provider: ChatProviderId): AppError {
    return new AppError(
      'VALIDATION',
      `当前 provider ${provider} 不可用。请确认它已启用，且 API Key、Base URL 或自定义 adapter 配置有效；Model Runtime 不会自动切换到其它 provider。`
    )
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
    })
    const runtimeModel =
      providerScriptMetadata?.providerModel
      ?? providerScriptMetadata?.model
      ?? resolvedModel.model
    const externalModel = providerScriptMetadata?.model ?? resolvedModel.model
    const catalogContextWindow = resolveProviderScriptContextWindow({
      providerId: input.providerId,
      runtimeModel,
      metadata: providerScriptMetadata,
    })
    const contextWindow =
      input.providerId === OllamaProviderId
        ? toOptional(
          this.localModelEnvironment.resolveOllamaContextWindow(catalogContextWindow)
        )
        : catalogContextWindow
    const modelRequestOptions = this.mergeModelRequestOptions(
      this.mergeModelRequestOptionLayers(
        resolvedModel.requestOptions,
        providerScriptMetadata?.modelRequestOptions
      ),
      createThinkingDepthProviderOptions(
        input.providerId,
        runtimeModel,
        input.thinkingDepth ?? 'balanced'
      )
    )
    const metadataFallbackReason = providerScriptMetadata?.fallbackReason
    const runtimeTrace = input.resolutionTrace.map((entry) => {
      if (entry.status !== 'selected' || entry.provider !== input.providerId) return entry

      const reason = this.mergeFallbackReason(entry.reason, metadataFallbackReason)
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
      modelRequestOptions,
      resolutionSource: 'provider-collection',
      resolutionTrace: runtimeTrace,
      fallbackReason: toOptional(
        this.mergeFallbackReason(input.fallbackReason, metadataFallbackReason)
      ),
    }
  }

  private mergeFallbackReason(
    primary: LooseOptional<string>,
    secondary: LooseOptional<string>
  ): string {
    return [primary, secondary]
      .map((reason) => reason?.trim() ?? '')
      .filter((reason) => !isBlank(reason))
      .join('；')
  }

  private mergeModelRequestOptions(
    requestOptions: ModelRequestOptions | undefined,
    providerOptions: Nullable<Record<string, unknown>>
  ): ModelRequestOptions | undefined {
    if (!providerOptions) return requestOptions

    return {
      ...(requestOptions ?? {}),
      requestPolicy: requestOptions?.requestPolicy,
      providerOptions: {
        ...(requestOptions?.providerOptions ?? {}),
        ...providerOptions,
      },
    }
  }

  private mergeModelRequestOptionLayers(
    primary: ModelRequestOptions | undefined,
    secondary: LooseOptional<ModelRequestOptions>
  ): ModelRequestOptions | undefined {
    if (!secondary) return primary
    if (!primary) return secondary

    return {
      ...primary,
      ...secondary,
      openRouter: secondary.openRouter ?? primary.openRouter,
      requestPolicy: secondary.requestPolicy ?? primary.requestPolicy,
      providerOptions: secondary.providerOptions
        ? {
            ...(primary.providerOptions ?? {}),
            ...secondary.providerOptions,
          }
        : primary.providerOptions,
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
        input.model
      )
    } catch (error) {
      const fallbackReason =
        `${manifest.label} provider script metadata unavailable: ${AppError.getMessage(error)}`
      this.log.warn('provider script model context fallback', {
        provider: input.providerId,
        error: AppError.getMessage(error),
      })
      return {
        model: input.model,
        providerModel: input.model,
        contextWindow: resolveModelContextWindow(input.model),
        fallbackReason,
      }
    }
  }
}

export { AgentModelResolver }
export type { ResolvedAgentModelRuntime }
