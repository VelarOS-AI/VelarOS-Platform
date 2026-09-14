/** 历史会话保留的第 1 版模型契约；新会话使用当前工具集合。 */
import { z } from 'zod'

import { isArray, isPresent, isUndefined, Log } from '@velaros-ai/core'

import { ProjectReadCapability, ProjectWriteCapability } from '../agent/ProjectCapabilities'
import { resolveProjectEditTarget, saveProjectEditTarget } from '../agent/ProjectEditTarget'
import { runWithProjectExecutionGate } from '../agent/ProjectExecutionGate'
import { registerProjectFileContext, snapshotFromRead } from '../agent/ProjectFileContext'
import { executeAgentProjectRead, executeAgentProjectSearch } from '../agent/ProjectKernelPort'
import { projectList } from '../agent/tools/list'
import { projectRun } from '../agent/tools/run'
import { defineProjectTool, type ProjectToolCollection } from '../agent/tools/shared'
import { applyProjectEditTransaction } from '../agent/tools/transaction'
import { type ProjectEditOperationsSchema, type ProjectModelEditInput, ProjectModelEditSchema } from '../edits/schema'
import { type ProjectCodeQuery, ProjectCodeQuerySchema } from '../project-code-query'
import { LegacyProjectToolNames as ProjectToolNames } from '../project-tool-names'

const ProjectRangeSchema = z
  .strictObject({
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    startColumn: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('startLine 上从 1 开始的 UTF-16 列。'),
    endColumn: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('endLine 上从 1 开始的排他 UTF-16 结束列。'),
  })
  .superRefine((range, context) => {
    const startLine = range.startLine ?? 1
    if (isPresent(range.endColumn) && isUndefined(range.endLine)) {
      context.addIssue({
        code: 'custom',
        message: '使用 endColumn 时必须同时提供 endLine。',
        path: ['endColumn'],
      })
    }
    if (isPresent(range.endLine) && range.endLine < startLine) {
      context.addIssue({
        code: 'custom',
        message: 'endLine 不能早于 startLine。',
        path: ['endLine'],
      })
    }
    if (
      (range.endLine ?? startLine) === startLine &&
      isPresent(range.startColumn) &&
      isPresent(range.endColumn) &&
      range.endColumn < range.startColumn
    ) {
      context.addIssue({
        code: 'custom',
        message: '同一行的 endColumn 不能早于 startColumn。',
        path: ['endColumn'],
      })
    }
  })
  .optional()

const projectRead = defineProjectTool<{
  path: string | string[]
  range?: z.infer<typeof ProjectRangeSchema>
  maxChars?: number
  baseRevisions?: Record<string, string>
}>({
  inputContractVersion: 1,
  name: ProjectToolNames.read,
  category: 'project-files',
  role: 'inspect',
  summary: '读取项目根目录内的一个或多个文本文件，并返回修订版本与分页信息。',
  usage: [
    'contentFormat=line-numbered 时，content 每行的 N| 前缀是行号标注，不属于源码；replace_lines 直接使用这些行号，replace_text 的 oldText 不包含标注。',
    'maxChars 是本次调用内所有文件共享的总字符预算；批量读取会公平分配并回收未使用额度。',
    'hasMore=true 时直接使用对应文件返回的 continuation；长行续读会带 startColumn。',
    'range 对每个文件逐个应用：endLine 超出时读到该文件末尾；startLine 超出某文件总行数时该文件返回空 content、totalLines 与 note，不影响其它文件。',
    '批量读取中单个文件读取失败会记入 issues（带 path、code 与原因），其它文件照常返回。',
  ],
  examples: [{ path: ['src/contentHash.ts', 'src/cacheKey.ts'] }],
  schema: z
    .object({
      path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
      range: ProjectRangeSchema,
      maxChars: z
        .number()
        .int()
        .positive()
        .max(500_000)
        .optional()
        .describe(
          '本次调用内所有文件共享的最大 Unicode 字符数；默认 500000。批量读取时至少等于文件数。'
        ),
      baseRevisions: z.record(z.string(), z.string()).optional(),
    })
    .superRefine((input, context) => {
      const pathCount = isArray(input.path) ? input.path.length : 1
      if (!isUndefined(input.maxChars) && input.maxChars < pathCount) {
        context.addIssue({
          code: 'custom',
          path: ['maxChars'],
          message: `批量读取 ${pathCount} 个文件时 maxChars 至少为 ${pathCount}，确保每个文件都能取得进展。`,
        })
      }
    }),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 10 },
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    const files = registerProjectFileContext(context)
    const sequence = files?.beginObservation()
    const result = await executeAgentProjectRead(kernel, input, {
      rootPath: context.project.getRootPath(),
    })
    if (files && !isUndefined(sequence))
      await files.observe(
        result.files.flatMap((file) => {
          const snapshot = snapshotFromRead(result.rootPath, file)
          return snapshot ? [snapshot] : []
        }),
        sequence,
        context.toolCallId
      )
    for (const file of result.files) {
      try {
        const editTarget = await saveProjectEditTarget(context, file, input.range)
        if (editTarget) Object.assign(file, { editTarget })
      } catch (error) {
        Log.tag('legacy-project-tools').debug('定位引用保存失败，保留已有路径、版本和行号。', { error })
      }
    }
    return result
  },
})

