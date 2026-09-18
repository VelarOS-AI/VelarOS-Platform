/** 入参核对与结果归类的中间形状：只在单元内部用，不出单元。 */

import type { KnowledgeIndexIssue, KnowledgeSourceKind } from './knowledge.js'

/** 核对过的一次检索：query 去掉首尾空白，limit 已经落到确定的数，工作区还没解析。 */
export interface KnowledgeCheckedSearch {
  query: string
  workspaceRoot: Optional<string>
  limit: number
  sourceKinds?: KnowledgeSourceKind[]
  pathHints?: string[]
  symbolHints?: string[]
  documentIds?: string[]
}

/** 一类索引问题的结论：是什么、要不要用户处理、该怎么办；条数、原文与受影响的文档在合并时补上。 */
export type IndexErrorClassification = Omit<KnowledgeIndexIssue, 'count' | 'sample' | 'affectedDocumentIds'>
