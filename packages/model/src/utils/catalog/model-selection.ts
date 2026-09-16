import { first, isBlank } from '@velaros-ai/core'

import { CustomModelProviderIds, OpenRouterCompatibleProviderIds } from '../../contract/constants.js'
import type { ChatProviderId, ProviderModelResolution } from '../../types/model'
import type { SharedProviderCatalog } from '../../types/providers'
import { createReadonlySetSnapshot } from '../snapshots'

import { findSharedProviderCatalogDefinition, listOpenAiOnlyModelIds } from './provider-catalogs'

const OpenAiOnlyModelIds = createReadonlySetSnapshot(listOpenAiOnlyModelIds())

/** 只在 OpenAI 直连下可选的模型 id 的只读快照。 */
export function getOpenAiOnlyModelIds(): ReadonlySet<string> {
  return OpenAiOnlyModelIds
}

/** 这个 provider 走不走 OpenRouter 的路由语义。 */
export function isOpenRouterCompatibleProvider(providerId: ChatProviderId): boolean {
  return (OpenRouterCompatibleProviderIds as readonly string[]).includes(providerId)
}

/** 这个 provider 允不允许用户直接输入模型名（目录只是建议，不是白名单）。 */
export function isCustomModelProvider(providerId: ChatProviderId): boolean {
  return (CustomModelProviderIds as readonly string[]).includes(providerId)
}

/** 按 provider id 取静态目录；没有这个 provider 时返回 null。 */
export function getSharedProviderCatalogOrNull(
  providerId: ChatProviderId
): Nullable<SharedProviderCatalog> {
  return findSharedProviderCatalogDefinition(providerId) ?? null
}

/** 这个 provider 静态目录里的全部模型 id。 */
export function listSharedProviderModels(providerId: ChatProviderId): string[] {
  return findSharedProviderCatalogDefinition(providerId)?.models.map((model) => model.id) ?? []
}

/** 这个 provider 推荐给用户看的模型：滤掉只在 OpenAI 直连下可选的那几个。 */
export function listSharedProviderSuggestedModels(providerId: ChatProviderId): string[] {
  return (findSharedProviderCatalogDefinition(providerId)?.models ?? [])
    .filter((model) => !model.openAiOnly)
    .map((model) => model.id)
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

/** 一份模型清单在某个 provider 下的可见子集：非 OpenAI 直连要滤掉 OpenAI 专属模型。 */
export function filterVisibleProviderModels(
  providerId: ChatProviderId,
  models: string[]
): string[] {
  const visibleModels =
    providerId === 'openai' ? models : models.filter((model) => !OpenAiOnlyModelIds.has(model))

  return dedupeModelsPreservingOrder(visibleModels)
}

/**
 * 在同一个 provider 内选一个可用模型。
 *
 * 允许直接输入模型名的 provider 一律尊重用户填的名字；其余的先看它在不在建议表里，
 * 不在就回退到第一条建议并把 `didFallback` 标出来，让界面看得见降级发生过。
 */
export function resolveSharedProviderModelSelection(
  providerId: ChatProviderId,
  currentModel?: string
): ProviderModelResolution {
  const requestedModel = currentModel?.trim() ?? ''
  const suggestions = filterVisibleProviderModels(providerId, listSharedProviderModels(providerId))

  if (isCustomModelProvider(providerId) && !isBlank(requestedModel))
    return {
      model: requestedModel,
      didFallback: false,
    }

  if (!isBlank(requestedModel) && suggestions.includes(requestedModel))
    return {
      model: requestedModel,
      didFallback: false,
    }

  return {
    model: first(suggestions) ?? requestedModel,
    didFallback: !isBlank(requestedModel) && (first(suggestions) ?? '') !== requestedModel,
  }
}
