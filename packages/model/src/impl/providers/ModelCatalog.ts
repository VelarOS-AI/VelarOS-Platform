import { toNullable } from '@velaros-ai/core'

import { ModelProviderOperationalManifests } from '../../contract/constants.js'
import type {
  ChatProviderId,
  ModelProviderOperationalManifest,
  ProviderModelResolution,
  ProviderScriptRuntimeMetadata,
} from '../../types/model'
import type { SharedProviderCatalog } from '../../types/providers'
import {
  getKnownModelContextWindowEntries,
  resolveProviderModelContextWindow as resolveContextWindow,
  resolveProviderScriptContextWindow as resolveScriptContextWindow,
  resolveProviderScriptMetadataContextWindow as resolveScriptMetadataContextWindow,
} from '../../utils/catalog/context-windows'
import {
  filterVisibleProviderModels,
  getOpenAiOnlyModelIds,
  getSharedProviderCatalogOrNull,
  isOpenRouterCompatibleProvider as isOpenRouterCompatible,
  listSharedProviderModels,
  listSharedProviderSuggestedModels,
  resolveSharedProviderModelSelection,
} from '../../utils/catalog/model-selection'
import { SharedProviderCatalogs as SharedProviderCatalogList } from '../../utils/catalog/provider-catalogs'
import { createReadonlyMapSnapshot } from '../../utils/snapshots'

/** 全部内置 provider 的静态目录；这是一份拷贝，改它不会影响包内的查表。 */
export const SharedProviderCatalogs: readonly SharedProviderCatalog[] = SharedProviderCatalogList

/** 只在 OpenAI 直连下可选的模型 id；别的 provider 的可见目录里要滤掉它们。 */
export const OpenAiOnlyModels: ReadonlySet<string> = getOpenAiOnlyModelIds()

/** 静态目录里声明过上下文窗口的模型；只读快照，拿到的人改不了包内的查表。 */
export const KnownModelContextWindows: ReadonlyMap<string, number> = createReadonlyMapSnapshot(
  getKnownModelContextWindowEntries()
)

/** 这个 provider 走不走 OpenRouter 的路由语义。 */
export function isOpenRouterCompatibleProvider(providerId: ChatProviderId): boolean {
  return isOpenRouterCompatible(providerId)
}

/** 取一个内置 provider 的运营清单；不是内置 provider 时返回 null。 */
export function getModelProviderOperationalManifest(
  providerId: ChatProviderId
): Nullable<ModelProviderOperationalManifest> {
  return toNullable(
    ModelProviderOperationalManifests.find((manifest) => manifest.id === providerId)
  )
}

/** 取一个 provider 的静态目录；没有这个 provider 时返回 null。 */
export function getSharedProviderCatalog(
  providerId: ChatProviderId
): Nullable<SharedProviderCatalog> {
  return getSharedProviderCatalogOrNull(providerId)
}

/** 这个 provider 静态目录里的全部模型 id。 */
export function getSharedProviderModels(providerId: ChatProviderId): string[] {
  return listSharedProviderModels(providerId)
}

/** 这个 provider 推荐给用户看的模型。 */
export function getSharedProviderSuggestedModels(providerId: ChatProviderId): string[] {
  return listSharedProviderSuggestedModels(providerId)
}

/** 一份模型清单在某个 provider 下的可见子集。 */
export function getVisibleProviderModels(
  providerId: ChatProviderId,
  models: string[]
): string[] {
  return filterVisibleProviderModels(providerId, models)
}

/** 在同一个 provider 内选一个可用模型，并说明有没有发生回退。 */
export function resolveProviderModelSelection(
  providerId: ChatProviderId,
  currentModel?: string
): ProviderModelResolution {
  return resolveSharedProviderModelSelection(providerId, currentModel)
}

/** 在同一个 provider 内选一个可用模型，只要结果。 */
export function getResolvedProviderModel(
  providerId: ChatProviderId,
  currentModel?: string
): string {
  return resolveSharedProviderModelSelection(providerId, currentModel).model
}

/**
 * 根据 provider 实际选中的模型 ID 查询已知窗口；无法识别时返回 null，
 * 由调用方保留自己的安全回退值。
 */
export function resolveProviderModelContextWindow(
  provider: string,
  model: string
): Nullable<number> {
  return resolveContextWindow(provider, model)
}

/** 仅提取 provider script 运行时明确声明的窗口，不把静态查表或默认估计升级为 metadata。 */
export function resolveProviderScriptMetadataContextWindow(
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
): number | undefined {
  return resolveScriptMetadataContextWindow(metadata)
}

/** 显式运行时窗口优先于当前鉴权作用域目录；缺失时再按具体 provider/model 静态查表。 */
export function resolveProviderScriptContextWindow(input: {
  providerId: ChatProviderId
  runtimeModel: string
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
  catalogContextWindow?: number
}): number | undefined {
  return resolveScriptContextWindow(input)
}
