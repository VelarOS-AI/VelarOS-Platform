import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { KnowledgeReadCapability, KnowledgeWriteCapability } from '../../Capabilities'
import type { KnowledgeSourceKind } from '../../knowledge/domain/Types'
import { defineKnowledgeTool } from '../../Types'

import { summarizeKnowledgeIndexIssues } from './IndexIssueSummary'
import { knowledgeSourceKindSchema } from './schema'
import { resolveWorkspaceRoot } from './workspace'

/** 查看 knowledge 索引健康状态。 */
const getKnowledgeDiagnostics = defineKnowledgeTool<Record<string, never>>({
  name: 'get_knowledge_diagnostics',
  role: 'memory',
  category: 'knowledge',
  summary: '查看 knowledge 索引诊断信息。',
  suitable: ['需要确认文档总量、内容策略过期、当前 profile 覆盖率或保留向量状态。'],
  forbidden: ['不要用它同步或搜索知识。'],
  usage: ['无需参数。'],
  examples: [{}],
  notes: ['只返回索引健康信息。'],
  schema: z.object({}),
  permissions: ['memory:read'],
  capabilities: KnowledgeReadCapability,
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 诊断只读，直接透传 domain 层结果。
    const diagnostics = await ctx.knowledge.getDiagnostics()

    return {
      diagnostics,
    }
  },
})

const syncKnowledgeWorkspace = defineKnowledgeTool<{
  workspaceRoot?: string
  force?: boolean
}>({
  name: 'sync_knowledge_workspace',
  role: 'memory',
  category: 'knowledge',
  summary: '同步工作区 knowledge 文档索引。',
  suitable: ['需要让当前工作区文档、配置或代码知识进入可检索索引。'],
  forbidden: ['不要把它当作全文搜索工具。'],
  protocol: ['先确认 workspaceRoot；同步完成后再 search_knowledge 检索。'],
  usage: ['可传 workspaceRoot；需要跳过短时 TTL 时传 force=true。'],
  examples: [{ workspaceRoot: "/repo", force: true }],
  notes: ['会增量扫描并清理已删除或不可见的旧知识记录。'],
  schema: z.object({
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '可选的工作区根目录。',
          notes: ['省略时默认使用当前激活工作区。'],
        })
      ),
    force: z.boolean().optional().describe(
      parameterDescription({
        description: '是否跳过短时 TTL 并强制重新同步。',
      })
    ),
  }),
  permissions: ['memory:write'],
  capabilities: KnowledgeWriteCapability,
  isConcurrencySafe: () => false,
  execute: async ({ workspaceRoot, force }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    // 同步前先确定工作区根路径，再把 force 作为增量扫描选项传给服务层。
    const effectiveWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot, ctx)
    const result = await ctx.knowledge.ensureWorkspaceSynced(effectiveWorkspaceRoot, { force })

    return {
      synced: true,
      workspaceRoot: effectiveWorkspaceRoot,
      result,
    }
  },
})

const searchKnowledge = defineKnowledgeTool<{
  query: string
  workspaceRoot?: string
  sourceKinds?: KnowledgeSourceKind[]
  pathHints?: string[]
  symbolHints?: string[]
  documentIds?: string[]
  limit?: number
}>({
  name: 'search_knowledge',
  role: 'memory',
  category: 'knowledge',
  summary: '搜索工作区 knowledge。',
  suitable: ['召回文档或代码知识。'],
  forbidden: ['不要替代读取已知文件。'],
  usage: ['传 query；宿主未提供 active workspace root 时必须显式传 workspaceRoot。'],
  examples: [{ query: "auth token refresh", limit: 5 }],
  notes: ['绑定工作区；不跨项目兜底。'],
  schema: z.object({
    query: z.string().trim().min(1).describe(
      parameterDescription({
        description: '需要检索的知识查询语句。',
      })
    ),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '可选的工作区根目录。',
          notes: [
            '省略时默认用 active workspace root。',
            '宿主没有 active workspace root 时必须显式传入。',
          ],
        })
      ),
    sourceKinds: z
      .array(knowledgeSourceKindSchema)
      .max(5)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的知识来源类型过滤。',
          values: [
            'markdown：Markdown 文档。',
            'text：纯文本资料。',
            'json：JSON 数据。',
            'config：配置文件。',
            'code：代码知识。',
          ],
        })
      ),
    pathHints: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的路径提示。',
          usage: ['用于提升相关文件的召回排序。'],
        })
      ),
    symbolHints: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的符号提示。',
          usage: ['用于提升相关代码知识的召回排序。'],
        })
      ),
    documentIds: z
      .array(z.string().min(1))
      .max(100)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的知识文档 id 过滤范围。',
        })
      ),
    limit: z
      .number()
      .transform((value) => Math.min(20, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '返回结果的最大数量。',
          notes: ['上限 20，超出自动钳制。'],
        })
      ),
  }),
  permissions: ['memory:read'],
  capabilities: KnowledgeReadCapability,
  isConcurrencySafe: () => true,
  execute: async (
    { query, workspaceRoot, sourceKinds, pathHints, symbolHints, documentIds, limit },
    ctx
  ) => {
    ctx.abortSignal.throwIfAborted()
    // 搜索同样绑定工作区，避免跨项目召回污染回答。
    const effectiveWorkspaceRoot = await resolveWorkspaceRoot(workspaceRoot, ctx)
    const results = await ctx.knowledge.searchKnowledge(query, {
      workspaceRoot: effectiveWorkspaceRoot,
      sourceKinds,
      pathHints,
      symbolHints,
      documentIds,
      limit,
    })

    return {
      query,
      workspaceRoot: effectiveWorkspaceRoot,
      count: results.length,
      indexIssues: summarizeKnowledgeIndexIssues(results),
      results,
    }
  },
})

/** knowledge 类别公开工具集合。 */
const knowledgeTools = {
  get_knowledge_diagnostics: getKnowledgeDiagnostics,
  sync_knowledge_workspace: syncKnowledgeWorkspace,
  search_knowledge: searchKnowledge,
}
export { knowledgeTools }
