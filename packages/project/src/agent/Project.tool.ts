import { z } from 'zod'

import type { ToolCategoryId } from '@velaros-ai/agent/protocol'
import { createManualApprovalOptions, defineToolRuntimeSpec } from '@velaros-ai/agent/tool-contract'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  analyzeCommandExecution,
  buildBackgroundCommandConfirmationMessage,
  isParallelCommandExecutionSafe,
  isShellCommandReadOnly,
} from '../command-execution-policy.js'
import { ProjectEditOperationsSchema } from '../edit-schema.js'
import { type ProjectCodeQuery, ProjectCodeQuerySchema } from '../project-code-query.js'
import { ProjectToolNames } from '../project-tool-names.js'

import { executeAgentProjectRead, executeAgentProjectSearch } from './ProjectKernelPort.js'
import type { ProjectToolContext,VelaTool } from './Types.js'

type ProjectToolCollection = Readonly<Record<string, VelaTool<any>>>

function defineProjectTool<TInput extends Record<string, any>>(input: {
  name: string
  category: ToolCategoryId
  role: 'inspect' | 'edit' | 'execute'
  summary: string
  suitable?: readonly [string, ...string[]]
  forbidden?: readonly [string, ...string[]]
  protocol?: readonly [string, ...string[]]
  usage?: readonly [string, ...string[]]
  examples: readonly [Record<string, unknown>, ...Array<Record<string, unknown>>]
  notes?: readonly [string, ...string[]]
  schema: VelaTool<TInput>['schema']
  permissions: VelaTool<TInput>['permissions']
  capabilities?: VelaTool<TInput>['capabilities']
  exposure?: VelaTool<TInput>['exposure']
  hideWhenUnavailable?: VelaTool<TInput>['hideWhenUnavailable']
  isAvailable?: VelaTool<TInput>['isAvailable']
  isConcurrencySafe?: VelaTool<TInput>['isConcurrencySafe']
  execute: VelaTool<TInput>['execute']
}): VelaTool<TInput> {
  const {
    name,
    category,
    role,
    summary,
    suitable,
    forbidden,
    protocol,
    usage,
    examples,
    notes,
    ...tool
  } = input
  return Object.freeze(defineToolRuntimeSpec({
    name,
    category,
    role,
    summary,
    suitable: suitable ?? ['需要完成该工具职责所描述的项目操作。'],
    forbidden: forbidden ?? ['目标不属于当前项目边界。'],
    protocol: protocol ?? ['只使用当前项目上下文解析路径和执行操作。'],
    usage: usage ?? ['参数必须来自当前请求或前序工具结果。'],
    examples,
    notes: notes ?? ['返回值是当前操作的权威结果。'],
    ...tool,
  }))
}

function runInProjectDirectory<T>(
  context: ProjectToolContext,
  cwd: LooseOptional<string>,
  action: () => Promise<T>
): Promise<T> {
  return cwd ? context.project.runInDirectory(cwd, action) : action()
}

/**
 * Agent callers naturally express include/exclude globs relative to the directory being listed.
 * The Project kernel intentionally matches portable project-root-relative paths. Accept both forms
 * at the Agent boundary so `path: "scripts/build", include: ["*.mjs"]` does not silently return an
 * empty list while callers that already provide `scripts/build/*.mjs` retain identical behavior.
 */
function scopeProjectListPatterns(
  path: LooseOptional<string>,
  patterns: LooseOptional<readonly string[]>
): LooseOptional<string[]> {
  if (!patterns) return undefined
  const base = path?.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!base || base === '.' || base.startsWith('/') || /^[a-zA-Z]:\//.test(base))
    return [...patterns]
  return patterns.map((pattern) => {
    const portable = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (!portable || portable.startsWith('/') || portable === base || portable.startsWith(`${base}/`))
      return portable
    return `${base}/${portable}`
  })
}

