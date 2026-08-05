import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'

import { KnowledgeReadCapability, KnowledgeWriteCapability } from '../../Capabilities'
import type {
  KnowledgeSearchResult,
  KnowledgeSourceKind,
  KnowledgeWorkspaceSyncResult,
} from '../../knowledge/domain/Types'
import { defineKnowledgeTool } from '../../Types'

import { summarizeKnowledgeIndexIssues } from './IndexIssueSummary'
import { knowledgeSourceKindSchema } from './schema'
import { resolveWorkspaceRoot } from './workspace'

/** 查看 knowledge 索引健康状态。 */
const getKnowledgeDiagnostics = defineKnowledgeTool<Record<string, never>>({
  name: 'knowledge:diagnostics',
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
  name: 'knowledge:sync',
  role: 'memory',
  category: 'knowledge',
  summary: '同步工作区 knowledge 文档索引。',
  suitable: ['需要让当前工作区文档、配置或代码知识进入可检索索引。'],
  forbidden: ['不要把它当作全文搜索工具。'],
  protocol: ['先确认 workspaceRoot；同步完成后再 knowledge:search 检索。'],
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
  name: 'knowledge:search',
  role: 'memory',
  category: 'knowledge',
  summary: '搜索工作区 knowledge。',
  suitable: ['召回文档或代码知识。'],
  forbidden: ['不要替代读取已知文件。'],
  protocol: [
    '零命中且该工作区还没建过索引时会自动补一次增量同步再重搜，'
      + '结果里的 autoSync 会说明这件事发生过。',
    'autoSync 存在而 count 仍为 0 = 索引是新建的且确实没有匹配内容，不要再调 knowledge:sync 重试。',
  ],
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
    const search = (): Promise<KnowledgeSearchResult[]> =>
      ctx.knowledge.searchKnowledge(query, {
        workspaceRoot: effectiveWorkspaceRoot,
        sourceKinds,
        pathHints,
        symbolHints,
        documentIds,
        limit,
      })

    let results = await search()
    /**
     * **fail-open**（原则 12：可用性类失败要向「还能用」的方向倒）。
     *
     * 零命中有两种完全不同的原因：「这个项目里真没有」与「索引压根没建过」。调用方看到的
     * `count: 0` 长得一模一样，于是要么误判「项目里没有」，要么去猜该不该先调 knowledge:sync
     * ——一个只有读过实现才知道答案的仪式。这里替它做掉：零命中就补一次增量同步再重搜，
     * 并在结果里如实说明发生过什么。
     *
     * 只在零命中时触发，且 `ensureWorkspaceSynced` 自带 TTL：有索引的工作区不会被反复扫盘。
     * 同步失败也不改变失败方向——搜索本身已经成功了，把它降级成报错等于让一个可选的加速步骤
     * 毁掉一次正常召回。
     */
    let autoSync: Nullable<KnowledgeWorkspaceSyncResult> = null
    if (isEmpty(results)) {
      autoSync = await ctx.knowledge
        .ensureWorkspaceSynced(effectiveWorkspaceRoot)
        // @arch-guard:suspend code-style/require-error-logging 理由：自动同步是零命中时的补救步骤，失败经返回值 autoSync=null 如实上报，不得改写搜索本身的成败。
        .catch(() => null)
      ctx.abortSignal.throwIfAborted()
      if (autoSync && autoSync.upserted + autoSync.reindexed > 0) results = await search()
    }

    return {
      query,
      workspaceRoot: effectiveWorkspaceRoot,
      count: results.length,
      indexIssues: summarizeKnowledgeIndexIssues(results),
      // 只在真的补过索引时出现：常态零命中不该多带一个恒 null 的字段。
      ...(autoSync
        ? {
            autoSync: {
              scanned: autoSync.scanned,
              indexed: autoSync.upserted + autoSync.reindexed,
              note: '本次零命中，已自动为该工作区补建/更新索引后重搜。',
            },
          }
        : {}),
      results,
    }
  },
})

/** knowledge 类别公开工具集合。 */
const knowledgeTools = {
  'knowledge:diagnostics': getKnowledgeDiagnostics,
  'knowledge:sync': syncKnowledgeWorkspace,
  'knowledge:search': searchKnowledge,
}
export { knowledgeTools }
