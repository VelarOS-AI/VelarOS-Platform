/** 工具面的数据形状：一个知识工具的运行时规格、定义工具的入参，以及回执里的索引问题汇总。 */

import type { DefineToolRuntimeSpecInput, ToolContractRuntimeSpec } from '@velaros-ai/tool-contract'

import type { KnowledgeToolCategoryId } from '../contract/constants.js'
import type { KnowledgeToolContext } from '../contract/requires.js'

/** 一个知识工具的运行时规格：说明、入参 schema、权限、能力声明与 execute，上下文固定是宿主注入的 `KnowledgeToolContext`。 */
export type KnowledgeTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = ToolContractRuntimeSpec<TInput, KnowledgeToolContext, unknown, string>

/** 定义一个知识工具要填的东西；类别固定是 `knowledge`。 */
export type DefineKnowledgeToolInput<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = DefineToolRuntimeSpecInput<TInput, KnowledgeToolContext, unknown, string> & {
  category: typeof KnowledgeToolCategoryId
}

/** `knowledge:search` 回执里的一类索引问题：怎么回事、影响了哪些文档、模型该怎么办。 */
export interface KnowledgeIndexIssue {
  kind: 'embedding-auth-invalid-issuer' | 'embedding-auth' | 'index-error'
  count: number
  sample: string
  actionable: boolean
  guidance: string
  affectedDocumentIds: string[]
}

/** 一类索引问题的分类结论，条数、样本与受影响文档在汇总时补齐。 */
export type KnowledgeIndexIssueClassification = Omit<
  KnowledgeIndexIssue,
  'count' | 'sample' | 'affectedDocumentIds'
>
