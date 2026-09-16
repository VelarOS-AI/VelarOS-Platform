/**
 * 知识库的三个模型面工具：查索引健康、把工作区摄入索引、在索引里检索。
 *
 * 每个工具的说明就是它的定义：摘要、适用与禁用场景、协议、用法、示例、参数、权限与能力声明都在定义里；
 * execute 只写一两步，实现交给 `KnowledgeToolOperations`。文件末尾是三个工具怎么分组挂出去。
 * 这是人最先看的文件，改了要在差量报告里点名。
 */

import { z } from 'zod'

import { renderParameterDescription as parameterDescription, toolDescriptions } from '@velaros-ai/tool-contract'

import {
  KnowledgeSourceKinds,
  KnowledgeToolCategoryId,
  KnowledgeToolLimits,
  KnowledgeToolNames,
} from '../contract/constants.js'
import type { KnowledgeTool } from '../types/tool.js'
import { defineKnowledgeTool } from '../utils/tool.js'

import type {
  KnowledgeToolOperationsSearchInput,
  KnowledgeToolOperationsSyncInput,
} from './KnowledgeToolOperations.js'
import { knowledgeToolOperations } from './KnowledgeToolOperations.js'

/** 只读知识索引：不改任何东西，可以并发。 */
const KnowledgeReadCapability = {
  effectKind: 'read',
  readScopes: ['memory', 'workspace'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: '读取知识索引',
} as const

/** 写知识索引：会改索引内容，同一工作区不能并发。 */
const KnowledgeWriteCapability = {
  effectKind: 'write',
  readScopes: ['memory', 'workspace'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: '写入知识索引',
} as const

/** 来源类型过滤的入参 schema，取值来自合同里的来源类型表。 */
const knowledgeSourceKindSchema = z.enum(KnowledgeSourceKinds)

// ── 诊断 ────────────────────────────────────────────────────────

/** knowledge:diagnostics —— 看知识索引的健康状况。 */
const getKnowledgeDiagnostics = defineKnowledgeTool<Record<string, never>>({
  name: KnowledgeToolNames.diagnostics,
  role: 'memory',
  category: KnowledgeToolCategoryId,
  summary: '查看知识索引的诊断信息。',
  suitable: ['要确认文档总量、内容策略是否过期、当前嵌入组合的覆盖率，或保留下来的向量状态。'],
  forbidden: ['不要用它同步或搜索知识。'],
  usage: ['不用传参数。'],
  examples: [{}],
  notes: ['只返回索引健康信息，不会动任何数据。'],
  schema: z.object({}),
  permissions: ['memory:read'],
  capabilities: KnowledgeReadCapability,
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    return knowledgeToolOperations.diagnostics(ctx)
  },
})

// ── 同步 ────────────────────────────────────────────────────────

/** knowledge:sync —— 把当前工作区的文档与代码增量摄入索引。 */
const syncKnowledgeWorkspace = defineKnowledgeTool<KnowledgeToolOperationsSyncInput>({
  name: KnowledgeToolNames.sync,
  role: 'memory',
  category: KnowledgeToolCategoryId,
  summary: '同步工作区的知识文档索引。',
  suitable: ['要让当前工作区的文档、配置或代码知识进入可检索索引。'],
  forbidden: ['不要把它当全文搜索工具。'],
  protocol: ['先确认 workspaceRoot；同步完成后再用 knowledge:search 检索。'],
  usage: ['可以传 workspaceRoot；要跳过短时节流就传 force=true。'],
  examples: [{ workspaceRoot: '/repo', force: true }],
  notes: ['会增量扫描，并清理已删除或不可见的旧知识记录。'],
  schema: z.object({
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '可选的工作区根目录。',
          notes: ['省略时用宿主当前激活的工作区。'],
        })
      ),
    force: z.boolean().optional().describe(
      parameterDescription({
        description: '是否跳过短时节流并强制重新同步。',
      })
    ),
  }),
  permissions: ['memory:write'],
  capabilities: KnowledgeWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    return knowledgeToolOperations.sync(input, ctx)
  },
})

// ── 检索 ────────────────────────────────────────────────────────

/** knowledge:search —— 在已建索引里做文本与向量的混合检索。 */
const searchKnowledge = defineKnowledgeTool<KnowledgeToolOperationsSearchInput>({
  name: KnowledgeToolNames.search,
  role: 'memory',
  category: KnowledgeToolCategoryId,
  summary: '搜索工作区的知识。',
  suitable: ['召回文档或代码知识。'],
  forbidden: ['不要拿它替代直接读已知文件。'],
  protocol: [
    '零命中且这个工作区还没建过索引时，会自动补一次增量同步再重搜，'
      + '结果里的 autoSync 会说明这件事发生过。',
    'autoSync 出现而 count 仍为 0 = 索引是新建的且确实没有匹配内容，不要再调 knowledge:sync 重试。',
  ],
  usage: ['传 query；宿主没有激活的工作区时必须显式传 workspaceRoot。'],
  examples: [{ query: 'auth token refresh', limit: 5 }],
  notes: ['绑定工作区，不跨项目兜底。'],
  schema: z.object({
    query: z.string().trim().min(1).describe(
      parameterDescription({
        description: '要检索的知识查询语句。',
      })
    ),
    workspaceRoot: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '可选的工作区根目录。',
          notes: [
            '省略时用宿主当前激活的工作区。',
            '宿主没有激活的工作区时必须显式传入。',
          ],
        })
      ),
    sourceKinds: z
      .array(knowledgeSourceKindSchema)
      .max(KnowledgeToolLimits.sourceKinds)
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
      .max(KnowledgeToolLimits.pathHints)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的路径提示。',
          usage: ['用来抬高相关文件的召回排序。'],
        })
      ),
    symbolHints: z
      .array(z.string().min(1))
      .max(KnowledgeToolLimits.symbolHints)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的符号提示。',
          usage: ['用来抬高相关代码知识的召回排序。'],
        })
      ),
    documentIds: z
      .array(z.string().min(1))
      .max(KnowledgeToolLimits.documentIds)
      .optional()
      .describe(
        parameterDescription({
          description: '可选的知识文档 id 过滤范围。',
        })
      ),
    limit: z
      .number()
      .transform((value) => Math.min(KnowledgeToolLimits.searchResults, Math.max(1, Math.round(value))))
      .optional()
      .describe(
        parameterDescription({
          description: '返回结果的最大数量。',
          notes: [`上限 ${KnowledgeToolLimits.searchResults}，超出自动钳制。`],
        })
      ),
  }),
  permissions: ['memory:read'],
  capabilities: KnowledgeReadCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    return knowledgeToolOperations.search(input, ctx)
  },
})

// ── 分组与挂载 ──────────────────────────────────────────────────

/** knowledge 类别的三个公开工具，按工具名索引。 */
export const knowledgeTools: Readonly<Record<string, KnowledgeTool<any>>> =
  toolDescriptions.forCategory(
    {
      [KnowledgeToolNames.diagnostics]: getKnowledgeDiagnostics,
      [KnowledgeToolNames.sync]: syncKnowledgeWorkspace,
      [KnowledgeToolNames.search]: searchKnowledge,
    },
    KnowledgeToolCategoryId
  )
