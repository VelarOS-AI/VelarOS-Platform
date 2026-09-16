

import type { ModelAdapterConfig } from './adapters'
import type {
  ChatProviderId,
  ListProviderModelsRequest,
  ProviderModelCatalogEntry,
  ProviderScriptDescriptor,
  ProviderScriptManifest,
  ProviderScriptRuntimeMetadata,
  ValidateProviderRuntimeRequest,
} from './model'

/** dev.json 里的一条脚本登记：直接写路径，或写成带开关的对象。 */
export type ProviderScriptConfigEntry =
  | string
  | {
      path?: LooseOptional<string>
      enabled?: LooseOptional<boolean>
    }

/** 开发者本机 dev.json 认得的形状；两种写法都收。 */
export interface ProviderScriptDevConfig {
  providerScripts?: LooseOptional<{
    enabled?: LooseOptional<boolean>
    scripts?: LooseOptional<ProviderScriptConfigEntry[]>
  }>
  scripts?: LooseOptional<ProviderScriptConfigEntry[]>
}

/** `registerSource` 收下的内存来源；重载时按原样重新求值，不落盘。 */
export interface RegisteredProviderScriptSource {
  source: string
  scriptPath: string
  configPath: string
}

/**
 * Browser-safe contract consumed by the model domain.
 *
 * Loading JavaScript from disk is a host responsibility. Node hosts provide
 * this port through `@velaros-ai/model/provider-scripts/node`.
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
    model: string,
    signal?: AbortSignal
  ): Promise<Nullable<ProviderScriptRuntimeMetadata>>
}
