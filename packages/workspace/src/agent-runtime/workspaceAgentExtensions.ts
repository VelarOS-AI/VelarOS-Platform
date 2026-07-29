/**
 * Workspace Agent 工具 schema 增量层。
 *
 * 包（@velaros-ai/workspace）提供内核契约；本模块声明 Agent 工具层字段（cwd、confirmRisk、
 * discovery 门面等），供 Kernel.tool 与 parity 测试复用，避免在工具文件内手抄 Zod。
 */
import { z } from 'zod'

import { isNumber } from '@velaros-ai/core'
import {
  requiredResultLimit,
} from '@velaros-ai/core/utils/ToolInputBounds'

import {
  applyEditInputSchema,
  buildEvidenceInputSchema,
  diffInputSchema,
  readInputSchema,
  resolveTargetInputSchema,
  rollbackInputSchema,
  runBatchInputSchema,
  statInputSchema,
  statusInputSchema,
  symbolsInputSchema,
  trustLabelSchema,
  validateInputSchema,
} from '../tool-schemas.js'
import { WorkspaceKernelToolNames as wsTool } from '../workspace-tool-names.js'

import {
  parameterDescription,
  workspaceCaseSensitiveParam,
  workspaceCwdDescription,
  workspaceExcludeGitignoredParam,
  workspaceExcludeParam,
  workspaceExcludePresetsParam,
  workspaceExtensionsParam,
  workspaceMaxResultsParam,
  workspaceRegexParam,
  WorkspaceSearchExcludePresetIds,
  workspaceTrustParam,
} from './KernelToolShared'

/** 多数 inspect/edit 工具共用的 cwd 字段。 */
export const workspaceAgentCwdField = {
  cwd: z.string().optional().describe(workspaceCwdDescription),
} as const

/** 发现类工具的风险确认字段。 */
export const workspaceAgentConfirmRiskField = {
  confirmRisk: z
    .boolean()
    .optional()
    .describe(
      parameterDescription({
        description: '是否确认执行风险预检拦截的调用。',
        notes: [`仅当返回 needs_model_review 后仍需执行时传 true。`],
      })
    ),
} as const

export const workspaceAgentReadSchema = readInputSchema.extend(workspaceAgentCwdField)

export const workspaceAgentStatSchema = statInputSchema.extend({
  ...workspaceAgentCwdField,
  path: z.string().min(1).describe(
    parameterDescription({
      description: '要检查的工作区路径。',
      usage: ['传相对工作区根目录的路径。'],
    })
  ),
})

export const workspaceAgentSymbolsSchema = symbolsInputSchema.extend({
  path: z.string().min(1).describe(
    parameterDescription({
      description: '要抽取符号的文件路径。',
      usage: ['传相对工作区根目录的路径。'],
    })
  ),
})

export const workspaceAgentResolveTargetSchema = resolveTargetInputSchema.extend({
  path: z.string().min(1).describe(
    parameterDescription({
      description: '目标文件路径。',
      usage: ['传相对工作区根目录的路径。'],
    })
  ),
  baseRevision: z.string().optional().describe(
    parameterDescription({
      description: '调用方观察到的文件 revision，用来防止基于过期内容定位。',
    })
  ),
  trust: trustLabelSchema.optional().describe(workspaceTrustParam),
})

export const workspaceAgentBuildEvidenceSchema =
  buildEvidenceInputSchema.extend(workspaceAgentCwdField)

export const workspaceAgentDiffSchema = diffInputSchema.extend({
  sessionTransactionIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      parameterDescription({
        description: '当前会话工作区事务 ID 集合。',
        notes: ['只合并查看这些事务的 diff。'],
      })
    ),
})

export const workspaceAgentApplyEditSchema = applyEditInputSchema.extend({
  ...workspaceAgentConfirmRiskField,
  transactionId: z.string().min(1).describe(
    parameterDescription({
      description: '要应用的编辑事务 ID。',
    })
  ),
})

export const workspaceAgentValidateSchema = validateInputSchema

export const workspaceAgentRollbackSchema = rollbackInputSchema.extend({
  transactionId: z.string().min(1).describe(
    parameterDescription({
      description: '要回滚的已应用事务 ID。',
    })
  ),
})

export const workspaceAgentRunBatchSchema = runBatchInputSchema

/** Agent 正文搜索门面：path/glob/extensions 在 execute 时映射为 kernel 的 root/include。 */
export const workspaceAgentSearchSchema = z.object({
  ...workspaceAgentCwdField,
  query: z
    .string()
    .min(1)
    .describe(
      parameterDescription({
        description: '文件正文查询条件。',
        notes: ['不是路径过滤器；按路径或文件名发现请使用路径列出能力。'],
      })
    ),
  regex: z.boolean().optional().describe(workspaceRegexParam),
  caseSensitive: z.boolean().optional().describe(workspaceCaseSensitiveParam),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe(workspaceMaxResultsParam),
  glob: z.string().optional().describe(
    parameterDescription({
      description: '文件 glob 过滤。',
      usage: ['例如 *.ts、**/*.spec.ts。'],
    })
  ),
  extensions: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(workspaceExtensionsParam),
  excludePresets: z
    .array(z.enum(WorkspaceSearchExcludePresetIds))
    .max(5)
    .optional()
    .describe(workspaceExcludePresetsParam),
  exclude: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe(workspaceExcludeParam),
  excludeGitignored: z.boolean().optional().describe(workspaceExcludeGitignoredParam),
  path: z
    .string()
    .optional()
    .describe(
      parameterDescription({
        description: '正文搜索的相对子树根。',
        notes: ['仍然搜索文件内容，不列目录。'],
      })
    ),
  ...workspaceAgentConfirmRiskField,
})

