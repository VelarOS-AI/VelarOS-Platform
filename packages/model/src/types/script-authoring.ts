import type { ProviderScriptDefinition, ProviderScriptHelpers } from '../contract/requires'

import type { ChatProviderId, ProviderScriptManifest } from './model'

/** 已加载并归一化好的一份 provider script。 */
export interface LoadedProviderScript {
  providerId: ChatProviderId
  label: string
  manifest: ProviderScriptManifest
  scriptPath: string
  configPath: string
  definition: ProviderScriptDefinition
  helpers: ProviderScriptHelpers
}
