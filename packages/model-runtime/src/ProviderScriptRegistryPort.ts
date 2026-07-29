import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ModelRequestOptions,
  ProviderModelCatalogEntry,
  ProviderScriptManifest,
  ValidateProviderRuntimeRequest,
} from './ModelContracts'
import type { ModelAdapterConfig } from './ModelAdapter'

export interface ProviderScriptRuntimeMetadata {
  model?: LooseOptional<string>
  providerModel?: LooseOptional<string>
  contextWindow?: LooseOptional<number>
  fallbackReason?: LooseOptional<string>
  config?: unknown
  modelRequestOptions?: LooseOptional<ModelRequestOptions>
}

export interface ProviderScriptDescriptor {
  readonly manifest: ProviderScriptManifest
}

/**
 * Browser-safe contract consumed by the model domain.
 *
 * Loading JavaScript from disk is a host responsibility. Node hosts provide
 * this port through `@velaros-ai/model-runtime/provider-scripts/node`.
 */
export interface ProviderScriptRegistryPort {
  supportsProvider(provider: ChatProviderId): boolean
  getProviderScript(
    provider: ChatProviderId
  ): Nullable<ProviderScriptDescriptor>
  listProviderManifests(): ProviderScriptManifest[]
  validateProviderRuntime(
    request: ValidateProviderRuntimeRequest
  ): Promise<{ ok: boolean; message: Nullable<string> }>
  listProviderModels(
    request: ListProviderModelsRequest
  ): Promise<ProviderModelCatalogEntry[]>
  resolveRuntimeMetadata(
    config: ModelAdapterConfig,
    model: string
  ): Promise<Nullable<ProviderScriptRuntimeMetadata>>
  fetchTavily(
    path: '/api/tavily/search' | '/api/tavily/extract',
    body: Record<string, unknown>,
    provider: ChatProviderId,
    signal?: AbortSignal
  ): Promise<unknown>
}

/** unknown → positive integer, otherwise absent. */
export function toPositiveInteger(value: unknown): Nullable<number> {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue) || numericValue <= 0) return null

  return Math.floor(numericValue)
}
