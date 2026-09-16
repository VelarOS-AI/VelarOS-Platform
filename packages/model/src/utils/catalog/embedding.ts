import type { BuiltInChatProviderId, ChatProviderId, ModelProviderAdapterKind, ModelProviderOperationalManifest } from '../../types/model'

/** 能造 embedding 请求的适配器种类；别的种类一律判不支持。 */
const EmbeddingAdapterKinds = new Set<ModelProviderAdapterKind>([
  'openai-sdk',
  'openai-compatible',
  'provider-script',
  'custom-js',
])

/** 各家默认的 embedding 模型；这是规则名单，改名单和改规则一起审。 */
const DefaultEmbeddingModelsByProvider: Partial<Record<BuiltInChatProviderId, string>> = {
  velar: 'velar/embedding',
  openai: 'text-embedding-3-large',
  openrouter: 'openai/text-embedding-3-large',
  qwen: 'text-embedding-v4',
  zhipu: 'embedding-3',
  mistral: 'mistral-embed',
  ollama: 'nomic-embed-text',
  'openai-compatible-gateway': 'text-embedding-3-large',
  custom: 'text-embedding-3-large',
}

/** 模型名看起来有多像 embedding 模型；0 表示不像。 */
function getEmbeddingCandidateScore(model: string): number {
  const normalized = model.toLowerCase()
  if (normalized.includes('text-embedding-3-large')) return 100
  if (normalized.includes('text-embedding-3-small')) return 95
  if (normalized.includes('text-embedding')) return 90
  if (normalized.includes('embedding')) return 80
  if (normalized.includes('mistral-embed')) return 75
  if (normalized.includes('embed')) return 70
  if (
    normalized.includes('bge')
    || normalized.includes('nomic')
    || normalized.includes('jina')
  ) return 60
  if (/(^|[-_/])e5($|[-_/])/u.test(normalized)) return 55

  return 0
}

/**
 * 这个 provider 的适配器能不能造 embedding 请求。
 *
 * Velar Dev 的 Cloud 网关只暴露动态聊天目录与 chat/completions，
 * 不能因为它复用 OpenAI-compatible 聊天适配器就把它误判成 embedding provider。
 */
export function isEmbeddingCapableManifest(
  manifest: ModelProviderOperationalManifest
): boolean {
  if (manifest.id === 'velar-dev') return false

  return EmbeddingAdapterKinds.has(manifest.adapterKind)
}

/** 这个 provider 的默认 embedding 模型：provider script 声明的优先，其次查内置名单。 */
export function resolveDefaultEmbeddingModel(
  manifest: ModelProviderOperationalManifest,
  provider: ChatProviderId
): string {
  return (
    manifest.providerScript?.embeddingModel
    ?? DefaultEmbeddingModelsByProvider[provider as BuiltInChatProviderId]
    ?? ''
  )
}

/** 从一串候选模型里挑最像 embedding 的那个；都不像就返回空串。 */
export function selectEmbeddingModel(candidateModels: readonly string[]): string {
  let bestModel = ''
  let bestScore = 0

  for (const rawCandidate of candidateModels) {
    const candidate = rawCandidate.trim()
    if (!candidate) continue

    const score = getEmbeddingCandidateScore(candidate)
    if (score > bestScore) {
      bestModel = candidate
      bestScore = score
    }
  }

  return bestModel
}

/** 只留下看起来像 embedding 的候选模型，并去重。 */
export function filterEmbeddingModels(candidateModels: readonly string[]): string[] {
  return candidateModels.map((candidate) => candidate.trim()).filter((candidate, index, list) => {
    if (!candidate || list.indexOf(candidate) !== index) return false
    return getEmbeddingCandidateScore(candidate) > 0
  })
}

/** 这次目录是给 embedding 用时只留 embedding 模型；聊天用途原样返回。 */
export function filterModelsForPurpose<TEntry extends { id: string }>(
  purpose: 'chat' | 'embedding' | undefined,
  models: TEntry[]
): TEntry[] {
  if (purpose !== 'embedding') return models
  const embeddingIds = new Set(filterEmbeddingModels(models.map((model) => model.id)))
  return models.filter((model) => embeddingIds.has(model.id))
}
