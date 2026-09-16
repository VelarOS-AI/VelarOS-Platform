import { isEmpty, isNumber, isPlainObject, toNullable, toOptional, trimmedStringOrEmpty } from '@velaros-ai/core'

import type { ChatProviderId, ProviderScriptRuntimeMetadata } from '../../types/model'
import { toPositiveInteger } from '../numbers'

import {
  listKnownModelContextWindowEntries,
  listOpenRouterCompatibleContextWindowEntries,
} from './provider-catalogs'

const KnownModelContextWindowEntries = listKnownModelContextWindowEntries()
const KnownModelContextWindowMap = new Map(KnownModelContextWindowEntries)
const OpenRouterCompatibleModelContextWindows = new Map(
  listOpenRouterCompatibleContextWindowEntries()
)

/** 同一家族的模型窗口一致，个别型号没进静态目录时按前缀兜住。 */
const KnownModelContextWindowFamilies: Array<{ prefix: string; contextWindow: number }> = [
  { prefix: 'gpt-5', contextWindow: 400_000 },
  { prefix: 'gpt-4.1', contextWindow: 1_000_000 },
]

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

/** 依次按精确名、可选的 OpenRouter 精选表、家族前缀查窗口；查不到返回 null。 */
function resolveModelContextWindowCandidates(
  lookupCandidates: readonly string[],
  includeCompatibleCatalog = false
): Nullable<number> {
  if (isEmpty(lookupCandidates)) return null

  for (const candidate of lookupCandidates) {
    const exactMatch = KnownModelContextWindowMap.get(candidate)
    if (isNumber(exactMatch)) return exactMatch

    if (includeCompatibleCatalog) {
      const compatibleMatch = OpenRouterCompatibleModelContextWindows.get(candidate)
      if (isNumber(compatibleMatch)) return compatibleMatch
    }
  }

  for (const candidate of lookupCandidates) {
    const familyMatch = KnownModelContextWindowFamilies.find(
      (entry) =>
        candidate === entry.prefix ||
        candidate.startsWith(`${entry.prefix}-`) ||
        candidate.startsWith(`${entry.prefix}.`)
    )
    if (familyMatch) return familyMatch.contextWindow
  }

  return null
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
  return resolveModelContextWindowCandidates(
    buildProviderModelLookupCandidates(provider, model),
    true
  )
}

/** provider script 在 `config` 里声明的具体 provider/model 三元组；形状不对时按缺席处理。 */
function readConcreteProviderModelConfig(value: unknown): {
  provider: string
  model: string
  contextWindow: Nullable<number>
} | undefined {
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
    readConcreteProviderModelConfig(metadata?.config)?.contextWindow
    ?? toPositiveInteger(metadata?.contextWindow)
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

  return toOptional(toNullable(resolveProviderModelContextWindow(input.providerId, input.runtimeModel)))
}
