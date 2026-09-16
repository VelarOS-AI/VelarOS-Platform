import { KnowledgeIndexConfig, KnowledgeMatchTypes } from '../../Constants'

interface HybridCandidate {
  id: string
  score: number
  snippet: string
  matchType: string
}

function mergeHybridCandidates(
  textScores: Map<string, HybridCandidate>,
  vectorScores: Map<string, HybridCandidate>
): Map<string, HybridCandidate> {
  const merged = new Map(textScores)

  for (const [id, vectorCandidate] of vectorScores) {
    const textCandidate = merged.get(id)
    if (!textCandidate) {
      merged.set(id, vectorCandidate)
      continue
    }

    merged.set(id, {
      id,
      score:
        vectorCandidate.score * KnowledgeIndexConfig.VECTOR_WEIGHT +
        textCandidate.score * KnowledgeIndexConfig.TEXT_WEIGHT,
      snippet: textCandidate.snippet,
      matchType: KnowledgeMatchTypes.HYBRID,
    })
  }

  return merged
}

export { mergeHybridCandidates }
export type { HybridCandidate }