const projectSearch = defineProjectTool<{
  query: string
  path?: string
  include?: string[]
  exclude?: string[]
  regex?: boolean
  caseSensitive?: boolean
  limit?: number
}>({
  inputContractVersion: 1,
  name: ProjectToolNames.search,
  category: 'project-files',
  role: 'inspect',
  summary: '在项目文件正文中执行有界文本或正则搜索。',
  usage: [
    'regex=false（默认）时 query 按字面匹配，| 不表示「或」；多选一或模式匹配请设 regex=true。',
  ],
  examples: [{ query: 'contentHash', path: 'src' }],
  schema: z.object({
    query: z.string().min(1),
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(20).optional(),
    exclude: z.array(z.string().min(1)).max(20).optional(),
    regex: z.boolean().optional().default(false),
    caseSensitive: z.boolean().optional().default(false),
    limit: z.number().int().positive().max(100).optional().default(30),
  }),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 30 },
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    return executeAgentProjectSearch(kernel, input)
  },
})

const ProjectWriteModeSchema = z.enum(['create', 'overwrite', 'append', 'prepend'])

type ProjectWriteInput = {
  path: string
  content: string
  mode: z.infer<typeof ProjectWriteModeSchema>
  cwd?: string
  skipIfAlreadyPresent?: boolean
  baseRevision?: string
}

function projectWriteOperation(
  input: ProjectWriteInput
): z.input<typeof ProjectEditOperationsSchema>[number] {
  switch (input.mode) {
    case 'create':
      return {
        operation: {
          type: 'create_file',
          path: input.path,
          content: input.content,
        },
      }
    case 'overwrite':
      return {
        operation: {
          type: 'create_file',
          path: input.path,
          content: input.content,
          overwrite: true,
        },
      }
    case 'append':
      return {
        operation: {
          type: 'append_text',
          path: input.path,
          text: input.content,
          skipIfAlreadyPresent: input.skipIfAlreadyPresent,
        },
      }
    case 'prepend':
      return {
        operation: {
          type: 'prepend_text',
          path: input.path,
          text: input.content,
          skipIfAlreadyPresent: input.skipIfAlreadyPresent,
        },
      }
  }
}

/**
 * 长文本落盘走浅层合同：模型不需要先选择十三分支联合，再把正文嵌进事务意图包装层。
 * 执行仍复用 Project Kernel 的同一套授权、prepare/apply/rollback 事务边界。
 */
const projectWrite = defineProjectTool<ProjectWriteInput>({
  inputContractVersion: 1,
  name: ProjectToolNames.write,
  category: 'project-changes',
  role: 'edit',
  summary: '把一段完整文本创建、覆盖、追加或前置写入一个项目文件。',
  suitable: ['创建报告、配置、源码或其他以完整文本为主体的单文件内容。'],
  forbidden: [
    '不要用于精确替换、符号编辑、导入编辑、JSON Patch 或多文件原子事务；这些使用 project:edit。',
  ],
  protocol: ['写入仍由 Project Kernel 以可回滚事务执行；path 必须位于当前项目边界内。'],
  usage: [
    '传 path、content 和明确的 mode；append/prepend 可用 skipIfAlreadyPresent 保证幂等。失败回执有 inputReuse 时，用 reuse + changes 只修改错误字段，无需重发正文。',
  ],
  examples: [{ path: 'reports/review.md', content: '# Review\n\nPassed.', mode: 'create' }],
  notes: ['mode=create 拒绝覆盖既有文件；mode=overwrite 才允许整文件替换。'],
  schema: z.strictObject({
    path: z.string().min(1),
    content: z.string(),
    mode: ProjectWriteModeSchema,
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        '当前项目内的工作目录，可用相对路径或绝对路径；省略时使用当前项目目录。不能用它切换到项目之外。'
      ),
    skipIfAlreadyPresent: z.boolean().optional(),
    baseRevision: z.string().min(1).optional(),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'common', rank: 40 },
  isConcurrencySafe: () => false,
  execute: (input, context) =>
    applyProjectEditTransaction(
      {
        operations: [projectWriteOperation(input)],
        cwd: input.cwd,
        operationLabel: `${input.mode} 项目文件`,
        targetPath: input.path,
        baseRevisions: input.baseRevision ? { [input.path]: input.baseRevision } : undefined,
      },
      context
    ),
})