/** Agent 路径发现/列目录门面：limit/view/query 等由 Workspace 端口实现。 */
export const workspaceAgentListFilesSchema = z
  .object({
    ...workspaceAgentCwdField,
    path: z.string().optional().describe(
      parameterDescription({
        description: '列目录或路径发现的起点目录。',
        usage: ['传相对工作区根目录的路径。'],
        notes: ['默认 "."。'],
      })
    ),
    recursive: z.boolean().optional().describe(
      parameterDescription({
        description: '是否递归遍历子目录。',
      })
    ),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(12)
      .optional()
      .describe(
        parameterDescription({
          description: '从 path 起算的遍历深度。',
          notes: ['使用 query、glob 或 extensions 时必填，最大 12。'],
        })
      ),
    limit: requiredResultLimit(500, '最多返回多少条'),
    query: z
      .string()
      .optional()
      .describe(
        parameterDescription({
          description: '路径或名称子串过滤。',
          notes: ['发现模式使用，需配合 maxDepth；不搜索文件正文。'],
        })
      ),
    glob: z
      .string()
      .min(1)
      .optional()
      .describe(
        parameterDescription({
          description: '路径发现 glob。',
          usage: ['例如 **/pages/**。'],
          notes: ['与其他过滤条件一并使用时需要 maxDepth。'],
        })
      ),
    extensions: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(workspaceExtensionsParam),
    include: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        parameterDescription({
          description: '包含路径的 glob 列表。',
          usage: ['例如 src/** 或 **/*.test.ts。'],
        })
      ),
    excludePresets: z
      .array(z.enum(WorkspaceSearchExcludePresetIds))
      .max(5)
      .optional()
      .describe(workspaceExcludePresetsParam),
    exclude: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(workspaceExcludeParam),
    excludeGitignored: z.boolean().optional().describe(workspaceExcludeGitignoredParam),
    view: z
      .enum(['flat', 'tree'])
      .optional()
      .describe(
        parameterDescription({
          description: '返回形态。',
          values: ['flat：返回扁平 entries。', 'tree：返回目录树结构。'],
          notes: ['默认 flat。'],
        })
      ),
    entryTypes: z
      .array(z.enum(['file', 'directory']))
      .max(2)
      .optional()
      .describe(
        parameterDescription({
          description: '路径发现返回的条目类型。',
          values: ['file：只返回文件。', 'directory：只返回目录。'],
          notes: ['省略时返回文件和目录。'],
        })
      ),
    pathMatchMode: z
      .enum(['contains', 'exact', 'fuzzy'])
      .optional()
      .describe(
        parameterDescription({
          description: '路径匹配方式。',
          values: [
            'contains：路径包含 query 即匹配。',
            'exact：路径或名称精确匹配 query。',
            'fuzzy：按模糊匹配候选路径。',
          ],
        })
      ),
    ...workspaceAgentConfirmRiskField,
  })
  // 宽容:recursive 或用了 query/glob/extensions 过滤但没给 maxDepth 时,自动默认一个安全深度,
  // 不再硬报错(模型高频忘传 maxDepth)。深度仍有界(默认 6,字段上限 12)。
  .transform((value) => {
    const needsDepth =
      value.recursive ||
      !!(value.query?.trim() || value.glob?.trim() || value.extensions?.length)
    if (needsDepth && !isNumber(value.maxDepth)) return { ...value, maxDepth: 6 }
    return value
  })

/**
 * Agent 各工具最终输入 schema（包基础 + 增量，或工具门面）。
 * parity 测试与工具注册均引用此映射，避免漂移。
 */
export const workspaceAgentInputSchemas = {
  [wsTool.status]: statusInputSchema,
  [wsTool.read]: workspaceAgentReadSchema,
  [wsTool.stat]: workspaceAgentStatSchema,
  [wsTool.search]: workspaceAgentSearchSchema,
  [wsTool.listFiles]: workspaceAgentListFilesSchema,
  [wsTool.symbols]: workspaceAgentSymbolsSchema,
  [wsTool.resolveTarget]: workspaceAgentResolveTargetSchema,
  [wsTool.buildEvidence]: workspaceAgentBuildEvidenceSchema,
  [wsTool.diff]: workspaceAgentDiffSchema,
  [wsTool.applyEdit]: workspaceAgentApplyEditSchema,
  [wsTool.validate]: workspaceAgentValidateSchema,
  [wsTool.rollback]: workspaceAgentRollbackSchema,
  [wsTool.runBatch]: workspaceAgentRunBatchSchema,
} as const
