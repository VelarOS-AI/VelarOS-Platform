import { AppError } from '@velaros-ai/core/error'

import { ModelErrorCodes, VelarCloudManagedProviderIds } from '../../contract/constants.js'
import type {
  ChatProviderId,
  ModelProviderOperationalManifest,
  ProviderScriptManifest,
  VelarCloudManagedProviderId,
} from '../../types/model'

/** 把一份 provider script 的 manifest 摊成运营清单：适配器与校验方式固定走 provider-script。 */
export function createScriptOperationalManifest(
  manifest: ProviderScriptManifest
): ModelProviderOperationalManifest {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    defaultBaseURL: manifest.defaultBaseURL,
    defaultApiKey: manifest.defaultApiKey,
    apiKeyOptional: manifest.apiKeyOptional,
    baseURLConfigurable: manifest.baseURLConfigurable,
    enabledByDefault: manifest.enabledByDefault,
    adapterKind: 'provider-script',
    validationKind: 'provider-script',
    providerScript: manifest,
  }
}

/** 内置清单是冻结的字面量表，这里按公开形状收一次，形状漂了当场编译不过。 */
export function asOperationalManifests(
  manifests: readonly ModelProviderOperationalManifest[]
): readonly ModelProviderOperationalManifest[] {
  return manifests
}

/** 收窄成 Velar Cloud 托管 provider；不是的按 providerUnknown 抛。 */
export function requireVelarCloudManagedProviderId(
  providerId: ChatProviderId
): VelarCloudManagedProviderId {
  if ((VelarCloudManagedProviderIds as readonly string[]).includes(providerId))
    return providerId as VelarCloudManagedProviderId
  throw new AppError(
    ModelErrorCodes.providerUnknown,
    `不是 Velar Cloud 托管 provider：${providerId}`
  )
}