const projectEdit = defineProjectTool<ProjectModelEditInput>({
  inputContractVersion: 1,
  name: ProjectToolNames.edit,
  category: 'project-changes',
  role: 'edit',
  summary: '以一个可回滚事务执行精确文本、符号、导入、JSON 或多文件结构化修改。',
  suitable: ['需要精确替换、锚点插入、符号/导入/JSON 修改，或多个操作必须原子提交。'],
  forbidden: [
    '不要用它承载单文件报告或整段长文本；创建、覆盖、追加或前置完整内容使用 project:write。',
  ],
  usage: [
    'edits 是扁平操作数组，每项直接写 type、path 和修改内容；先取得当前源码再改；Current project files 已提供的最新版本和行号可直接用于连续编辑。删除片段用 replace_text 并将 newText 设为空字符串。单文件追加/前置用 project:write；多文件一起修改可在本事务组合。',
  ],
  notes: [
    '读取结果有 editTarget 时，可用 {type:"replace_selection",selectionRef:editTarget,newLines:[...]} 替换刚读的完整行窗口，不必重复填写路径、版本和行号。',
    '失败回执有 inputReuse 时，调用本工具并传 reuse + changes，如 changes:[{op:"set",path:["edits",0,"occurrence"],value:2}]；未变更的大段正文自动复用。',
    '已读到明确行号、旧源码含大量转义或锚点重复时，优先 replace_lines：传 snapshot.revision、startLine/endLine 和 newLines（每项一行），不传 oldText。一次事务同文件先做此操作，后续可用文本或符号操作。',
    '文本匹配失败时，错误会给出最接近的候选行、首个分歧行与原因（缩进、行尾空白、反斜杠、引号）；按提示只修正分歧行，不必整段重读。',
    '仅行尾空白或换行符不同且全文唯一时会宽容应用，并在结果 notes 中说明。',
  ],
  examples: [
    {
      edits: [
        {
          type: 'replace_text',
          path: 'src/index.ts',
          oldText: 'const ready = false',
          newText: 'const ready = true',
        },
      ],
    },
  ],
  schema: ProjectModelEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'situational', rank: 10 },
  isConcurrencySafe: () => false,
  execute: async (input, context) =>
    applyProjectEditTransaction(
      {
        operations: await Promise.all(
          input.edits.map(async (operation) => ({
            operation:
              operation.type === 'replace_selection'
                ? await resolveProjectEditTarget(context, operation)
                : operation,
          }))
        ),
        cwd: input.cwd,
        operationLabel: '结构化修改项目文件',
        baseRevisions: input.baseRevisions,
      },
      context
    ),
})

const projectRollback = defineProjectTool<{ transactionId: string }>({
  inputContractVersion: 1,
  name: ProjectToolNames.rollback,
  category: 'project-changes',
  role: 'edit',
  summary: '撤销由 project:edit 创建并已应用的项目事务。',
  examples: [{ transactionId: 'transaction-id-from-project-edit' }],
  schema: z.object({ transactionId: z.string().min(1) }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: { tier: 'situational', rank: 20 },
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    return context.project.runWithApproval(() =>
      runWithProjectExecutionGate(
        context.project.getRootPath(),
        true,
        context.abortSignal,
        async () => {
          const kernel = await context.project.kernel()
          const paths = kernel.getTransaction(input.transactionId)?.changedFiles ?? []
          const files = registerProjectFileContext(context)
          try {
            return await kernel.rollback(input)
          } finally {
            files?.touch(context.project.getRootPath(), paths)
            await files?.prepare(context.toolCallId)
          }
        }
      )
    )
  },
})

const projectQueryCode = defineProjectTool<ProjectCodeQuery>({
  inputContractVersion: 1,
  name: ProjectToolNames.queryCode,
  category: 'development-code',
  role: 'inspect',
  summary: '查询项目代码的符号、引用、依赖、诊断和影响范围。',
  suitable: [
    '需要语义级符号、引用、导入关系、诊断或影响面分析。',
    '需要在 CodeGraph 可用时构建或查询结构化代码图谱。',
  ],
  forbidden: ['普通字面量或正则搜索应使用 project:search。'],
  protocol: ['先选择 action，再提供该 action 所需的字段。'],
  usage: [
    'find_symbols、find_references、language_diagnostics 等 action 始终由内置语言服务提供。',
    'search_symbols、callers、impact、build_index 等图谱 action 需要安装并启用 CodeGraph。',
  ],
  examples: [
    { action: 'find_references', symbol: 'UserService', path: 'src/user.ts' },
    { action: 'search_symbols', query: 'UserService', limit: 20 },
  ],
  notes: [
    'CodeGraph 是同一工具的可选增强后端，不会改变工具身份。',
    '关系类 action 的 nodeId 必须来自前序查询结果，不要猜测。',
    'language_diagnostics 的 path 可以是文件或目录；结果带 degraded 或 note 字段时诊断不完整，空诊断不代表通过。',
  ],
  schema: ProjectCodeQuerySchema,
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: { tier: 'common', rank: 25 },
  isConcurrencySafe: () => true,
  execute: (input, context) => context.project.queryCode(input, context),
})


export const legacyProjectTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.read]: projectRead,
  [ProjectToolNames.list]: projectList,
  [ProjectToolNames.search]: projectSearch,
  [ProjectToolNames.queryCode]: projectQueryCode,
  [ProjectToolNames.write]: projectWrite,
  [ProjectToolNames.edit]: projectEdit,
  [ProjectToolNames.rollback]: projectRollback,
  [ProjectToolNames.run]: projectRun,
})
export { ProjectWriteModeSchema as LegacyProjectWriteModeSchema }
