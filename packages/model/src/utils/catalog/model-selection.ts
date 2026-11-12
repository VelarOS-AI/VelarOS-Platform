import { toNullable } from '@velaros-ai/core'

import {
  OpenRouterCompatibleProviderIds,
  VelarCloudManagedProviderIds,
} from '../../contract/constants.js'
import type {
  ChatProviderId,
  ProviderModelResolution,
  VelarCloudManagedProviderId,
} from '../../types/model'
import type { SharedProviderCatalog } from '../../types/providers'

import { findSharedProviderCatalogDefinition } from './provider-catalogs'

/** 官方能力默认值只用于官方 HTTPS 端点，兼容端点由宿主显式声明能力。 */
export function isOfficialOpenAiEndpoint(baseURL: string): boolean {
  return URL.canParse(baseURL) && new URL(baseURL).origin === 'https://api.openai.com'
}

/** 这个 provider 走不走 OpenRouter 的路由语义。 */
export function isOpenRouterCompatibleProvider(providerId: ChatProviderId): boolean {
  return (OpenRouterCompatibleProviderIds as readonly string[]).includes(providerId)
}

/** 同步入口只给服务商身份；可选模型必须通过鉴权作用域的动态目录取得。 */
export function getSharedProviderCatalogOrNull(
  providerId: ChatProviderId
): Nullable<SharedProviderCatalog> {
  const metadata = findSharedProviderCatalogDefinition(providerId)
  return toNullable(metadata ? { provider: metadata.provider, defaultModel: '', models: [] } : null)
}

/** 同步元数据不枚举模型，调用方应使用 ProviderModelCatalogService。 */
export function listSharedProviderModels(providerId: ChatProviderId): string[] {
  return getSharedProviderCatalogOrNull(providerId)?.models.map((model) => model.id) ?? []
}

/** 不再提供硬编码的推荐候选。 */
export function listSharedProviderSuggestedModels(providerId: ChatProviderId): string[] {
  return listSharedProviderModels(providerId)
}

/** 去掉空模型与重复项，保留原有顺序。 */
function dedupeModelsPreservingOrder(models: string[]): string[] {
  const normalizedModels: string[] = []
  const seen = new Set<string>()

  models.forEach((model) => {
    const trimmed = model.trim()
    if (!trimmed || seen.has(trimmed)) return

    seen.add(trimmed)
    normalizedModels.push(trimmed)
  })

  return normalizedModels
}

/** 远端目录自己决定可用身份；只去空值和重复项，不用静态型号表筛选。 */
export function filterVisibleProviderModels(
  _providerId: ChatProviderId,
  models: string[]
): string[] {
  return dedupeModelsPreservingOrder(models)
}

/**
 * 只保留调用方明确选择的模型；没有选择时留空，不从静态型号中推定默认值。
 */
export function resolveSharedProviderModelSelection(
  _providerId: ChatProviderId,
  currentModel?: string
): ProviderModelResolution {
  const requestedModel = currentModel?.trim() ?? ''
  return {
    model: requestedModel,
    didFallback: false,
  }
}

/** 这个 provider 是不是由 VelarOS Cloud 托管的那两个之一。 */
export function isVelarCloudManagedProvider(
  providerId: ChatProviderId
): providerId is VelarCloudManagedProviderId {
  return (VelarCloudManagedProviderIds as readonly string[]).includes(providerId)
}
