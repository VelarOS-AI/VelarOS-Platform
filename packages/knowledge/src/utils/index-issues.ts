/** 索引问题汇总：把搜索结果里记着的索引错误按原因归类，给模型一句能照做的下一步。 */

import { truncate } from '@velaros-ai/core'

import type { KnowledgeSearchResult } from '../types/knowledge.js'
import type { KnowledgeIndexIssue, KnowledgeIndexIssueClassification } from '../types/tool.js'

import { KnowledgeTuning } from './tuning.js'

/** 按错误文字判断这是哪一类索引问题，以及模型该怎么办。 */
function classifyKnowledgeIndexError(message: string): KnowledgeIndexIssueClassification {
  if (/invalid_issuer|valid issuer|401 Unauthorized/i.test(message)) return {
      kind: 'embedding-auth-invalid-issuer',
      actionable: true,
      guidance:
        '向量服务拒绝了当前的嵌入凭据（issuer 校验没过）；请用户检查嵌入服务商与凭据后重新同步。文本检索照常可用。',
    }

  if (/authorization|api[_ -]?key|401/i.test(message)) return {
      kind: 'embedding-auth',
      actionable: true,
      guidance:
        '嵌入鉴权失败；请用户修正嵌入服务商的凭据后重新同步。文本检索照常可用。',
    }

  return {
    kind: 'index-error',
    actionable: false,
    guidance:
      '这些文档的索引记着错误；结果像是过期了，就先看 knowledge:diagnostics 或重新同步这个工作区。',
  }
}

/** 把一批搜索结果里的索引错误按原因合并成几条问题，附上样本与受影响的文档 id。 */
export function summarizeKnowledgeIndexIssues(
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
      sample: truncate(message, KnowledgeTuning.indexIssues.sampleChars),
      affectedDocumentIds: [result.id],
    })
  }

  return [...issueMap.values()]
}
