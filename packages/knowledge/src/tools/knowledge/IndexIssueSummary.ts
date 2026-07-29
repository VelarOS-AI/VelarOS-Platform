import { truncate } from '@velaros-ai/core'

import type { KnowledgeSearchResult } from '../../knowledge/domain/Types'
interface KnowledgeIndexIssue {
  kind: 'embedding-auth-invalid-issuer' | 'embedding-auth' | 'index-error'
  count: number
  sample: string
  actionable: boolean
  guidance: string
  affectedDocumentIds: string[]
}

function classifyKnowledgeIndexError(
  message: string
): Omit<KnowledgeIndexIssue, 'count' | 'sample' | 'affectedDocumentIds'> {
  if (/invalid_issuer|valid issuer|401 Unauthorized/i.test(message)) return {
      kind: 'embedding-auth-invalid-issuer',
      actionable: true,
      guidance:
        'Embedding credentials are rejected by the provider issuer check; fix the embedding token/provider configuration and resync knowledge. Text recall may still return results.',
    }

  if (/authorization|api[_ -]?key|401/i.test(message)) return {
      kind: 'embedding-auth',
      actionable: true,
      guidance:
        'Embedding authentication failed; fix the embedding provider credentials and resync knowledge. Text recall may still return results.',
    }

  return {
    kind: 'index-error',
    actionable: false,
    guidance:
      'Knowledge index has stored errors for these documents; inspect get_knowledge_diagnostics or resync the workspace if the results look stale.',
  }
}

function summarizeKnowledgeIndexIssues(
  results: readonly KnowledgeSearchResult[]
): KnowledgeIndexIssue[] {
  const issueMap = new Map<string, KnowledgeIndexIssue>()

  for (const result of results) {
    const message = result.indexError?.trim()
    if (!message) continue

    const classification = classifyKnowledgeIndexError(message)
    const key = classification.kind
    const existing = issueMap.get(key)
    if (existing) {
      existing.count += 1
      existing.affectedDocumentIds.push(result.id)
      continue
    }

    issueMap.set(key, {
      ...classification,
      count: 1,
      sample: truncate(message, 240),
      affectedDocumentIds: [result.id],
    })
  }

  return [...issueMap.values()]
}

export { summarizeKnowledgeIndexIssues }
export type { KnowledgeIndexIssue }
