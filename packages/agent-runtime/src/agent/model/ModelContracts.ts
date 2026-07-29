import type { LanguageModel } from 'ai'

export interface AgentModelRequestPolicy {
  temperature?: number
  topP?: number
  maxOutputTokens?: number
}

/** Opaque provider options pass through to the injected model transport. */
export interface AgentModelRequestOptions {
  providerOptions?: Record<string, unknown>
  requestPolicy?: AgentModelRequestPolicy
  runtimeContext?: Record<string, unknown>
}

export type AgentModelProvider = (
  modelId: string,
  options?: AgentModelRequestOptions
) => LanguageModel

/** Executable model runtime returned by a product-owned provider collection. */
export interface ResolvedAgentModelRuntime {
  provider: AgentModelProvider
  providerId: string
  model: string
  providerModel: string
  contextWindow?: number
  modelRequestOptions?: AgentModelRequestOptions
  runProfilePolicy?: unknown
  resolutionSource: string
  resolutionTrace: readonly unknown[]
  fallbackReason?: string
}

/** Agent supplies opaque selection/context; Model owns catalog, auth and fallback. */
export interface AgentModelResolverPort {
  createAgentProvider(selection: unknown): AgentModelProvider
  resolveRoleRuntime(
    selection: unknown,
    runtimeContext?: unknown
  ): Promise<ResolvedAgentModelRuntime>
}
