import type {
  EmbeddingRequest,
  LanguageModelFactory,
  ModelAdapterConfig,
} from './ModelAdapter'
import type { ChatProviderId } from './ModelContracts'

/**
 * Portable adapter-registry contract used by model resolution and Kernel
 * integration. Hosts may provide the built-in Node registry or their own
 * browser, worker, remote, or test implementation.
 */
export interface ModelAdapterRegistryPort {
  supportsProvider(provider: ChatProviderId): boolean
  createLanguageModelFactory(config: ModelAdapterConfig): LanguageModelFactory
  createEmbeddingRequest(
    config: ModelAdapterConfig,
    model: string,
    texts: string[]
  ): EmbeddingRequest
}
