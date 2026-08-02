import { z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { assertCanonicalToolId, buildToolContractDescription } from '@velaros-ai/core/tool-contract'

import {
  analyzeCommandExecution,
  buildBackgroundCommandConfirmationMessage,
  isParallelCommandExecutionSafe,
  isShellCommandReadOnly,
} from '../command-execution-policy.js'
import { ProjectEditOperationsSchema } from '../edit-schema.js'
import { ProjectToolNames } from '../project-tool-names.js'

import { executeAgentProjectRead } from './ProjectKernelPort.js'
import type { ProjectToolContext,VelaTool } from './Types.js'

type ProjectToolCollection = Readonly<Record<string, VelaTool<any>>>

function defineProjectTool<TInput extends Record<string, any>>(input: {
  name: string
  category: string
  role: 'inspect' | 'edit' | 'execute'
  summary: string
  suitable?: readonly [string, ...string[]]
  forbidden?: readonly [string, ...string[]]
  protocol?: readonly [string, ...string[]]
  usage?: readonly [string, ...string[]]
  examples?: readonly [Record<string, unknown>, ...Array<Record<string, unknown>>]
  notes?: readonly [string, ...string[]]
  schema: VelaTool<TInput>['schema']
  permissions: VelaTool<TInput>['permissions']
  capabilities?: VelaTool<TInput>['capabilities']
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
  assertCanonicalToolId(name)
  return Object.freeze({
    ...tool,
    description: buildToolContractDescription(name, category, {
      role,
      summary,
      suitable: suitable ?? ['需要完成该工具职责所描述的项目操作。'],
      forbidden: forbidden ?? ['目标不属于当前项目边界。'],
      protocol: protocol ?? ['只使用当前项目上下文解析路径和执行操作。'],
      usage: usage ?? ['参数必须来自当前请求或前序工具结果。'],
      examples: examples ?? [{}],
      notes: notes ?? ['返回值是当前操作的权威结果。'],
    }),
  })
}

function runInProjectDirectory<T>(
  context: ProjectToolContext,
  cwd: LooseOptional<string>,
  action: () => Promise<T>
): Promise<T> {
  return cwd ? context.project.runInDirectory(cwd, action) : action()
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
  schema: z.object({
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)]),
    range: ProjectRangeSchema,
    maxChars: z.number().int().positive().max(500_000).optional(),
    baseRevisions: z.record(z.string(), z.string()).optional(),
  }),
  permissions: ['fs:read'],
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
  schema: z.object({
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(20).optional(),
    exclude: z.array(z.string().min(1)).max(20).optional(),
    recursive: z.boolean().optional().default(false),
    maxDepth: z.number().int().nonnegative().max(30).optional(),
    limit: z.number().int().positive().max(2_000).optional().default(200),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    const limit = input.limit ?? 200
    const entries = await kernel.listFiles({
      path: input.path,
      include: input.include,
      exclude: input.exclude,
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
  schema: z.object({
    query: z.string().min(1),
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(20).optional(),
    exclude: z.array(z.string().min(1)).max(20).optional(),
    regex: z.boolean().optional().default(false),
    caseSensitive: z.boolean().optional().default(false),
    limit: z.number().int().positive().max(500).optional().default(50),
  }),
  permissions: ['fs:read'],
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const kernel = await context.project.kernel()
    return kernel.search({
      query: input.query,
      root: input.path,
      include: input.include,
      exclude: input.exclude,
      regex: input.regex,
      caseSensitive: input.caseSensitive,
      maxResults: input.limit ?? 50,
    })
  },
})

const projectEdit = defineProjectTool<{
  operations: z.input<typeof ProjectEditOperationsSchema>
  cwd?: string
}>({
  name: ProjectToolNames.edit,
  category: 'project-changes',
  role: 'edit',
  summary: '以一个可回滚事务原子地修改项目内一个或多个文件。',
  schema: z.object({
    operations: ProjectEditOperationsSchema.min(1).max(20),
    cwd: z.string().optional(),
  }),
  permissions: ['fs:read', 'fs:write'],
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const authorization = await context.project.prepareMutation({
      cwd: input.cwd,
      operation: '修改项目文件',
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
  },
})

const projectRollback = defineProjectTool<{ transactionId: string }>({
  name: ProjectToolNames.rollback,
  category: 'project-changes',
  role: 'edit',
  summary: '撤销由 project:edit 创建并已应用的项目事务。',
  schema: z.object({ transactionId: z.string().min(1) }),
  permissions: ['fs:read', 'fs:write'],
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
      { approvalRisk: 'high', riskScope: 'project-command:dangerous' }
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
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    background: z.boolean().optional(),
    maxOutputChars: z.number().int().positive().max(50_000).optional(),
    parallel: z.boolean().optional(),
  }),
  permissions: ['process:exec'],
  isConcurrencySafe: (input) => isParallelCommandExecutionSafe(input),
  execute: runProjectCommand,
})

const projectFileTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.read]: projectRead,
  [ProjectToolNames.list]: projectList,
  [ProjectToolNames.search]: projectSearch,
})
const projectChangeTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.edit]: projectEdit,
  [ProjectToolNames.rollback]: projectRollback,
})
const projectExecutionTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.run]: projectRun,
})
const projectTools: ProjectToolCollection = Object.freeze({
  ...projectFileTools,
  ...projectChangeTools,
  ...projectExecutionTools,
})

export {
  defineProjectTool,
  projectChangeTools,
  projectExecutionTools,
  projectFileTools,
  projectTools,
  runInProjectDirectory,
}
