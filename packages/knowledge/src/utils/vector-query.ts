/** 向量表的公共判定：表名前缀、SQL 字符串转义、where/delete 谓词，以及 Arrow schema 里的维度读数。 */

import type { Table } from '@lancedb/lancedb'

import { isEmpty, isNumber, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 本包写出来的向量表都带这个前缀；连接后只登记符合这条协议的物理表。 */
export const KnowledgeVectorTablePrefix = 'knowledge_chunks_v2_'

/** 这张表是不是本包写出来的知识向量表。 */
export function isKnowledgeVectorTable(tableName: string): boolean {
  return tableName.startsWith(KnowledgeVectorTablePrefix)
}

/** 汇总诊断时展示的表名占位，代表「全部 profile 表」。 */
export function buildKnowledgeVectorTableGlob(): string {
  return `${KnowledgeVectorTablePrefix}*`
}

/** SQL 风格的字符串转义，用在 LanceDB 的 where/delete 谓词里。 */
function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** 隐私删除的谓词：清掉这份文档在这张表里的全部向量版本。 */
export function buildDeleteDocumentPredicate(documentId: string): string {
  return `document_id = ${quoteSqlString(documentId)}`
}

/** merge 的过滤条件：只清理完全相同的内容版本，不动别的模型或历史版本。 */
export function buildRevisionFilter(documentRevisionKey: string): string {
  return `document_revision_key = ${quoteSqlString(documentRevisionKey)}`
}

/** 向量检索的过滤条件：限定工作区，并把范围钉在给定的内容版本上。 */
export function buildSearchWhereClause(options: {
  workspaceRoot: string
  documentRevisionKeys: string[]
}): string {
  const filters = [`workspace_root = ${quoteSqlString(options.workspaceRoot)}`]

  if (!isEmpty(options.documentRevisionKeys)) {
    const quotedRevisionKeys = options.documentRevisionKeys
      .map((revisionKey) => quoteSqlString(revisionKey))
      .join(', ')
    filters.push(`document_revision_key IN (${quotedRevisionKeys})`)
  } else filters.push('1 = 0')

  return filters.join(' AND ')
}

/** 从 Arrow schema 里读出固定长度向量的维度，读不出返回 null。 */
export async function readVectorDimensions(table: Table): Promise<Nullable<number>> {
  const schema = await table.schema()
  const vectorField = schema.fields.find((field) => field.name === 'vector')
  if (!vectorField) return null
  const listSize = (vectorField.type as { listSize?: unknown }).listSize
  return isNumber(listSize) && Number.isInteger(listSize) && listSize > 0
    ? listSize
    : null
}

/** 校验查询或写入的向量维度和这张 profile 表的 schema 对得上。 */
export async function assertVectorDimensions(table: Table, dimensions: number): Promise<void> {
  const tableDimensions = await readVectorDimensions(table)
  if (!isPresent(tableDimensions) || tableDimensions === dimensions) return

  throw new AppError(
    'VALIDATION',
    `知识向量维度不匹配：现有 ${tableDimensions}，传入 ${dimensions}`
  )
}
