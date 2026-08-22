import { toNullable } from '@velaros-ai/core'

import type {
  AgentProviderRuntimeConfig,
  ChatProviderId,
} from './ModelContracts'
import type {
  ModelProviderAvailabilityOptions,
  ModelProviderCollection,
  ModelProviderConfiguredInput,
} from './ModelProviderCollection'


export type ProviderRuntimeAvailabilityOptions = ModelProviderAvailabilityOptions
export type ProviderRuntimeConfiguredInput = ModelProviderConfiguredInput

/**
 * Product compositions must provide their own provider collection. This keeps
 * injected provider scripts and runtime configuration isolated per runtime.
 */
export function normalizeProviderRuntimeConfigs(
  providerCollection: ModelProviderCollection,
  providerRuntimeConfigs: readonly AgentProviderRuntimeConfig[],
): AgentProviderRuntimeConfig[] {
  return providerCollection.normalizeRuntimeConfigs(providerRuntimeConfigs)
}

export function findProviderRuntimeConfig(
  providerCollection: ModelProviderCollection,
  providerRuntimeConfigs: readonly AgentProviderRuntimeConfig[],
  provider: ChatProviderId,
): Nullable<AgentProviderRuntimeConfig> {
  return providerCollection.findRuntimeConfig(providerRuntimeConfigs, provider)
}

export function isProviderRuntimeConfigured(
  providerCollection: ModelProviderCollection,
  input: ProviderRuntimeConfiguredInput,
): boolean {
  return providerCollection.isRuntimeConfigured(input)
}

export function getFirstConfiguredProviderRuntimeConfig(
  providerCollection: ModelProviderCollection,
  providerRuntimeConfigs: readonly AgentProviderRuntimeConfig[],
  options: ProviderRuntimeAvailabilityOptions = {},
): Nullable<AgentProviderRuntimeConfig> {
  return (
    toNullable(normalizeProviderRuntimeConfigs(providerCollection, providerRuntimeConfigs).find(
      (runtimeConfig) =>
        isProviderRuntimeConfigured(providerCollection, {
          runtimeConfig,
          providerRuntimeConfigs,
          ...options,
        }),
    ))
  )
}
