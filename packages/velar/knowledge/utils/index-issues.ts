/** 命中里记着的索引错误按原因归类：给模型一句能照做的下一步，要用户处理的标出来。 */

import type { KnowledgeHit, KnowledgeIndexIssue } from '../types/knowledge.js'
import type { IndexErrorClassification } from '../types/search.js'

/** 认得出来的索引错误：按顺序匹配错误文字，先中先得。 */
const RecognizedIndexErrors: ReadonlyArray<{ pattern: RegExp; classification: IndexErrorClassification }> = [
  {
    pattern: /invalid_issuer|valid issuer|401 Unauthorized/iu,
    classification: {
      kind: 'embedding-auth-invalid-issuer',
      actionable: true,
      guidance: '向量服务拒绝了当前的嵌入凭据（issuer 校验没过）：请用户检查嵌入服务商与凭据，改好后重新同步。全文检索照常可用。',
    },
  },
  {
    pattern: /authorization|api[_ -]?key|401/iu,
    classification: {
      kind: 'embedding-auth',
      actionable: true,
      guidance: '嵌入鉴权失败：请用户修正嵌入服务商的凭据，改好后重新同步。全文检索照常可用。',
    },
  },
]

/** 都认不出来时的结论：一般的索引错误，模型自己能处理。 */
const GeneralIndexError: IndexErrorClassification = {
  kind: 'index-error',
  actionable: false,
  guidance: '这些文档的索引记着错误；结果像是过期了，就先看 diagnostics，或者 sync 这个工作区再搜。',
}

/** 按错误文字判断这是哪一类索引问题，以及模型该怎么办。 */
function classifyIndexError(message: string): IndexErrorClassification {
  return RecognizedIndexErrors.find((recognized) => recognized.pattern.test(message))?.classification ?? GeneralIndexError
}

/** 把一批命中里的索引错误按原因合并成几条问题，附上一条原文与受影响的文档 id。 */
export function summarizeIndexIssues(hits: readonly KnowledgeHit[]): KnowledgeIndexIssue[] {
  const issues = new Map<KnowledgeIndexIssue['kind'], KnowledgeIndexIssue>()
  for (const hit of hits) {
    if (!hit.indexError) continue
    const classification = classifyIndexError(hit.indexError)
    const existing = issues.get(classification.kind)
    if (existing) {
      existing.count += 1
      existing.affectedDocumentIds.push(hit.id)
      continue
    }
    issues.set(classification.kind, { ...classification, count: 1, sample: hit.indexError, affectedDocumentIds: [hit.id] })
  }
  return [...issues.values()]
}
