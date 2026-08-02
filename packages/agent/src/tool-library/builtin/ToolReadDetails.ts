import type { ToolSpacePage } from '../../tools'
import type { KernelToolContext as ToolContext } from '../KernelToolContext'

interface ResolvedToolInputSchema {
  profileId: string
  description: string
  schema: unknown
}

/**
 * 解析工具页的真实 inputSchema，仅用于 tooling:map(op:"find") 的 schema 搜索文本索引。
 *
 * 「工具页 schema 预览/深读」入口已随旧的换入前预览范式退役；这里保留的是把 schema
 * 折算成可搜索文本、让 find 能按参数字段命中工具的内部用途，不面向模型直出。
 */
function readToolInputSchema(
  ctx: ToolContext,
  card: ToolSpacePage
): Nullable<ResolvedToolInputSchema> {
  if (card.kind !== 'tool' || !ctx.describeToolInputSchema) return null

  return ctx.describeToolInputSchema(card.name)
}

export { readToolInputSchema }
export type { ResolvedToolInputSchema }
