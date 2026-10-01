import {
  isEmpty,
  isNumber,
  isPlainObject,
  toNullable,
  toOptional,
  trimmedStringOrEmpty,
} from '@velaros-ai/core'

import type { ChatProviderId, ProviderScriptRuntimeMetadata } from '../../types/model'
import { toPositiveInteger } from '../numbers'

import {
  findSharedProviderCatalogDefinition,
  listKnownModelContextWindowEntries,
  listOpenRouterCompatibleContextWindowEntries,
} from './provider-catalogs'

const KnownModelContextWindowEntries = listKnownModelContextWindowEntries()
const OpenRouterCompatibleModelContextWindows = new Map(
  listOpenRouterCompatibleContextWindowEntries()
)

/** 全部静态目录里声明过窗口的模型条目，给对外的只读快照用。 */
export function getKnownModelContextWindowEntries(): Array<readonly [string, number]> {
  return KnownModelContextWindowEntries
}

/** 把模型名展开成一串查表候选：原名、去掉命名空间、去掉 `:` 与 `@` 后缀。 */
export function buildModelLookupCandidates(model: string): string[] {
  const trimmed = model.trim().toLowerCase()
  if (!trimmed) return []

  const candidates: string[] = []
  const seen = new Set<string>()
  const queue = [trimmed]

  while (!isEmpty(queue)) {
    const candidate = queue.shift()
    if (!candidate || seen.has(candidate)) {
      continue
    }

    seen.add(candidate)
    candidates.push(candidate)

    const lastSlashIndex = candidate.lastIndexOf('/')
    if (lastSlashIndex >= 0 && lastSlashIndex < candidate.length - 1) {
      queue.push(candidate.slice(lastSlashIndex + 1))
    }

    ;[':', '@'].forEach((separator) => {
      const separatorIndex = candidate.indexOf(separator)
      if (separatorIndex > 0) {
        queue.push(candidate.slice(0, separatorIndex))
      }
    })
  }

  return candidates
}

/** 往候选表里补一个归一化后的候选，重复的跳过。 */
function addCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || seen.has(trimmed)) return

  seen.add(trimmed)
  candidates.push(trimmed)
}

/** 把 provider 与模型名一起展开成候选：补上 `provider/model`，Bedrock 与 Vertex 的命名另有映射。 */
function buildProviderModelLookupCandidates(provider: string, model: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const normalizedProvider = provider.trim().toLowerCase()
  const normalizedModel = model.trim().toLowerCase()

  buildModelLookupCandidates(normalizedModel).forEach((candidate) => {
    addCandidate(candidates, seen, candidate)
  })

  const providerAlias =
    normalizedProvider === 'vertex'
      ? 'google'
      : normalizedProvider === 'bedrock'
        ? 'anthropic'
        : normalizedProvider
  if (providerAlias && normalizedModel && !normalizedModel.includes('/')) {
    addCandidate(candidates, seen, `${providerAlias}/${normalizedModel}`)
  }

  if (normalizedProvider === 'bedrock') {
    const withoutInferenceProfile = normalizedModel.replace(/^(?:global|us|eu|apac)\./u, '')
    const namespaceSeparator = withoutInferenceProfile.indexOf('.')
    if (namespaceSeparator > 0 && namespaceSeparator < withoutInferenceProfile.length - 1) {
      const namespace = withoutInferenceProfile.slice(0, namespaceSeparator)
      const providerModel = withoutInferenceProfile.slice(namespaceSeparator + 1)
      addCandidate(candidates, seen, providerModel)
      addCandidate(candidates, seen, `${namespace}/${providerModel}`)

      const modelWithoutBedrockRevision = providerModel.replace(/-\d{8}-v\d+(?::\d+)?$/u, '')
      addCandidate(candidates, seen, modelWithoutBedrockRevision)
      addCandidate(candidates, seen, `${namespace}/${modelWithoutBedrockRevision}`)
    }
  }

  return candidates
}

/**
 * 根据 provider 实际选中的模型 ID 查询已知窗口；无法识别时返回 null，
 * 由调用方保留自己的安全回退值。
 */
export function resolveProviderModelContextWindow(
  provider: string,
  model: string
): Nullable<number> {
  const normalizedProvider = provider.trim().toLowerCase()
  const normalizedModel = model.trim().toLowerCase()
  if (normalizedProvider === 'openrouter')
    return toNullable(OpenRouterCompatibleModelContextWindows.get(normalizedModel))
  const source =
    normalizedProvider === 'vertex'
      ? 'google'
      : normalizedProvider === 'bedrock'
        ? 'anthropic'
        : normalizedProvider
  const catalog = findSharedProviderCatalogDefinition(source)
  if (!catalog) return null
  // 只有明确的云提供方命名协议做转换；私有别名不剥离后缀或借用其他提供方的窗口。
  const candidates = ['vertex', 'bedrock'].includes(normalizedProvider)
    ? buildProviderModelLookupCandidates(normalizedProvider, normalizedModel)
    : [normalizedModel]
  for (const candidate of candidates) {
    const match = catalog.models.find((entry) => entry.id.toLowerCase() === candidate)
    if (isNumber(match?.contextWindow)) return match.contextWindow
  }
  return null
}

/** provider script 在 `config` 里声明的具体 provider/model 三元组；形状不对时按缺席处理。 */
function readConcreteProviderModelConfig(value: unknown):
  | {
      provider: string
      model: string
      contextWindow: Nullable<number>
    }
  | undefined {
  if (!isPlainObject(value)) return undefined

  const provider = trimmedStringOrEmpty(value.provider)
  const model = trimmedStringOrEmpty(value.model)
  if (!provider || !model) return undefined

  return {
    provider,
    model,
    contextWindow: toPositiveInteger(value.contextWindow),
  }
}

/** 仅提取运行时明确声明的窗口，不把静态查表或默认估计升级为 metadata。 */
export function resolveProviderScriptMetadataContextWindow(
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
): number | undefined {
  return toOptional(
    readConcreteProviderModelConfig(metadata?.config)?.contextWindow ??
      toPositiveInteger(metadata?.contextWindow)
  )
}

/** 显式运行时窗口优先于当前鉴权作用域目录；缺失时再按具体 provider/model 静态查表。 */
export function resolveProviderScriptContextWindow(input: {
  providerId: ChatProviderId
  runtimeModel: string
  metadata?: LooseOptional<ProviderScriptRuntimeMetadata>
  catalogContextWindow?: number
}): number | undefined {
  const explicitWindow = resolveProviderScriptMetadataContextWindow(input.metadata)
  if (explicitWindow) return explicitWindow
  if (input.catalogContextWindow) return input.catalogContextWindow

  const concreteConfig = readConcreteProviderModelConfig(input.metadata?.config)
  if (concreteConfig) {
    const resolved = resolveProviderModelContextWindow(
      concreteConfig.provider,
      concreteConfig.model
    )
    if (resolved) return resolved
  }

  return toOptional(
    toNullable(resolveProviderModelContextWindow(input.providerId, input.runtimeModel))
  )
}