const ProjectRangeSchema = z.object({
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  startColumn: z.number().int().nonnegative().optional(),
  endColumn: z.number().int().nonnegative().optional(),
}).optional()

const projectRead = defineProjectTool<{
  path: string | string[]
  range?: z.infer<typeof ProjectRangeSchema>
  maxChars?: number
  baseRevisions?: Record<string, string>
}>({
  name: ProjectToolNames.read,
  category: 'project-files',
  role: 'inspect',
  summary: '读取项目根目录内的一个或多个文本文件，并返回修订版本与分页信息。',
  examples: [{ path: ['src/contentHash.ts', 'src/cacheKey.ts'] }],
  schema: z.object({
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
    range: ProjectRangeSchema,
    maxChars: z.number().int().positive().max(500_000).optional(),
    baseRevisions: z.record(z.string(), z.string()).optional(),
  }),
  permissions: ['fs:read'],
  exposure: { tier: 'common', rank: 10 },
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    return executeAgentProjectRead(kernel, input, {
      rootPath: context.project.getRootPath(),
    })
  },
})

const projectList = defineProjectTool<{
  path?: string
  include?: string[]
  exclude?: string[]
  recursive?: boolean
  maxDepth?: number
  limit?: number
}>({
  name: ProjectToolNames.list,
  category: 'project-files',
  role: 'inspect',
  summary: '在项目根目录内列出或按 glob 发现文件和目录。',
  protocol: ['include/exclude 默认相对 path 匹配；已经写成项目根相对路径的 glob 也可直接使用。'],
  examples: [{ path: '.', maxDepth: 2 }],
  schema: z.object({
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(20).optional(),
    exclude: z.array(z.string().min(1)).max(20).optional(),
    recursive: z.boolean().optional().default(false),
    maxDepth: z.number().int().nonnegative().max(30).optional(),
    limit: z.number().int().positive().max(2_000).optional().default(200),
  }),
  permissions: ['fs:read'],
  exposure: { tier: 'common', rank: 20 },
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    const limit = input.limit ?? 200
    const entries = await kernel.listFiles({
      path: input.path,
      include: scopeProjectListPatterns(input.path, input.include),
      exclude: scopeProjectListPatterns(input.path, input.exclude),
      recursive: input.recursive,
      maxDepth: input.maxDepth,
      maxFiles: limit + 1,
    })
    return {
      rootPath: context.project.getRootPath(),
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
    }
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
  name: ProjectToolNames.search,
  category: 'project-files',
  role: 'inspect',
  summary: '在项目文件正文中执行有界文本或正则搜索。',
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
}

function projectWriteOperation(input: ProjectWriteInput): z.input<typeof ProjectEditOperationsSchema>[number] {
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

async function applyProjectEditTransaction(
  input: {
    operations: z.input<typeof ProjectEditOperationsSchema>
    cwd?: string
    operationLabel: string
    targetPath?: string
  },
  context: ProjectToolContext
) {
  context.abortSignal.throwIfAborted()
  const authorization = await context.project.prepareMutation({
    cwd: input.cwd,
    operation: input.operationLabel,
    targetPath: input.targetPath,
  })
  if (!authorization.approved) return {
      approved: false,
      changed: false,
      message: authorization.rejectionMessage ?? authorization.message,
    }

  return context.project.runInDirectory(authorization.rootPath, async () =>
    context.project.runWithApproval(async () => {
      const kernel = await context.project.kernel()
      const transaction = await kernel.prepareEdit({ operations: input.operations })
      try {
        const applied = await kernel.applyEdit({ transactionId: transaction.transactionId })
        return {
          changed: !isEmpty(applied.changedFiles),
          transactionId: transaction.transactionId,
          changedFiles: applied.changedFiles,
          revisions: applied.newRevisions,
          diff: transaction.diff,
          changedLines: transaction.changedLines,
          risk: transaction.risk,
        }
      } catch (error) {
        kernel.discardTransaction(transaction.transactionId)
        throw error
      }
    })
  )
}

/**
 * 长文本落盘走浅层合同：模型不需要先选择十三分支联合，再把正文嵌进事务意图包装层。
 * 执行仍复用 Project Kernel 的同一套授权、prepare/apply/rollback 事务边界。
 */
const projectWrite = defineProjectTool<ProjectWriteInput>({
  name: ProjectToolNames.write,
  category: 'project-changes',
  role: 'edit',
  summary: '把一段完整文本创建、覆盖、追加或前置写入一个项目文件。',
  suitable: ['创建报告、配置、源码或其他以完整文本为主体的单文件内容。'],
  forbidden: ['不要用于精确替换、符号编辑、导入编辑、JSON Patch 或多文件原子事务；这些使用 project:edit。'],
  protocol: ['写入仍由 Project Kernel 以可回滚事务执行；path 必须位于当前项目边界内。'],
  usage: ['传 path、content 和明确的 mode；append/prepend 可用 skipIfAlreadyPresent 保证幂等。'],
  examples: [{ path: 'reports/review.md', content: '# Review\n\nPassed.', mode: 'create' }],
  notes: ['mode=create 拒绝覆盖既有文件；mode=overwrite 才允许整文件替换。'],
  schema: z.strictObject({
    path: z.string().min(1),
    content: z.string(),
    mode: ProjectWriteModeSchema,
    cwd: z.string().min(1).optional(),
    skipIfAlreadyPresent: z.boolean().optional(),
  }),
  permissions: ['fs:read', 'fs:write'],
  exposure: { tier: 'common', rank: 40 },
  isConcurrencySafe: () => false,
  execute: (input, context) =>
    applyProjectEditTransaction(
      {
        operations: [projectWriteOperation(input)],
        cwd: input.cwd,
        operationLabel: `${input.mode} 项目文件`,
        targetPath: input.path,
      },
      context
    ),
})

const projectEdit = defineProjectTool<{
  operations: z.input<typeof ProjectEditOperationsSchema>
  cwd?: string
}>({
  name: ProjectToolNames.edit,
  category: 'project-changes',
  role: 'edit',
  summary: '以一个可回滚事务执行精确文本、符号、导入、JSON 或多文件结构化修改。',
  suitable: ['需要精确替换、锚点插入、符号/导入/JSON 修改，或多个操作必须原子提交。'],
  forbidden: ['不要用它承载单文件报告或整段长文本；创建、覆盖、追加或前置完整内容使用 project:write。'],
  usage: ['每个 operations 项包含 operation；先读取目标修订，再提交最小结构化修改。'],
  examples: [{
    operations: [{
      operation: {
        type: 'replace_text',
        path: 'src/index.ts',
        oldText: 'const ready = false',
        newText: 'const ready = true',
      },
    }],
  }],
  schema: z.object({
    operations: ProjectEditOperationsSchema.min(1).max(20),
    cwd: z.string().optional(),
  }),
  permissions: ['fs:read', 'fs:write'],
  exposure: { tier: 'situational', rank: 10 },
  isConcurrencySafe: () => false,
  execute: (input, context) =>
    applyProjectEditTransaction(
      {
        operations: input.operations,
        cwd: input.cwd,
        operationLabel: '结构化修改项目文件',
      },
      context
    ),
})

const projectRollback = defineProjectTool<{ transactionId: string }>({
  name: ProjectToolNames.rollback,
  category: 'project-changes',
  role: 'edit',
  summary: '撤销由 project:edit 创建并已应用的项目事务。',
  examples: [{ transactionId: 'transaction-id-from-project-edit' }],
  schema: z.object({ transactionId: z.string().min(1) }),
  permissions: ['fs:read', 'fs:write'],
  exposure: { tier: 'situational', rank: 20 },
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    return context.project.runWithApproval(async () =>
      (await context.project.kernel()).rollback(input)
    )
  },
})

async function runProjectCommand(
  input: {
    command: string
    cwd?: string
    timeoutMs?: number
    background?: boolean
    maxOutputChars?: number
  },
  context: ProjectToolContext
) {
  context.abortSignal.throwIfAborted()
  const plan = analyzeCommandExecution(input.command)
  const background = input.background ?? plan.shouldStartInBackground
  if (background && !context.system.canStartBackgroundCommands())
    throw new AppError('PERMISSION', '当前运行时不允许启动后台项目进程。')

  if (plan.isDangerous) {
    const decision = await context.approval.awaitConfirmationDecision(
      buildBackgroundCommandConfirmationMessage(
        input.command,
        plan,
        '当前项目',
        background
      ),
      context.abortSignal,
      // 与 system:run 同一条判决：破坏性命令按 riskScope 记忆 = 首次批准后整会话静默放行同类，
      // 用户点头的是 `rm -rf ./dist`，之后跑的可能是 `rm -rf ~`。不可逆伤害每次都要亲自裁决。
      createManualApprovalOptions({
        approvalRisk: 'high',
        riskScope: 'project-command:dangerous',
      })
    )
    if (!decision.approved) return {
      approved: false,
      skipped: true,
      command: input.command,
      message: decision.message ?? '用户拒绝执行该危险命令。',
    }
  }

  if (!isShellCommandReadOnly(input.command)) {
    const authorization = await context.project.prepareMutation({
      cwd: input.cwd,
      operation: `运行可能修改项目的命令：${input.command}`,
    })
    if (!authorization.approved) return {
      approved: false,
      skipped: true,
      command: input.command,
      message: authorization.rejectionMessage ?? authorization.message,
    }
  }

  const run = () => context.project.runCommand(
    input.command,
    {
      timeoutMs: input.timeoutMs,
      background,
      maxOutputChars: input.maxOutputChars,
    },
    plan.isDangerous,
    context.abortSignal
  )
  return input.cwd ? context.project.runInDirectory(input.cwd, run) : run()
}

const projectRun = defineProjectTool<{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  parallel?: boolean
}>({
  name: ProjectToolNames.run,
  category: 'project-execution',
  role: 'execute',
  summary: '在项目边界内运行可取消、可审计且支持后台任务的命令。',
  examples: [{ command: 'bun test' }],
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    background: z.boolean().optional(),
    maxOutputChars: z.number().int().positive().max(50_000).optional(),
    parallel: z.boolean().optional(),
  }),
  permissions: ['process:exec'],
  exposure: { tier: 'common', rank: 50 },
  isConcurrencySafe: (input) => isParallelCommandExecutionSafe(input),
  execute: runProjectCommand,
})

const projectQueryCode = defineProjectTool<ProjectCodeQuery>({
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
  ],
  schema: ProjectCodeQuerySchema,
  permissions: ['fs:read'],
  exposure: { tier: 'common', rank: 25 },
  isConcurrencySafe: () => true,
  execute: (input, context) => context.project.queryCode(input, context),
})

const projectFileTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.read]: projectRead,
  [ProjectToolNames.list]: projectList,
  [ProjectToolNames.search]: projectSearch,
})
const projectChangeTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.write]: projectWrite,
  [ProjectToolNames.edit]: projectEdit,
  [ProjectToolNames.rollback]: projectRollback,
})
const projectExecutionTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.run]: projectRun,
})
const projectCodeTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.queryCode]: projectQueryCode,
})
const projectTools: ProjectToolCollection = Object.freeze({
  ...projectFileTools,
  ...projectCodeTools,
  ...projectChangeTools,
  ...projectExecutionTools,
})

export {
  defineProjectTool,
  projectChangeTools,
  projectCodeTools,
  projectExecutionTools,
  projectFileTools,
  projectTools,
  runInProjectDirectory,
  scopeProjectListPatterns,
}
