import type { ModelProviderCollection } from './ModelProviderCollection'
import type { BuiltInChatProviderId, ChatProviderId } from './ModelContracts'
import type { ModelProviderAdapterKind } from './ProviderManifest'

const EmbeddingAdapterKinds = new Set<ModelProviderAdapterKind>([
  'openai-sdk',
  'openai-compatible',
  'provider-script',
  'custom-js',
])

const DefaultEmbeddingModelsByProvider: Partial<
  Record<BuiltInChatProviderId, string>
> = {
  velar: 'velar/embedding',
  openai: 'text-embedding-3-large',
  openrouter: 'openai/text-embedding-3-large',
  qwen: 'text-embedding-v4',
  zhipu: 'embedding-3',
  mistral: 'mistral-embed',
  ollama: 'nomic-embed-text',
  freellmapi: 'text-embedding-3-large',
  custom: 'text-embedding-3-large',
}

export interface AutoEmbeddingSelectionInput {
  provider: ChatProviderId
  candidateModels?: readonly string[]
}

export interface AutoEmbeddingSelection {
  provider: ChatProviderId
  model: string
}

function normalizeCandidateModel(value: string): string {
  return value.trim()
}

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
  ) {
    return 60
  }
  if (/(^|[-_/])e5($|[-_/])/u.test(normalized)) return 55

  return 0
}

/**
 * Returns whether a provider's Model-owned adapter can create embeddings.
 *
 * The provider collection is explicit so injected provider scripts remain
 * isolated to one product composition instead of leaking through global state.
 */
export function isModelProviderEmbeddingCapable(
  providerCollection: ModelProviderCollection,
  provider: ChatProviderId,
): boolean {
  return EmbeddingAdapterKinds.has(
    providerCollection.requireOperationalManifest(provider).adapterKind,
  )
}

export function resolveDefaultEmbeddingModelForProvider(
  providerCollection: ModelProviderCollection,
  provider: ChatProviderId,
): string {
  const manifest = providerCollection.requireOperationalManifest(provider)
  return (
    manifest.providerScript?.embeddingModel
    ?? DefaultEmbeddingModelsByProvider[provider as BuiltInChatProviderId]
    ?? ''
  )
}

export function selectEmbeddingModelCandidate(
  candidateModels: readonly string[],
): string {
  let bestModel = ''
  let bestScore = 0

  for (const rawCandidate of candidateModels) {
    const candidate = normalizeCandidateModel(rawCandidate)
    if (!candidate) continue

    const score = getEmbeddingCandidateScore(candidate)
    if (score > bestScore) {
      bestModel = candidate
      bestScore = score
    }
  }

  return bestModel
}

export function filterEmbeddingModelCandidates(
  candidateModels: readonly string[],
): string[] {
  return candidateModels.map(normalizeCandidateModel).filter((candidate, index, list) => {
    if (!candidate || list.indexOf(candidate) !== index) return false
    return getEmbeddingCandidateScore(candidate) > 0
  })
}

export function resolveAutoEmbeddingSelection(
  providerCollection: ModelProviderCollection,
  { provider, candidateModels = [] }: AutoEmbeddingSelectionInput,
): AutoEmbeddingSelection {
  return {
    provider,
    model:
      selectEmbeddingModelCandidate(candidateModels)
      || resolveDefaultEmbeddingModelForProvider(providerCollection, provider),
  }
}
