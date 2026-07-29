import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'
import type { ToolCapabilitySchema } from '@velaros-ai/core/types'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'
import {
  applyDefaultRecursiveMaxDepth,
  optionalReadEndLine,
  optionalReadMaxChars,
  optionalReadStartLine,
  refineBoundedReadInput,
  requiredNonNegativeMaxDepth,
  requiredResultLimit,
} from '@velaros-ai/core/utils/ToolInputBounds'

import { executeAtomicEdit } from './atomic/Edit.js'
import { executeAtomicGrep } from './atomic/Grep.js'
import { executeAtomicListDir } from './atomic/ListDir.js'
import { executeAtomicRead } from './atomic/Read.js'
import { assertBashCwdOutsideActiveWorkspace } from './atomic/WorkspaceBoundary.js'
import { executeAtomicWrite } from './atomic/Write.js'
import {
  analyzeCommandExecution,
  buildBackgroundCommandConfirmationMessage,
  isParallelCommandExecutionSafe,
} from './SystemCommandExecutionPolicy'
import { defineSystemTool } from './Types.js'

type SystemToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

const SystemOpenCapability = {
  effectKind: 'browser',
  readScopes: ['system'],
  concurrency: 'unsafe',
  metadata: {
    systemAccess: 'control',
  },
  reason: 'system open primitive',
} satisfies SystemToolCapabilitySchema

const read = defineSystemTool<{
  path: string
  startLine?: number
  endLine?: number
  maxChars?: number
}>({
  name: 'read',
  role: 'inspect',
  summary: '有界读取系统路径上的文本文件。',
  suitable: ['读取日志、配置、临时文件或工作区外文本。'],
  forbidden: ['不要读取二进制文件、目录或没有边界的大文件。'],
  protocol: [
    '先确认 path 来自用户、命令输出或可信上下文。',
    '用 endLine 或 maxChars 控制返回体积；hasMore=true 时按 nextStartLine 续读。',
  ],
  usage: ['传 path，并提供 endLine 或 maxChars；startLine 用于续读或局部定位。'],
  examples: [{ path: '~/build.log', startLine: 1, endLine: 120 }],
  notes: ['支持绝对路径和 ~；相对路径由系统 kernel 解析；工作区内文件正文使用 ws_read。'],
  schema: z
    .object({
      path: z.string().min(1).describe(parameterDescription({ description: '要读取的文本文件路径。' })),
      startLine: optionalReadStartLine(parameterDescription({ description: '起始行号，从 1 开始。' })),
      endLine: optionalReadEndLine(parameterDescription({ description: '结束行号；不传时必须传 maxChars。' })),
      maxChars: optionalReadMaxChars(200_000, parameterDescription({ description: '最多返回字符数。' })),
    })
    .superRefine(refineBoundedReadInput),
  permissions: ['fs:read'],
  capabilities: {
    effectKind: 'read',
    readScopes: ['any'],
    filesystem: { read: 'any', write: 'none' },
    canReadArbitrarySource: true,
    concurrency: 'safe',
    reason: 'system text file read primitive',
  },
  isConcurrencySafe: () => true,
  execute: async (input) => executeAtomicRead({
    ...input,
    maxChars: input.endLine || input.maxChars ? input.maxChars : 200_000,
  }),
})

const write = defineSystemTool<{
  path: string
  content: string
  overwrite?: boolean
  maxBytes?: number
}>({
  name: 'write',
  role: 'edit',
  summary: '写入或创建系统路径上的文本文件（默认覆盖已有文件）。',
  suitable: ['创建或整体重写小型文本文件、配置片段或命令产物。'],
  forbidden: ['只想改文件的一小段时用 edit 做精确替换，不要用 write 整体重写。'],
  usage: [
    '传 path 和 content；已存在的文件默认直接覆盖，无需额外参数。',
    '只想在文件不存在时创建、绝不覆盖，才传 overwrite=false。',
  ],
  examples: [{ path: '~/agent-note.txt', content: 'hello\n' }],
  notes: [
    '只接受文本内容；二进制写入不在本工具范围内。',
    'content 是 JSON 解析后的原始字符串；字面 \\n 按两个字符写入。',
    '结果里的 created=false 表示覆盖了已有文件；系统敏感路径（~/.ssh、shell 启动文件、/etc 等）覆盖前会走用户确认。',
  ],
  schema: z.object({
    path: z.string().min(1).describe(parameterDescription({ description: '目标文件路径。' })),
    content: z.string().max(1_000_000).describe(parameterDescription({
      description: '要写入的文本内容。',
      notes: ['不会对字面 \\n 做二次反转义；模型工具调用里的 JSON 转义换行会由 provider 正常解析成真实换行。'],
    })),
    overwrite: z.boolean().optional().describe(
      parameterDescription({
        description: '文件已存在时是否覆盖。',
        notes: ['默认 true（write 语义就是把内容写到该路径）；传 false 表示「仅创建」，文件已存在则拒绝写入。'],
      })
    ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(2_000_000)
      .optional()
      .default(1_000_000)
      .describe(parameterDescription({ description: '允许写入的最大字节数。' })),
  }),
  permissions: ['fs:write'],
  capabilities: {
    effectKind: 'write',
    writeScopes: ['any'],
    filesystem: { read: 'none', write: 'any' },
    concurrency: 'unsafe',
    reason: 'system text file write primitive',
  },
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => executeAtomicWrite(input, ctx),
})

const edit = defineSystemTool<{
  path: string
  oldText: string
  newText: string
  expectedReplacements?: number
  maxFileBytes?: number
}>({
  name: 'edit',
  role: 'edit',
  summary: '对系统文本文件执行一次精确替换。',
  suitable: ['修改用户明确给出的系统路径或临时文件片段。'],
  forbidden: ['不要用于二进制文件、大文件或不确定命中次数的替换。'],
  protocol: [
    '先用 read 确认 oldText、路径和上下文。',
    '默认 expectedReplacements=1；多处替换必须显式给出 expectedReplacements。',
  ],
  usage: ['传 path、oldText、newText；可传 expectedReplacements 和 maxFileBytes。'],
  examples: [{ path: '~/.config/tool/config.json', oldText: 'oldField', newText: 'newField' }],
  notes: ['active workspace 内的代码文件仍应优先使用 workspace 工具。'],
  schema: z.object({
    path: z.string().min(1).describe(parameterDescription({ description: '要编辑的文本文件路径。' })),
    oldText: z.string().min(1).max(50_000).describe(parameterDescription({ description: '要精确匹配的原文本。' })),
    newText: z.string().max(100_000).describe(parameterDescription({ description: '替换后的文本；空字符串表示删除。' })),
    expectedReplacements: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(1)
      .describe(parameterDescription({ description: '期望替换次数；默认 1。' })),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(2_000_000)
      .optional()
      .default(500_000)
      .describe(parameterDescription({ description: '允许编辑的最大文件字节数。' })),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: {
    effectKind: 'write',
    readScopes: ['any'],
    writeScopes: ['any'],
    filesystem: { read: 'any', write: 'any' },
    canReadArbitrarySource: true,
    concurrency: 'unsafe',
    reason: 'system exact text edit primitive',
  },
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => executeAtomicEdit(input, ctx),
})

const list = defineSystemTool<{
  path: string
  recursive?: boolean
  maxDepth?: number
  limit: number
}>({
  name: 'list',
  role: 'inspect',
  summary: '列出系统路径下的文件和目录。',
  suitable: ['查看系统目录结构，或在读写前确认路径存在。'],
  forbidden: ['不要省略 limit 做开放式递归枚举。'],
  usage: ['传 path 和 limit；recursive=true 时必须传 maxDepth。'],
  examples: [{ path: '~/.config', recursive: true, maxDepth: 2, limit: 100 }],
  notes: [
    '入口目录 symlink 会解析到真实目录；子项 symlink 标为 type="symlink"，且不递归展开。',
    'truncated=true 表示已达 limit 且还有更多条目，需缩小范围或增大 limit。',
  ],
  schema: z
    .object({
      path: z.string().min(1).describe(parameterDescription({ description: '要列出的目录路径。' })),
      recursive: z.boolean().optional().describe(parameterDescription({ description: '是否递归进入子目录。' })),
      maxDepth: requiredNonNegativeMaxDepth(
        4,
        parameterDescription({ description: 'recursive=true 时的最大递归深度。' })
      ).optional(),
      limit: requiredResultLimit(200, parameterDescription({ description: '最多返回的条目数。' })),
    })
    .transform(applyDefaultRecursiveMaxDepth),
  permissions: ['fs:read'],
  capabilities: {
    effectKind: 'read',
    readScopes: ['any'],
    filesystem: { read: 'any', write: 'none' },
    canReadArbitrarySource: true,
    concurrency: 'safe',
    reason: 'system directory list primitive',
  },
  isConcurrencySafe: () => true,
  execute: async (input) => executeAtomicListDir(input),
})

const grep = defineSystemTool<{
  path: string
  pattern: string
  regex?: boolean
  caseSensitive?: boolean
  limit: number
  maxDepth?: number
  maxResultsPerFile?: number
}>({
  name: 'grep',
  role: 'inspect',
  summary: '在系统路径上搜索文本匹配。',
  suitable: ['在已知文件或目录中查找字符串或正则匹配。'],
  forbidden: ['不要省略 limit 做开放式全盘搜索。'],
  protocol: ['需要完整视图时直接用上限 limit=50；只有明确窄查询才用小 limit。'],
  usage: ['传 path、pattern、limit；目录搜索可传 maxDepth 和 maxResultsPerFile。'],
  examples: [{ path: '~', pattern: 'ERROR', limit: 50, maxDepth: 3 }],
  notes: [
    '用于系统路径；工作区内正文搜索优先使用 ws_search。',
    '入口 symlink 目录会解析到真实路径；truncated=true 表示已达 limit 且还有更多匹配,应缩小范围或换更精确 pattern 补查。',
    'maxResultsPerFile 默认 5:结果带 perFileTruncatedPaths 表示这些文件的命中被按文件截断——统计计数请改用 bash grep -c,或提高 maxResultsPerFile。',
  ],
  schema: z.object({
    path: z.string().min(1).describe(parameterDescription({ description: '要搜索的文件或目录路径。' })),
    pattern: z.string().min(1).describe(parameterDescription({ description: '要匹配的文本或正则。' })),
    regex: z.boolean().optional().describe(parameterDescription({ description: '是否把 pattern 当作正则表达式。' })),
    caseSensitive: z.boolean().optional().describe(parameterDescription({ description: '是否区分大小写。' })),
    limit: requiredResultLimit(50, parameterDescription({ description: '最多返回的匹配条数。' })),
    maxDepth: z.number().int().min(0).max(16).optional().describe(parameterDescription({ description: '目录搜索最大递归深度。' })),
    maxResultsPerFile: z.number().int().positive().max(20).optional().describe(parameterDescription({ description: '每个文件最多返回的匹配条数。' })),
  }),
  permissions: ['fs:read'],
  capabilities: {
    effectKind: 'read',
    readScopes: ['any'],
    filesystem: { read: 'any', write: 'none' },
    canReadArbitrarySource: true,
    concurrency: 'safe',
    reason: 'system grep primitive',
  },
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => executeAtomicGrep(input, ctx),
})

const bash = defineSystemTool<{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  maxOutputChars?: number
  parallel?: boolean
  allowRepeat?: boolean
}>({
  name: 'bash',
  role: 'execute',
  summary: '在宿主系统默认 shell 中执行命令（Windows 为 cmd.exe，macOS/Linux 为 POSIX shell）。',
  suitable: ['执行系统诊断、跨目录探测、工具安装后检查或本地脚本。'],
  forbidden: ['不要执行危险写命令、长期服务或重复命令，除非已有用户意图或确认。'],
  protocol: [
    '属于当前项目的命令必须使用 ws_run_command。',
    '默认使用系统临时目录作为 cwd；不要假设 /tmp、$PATH 或其他 POSIX 语法在 Windows 可用。',
    'Windows 使用 cmd.exe 语法；命令探测用 where，环境变量用 %NAME%。macOS/Linux 使用 POSIX shell 语法。',
    'workspace-space-isolation 拒绝项目 cwd 时改用 ws_run_command。',
    '长期服务传 background=true；危险命令会走确认流程。',
    '输出可能很长时设置 maxOutputChars，并用返回的 logPath 续读完整日志。',
  ],
  usage: ['传 command；需要特定目录时传 cwd。'],
  examples: [{ command: 'git --version', maxOutputChars: 2000 }],
  notes: ['工具名 bash 为兼容旧契约保留，实际 shell 由宿主平台决定；cwd 只影响本次命令；项目内用 ws_run_command。'],
  schema: z.object({
    command: z.string().min(1).describe(parameterDescription({ description: '要执行的 shell 命令。' })),
    cwd: z.string().optional().describe(parameterDescription({ description: '可选系统工作目录。' })),
    timeoutMs: z.number().int().positive().max(600000).optional().describe(parameterDescription({ description: '命令超时时间，单位毫秒。' })),
    background: z.boolean().optional().describe(parameterDescription({ description: '是否后台启动命令。' })),
    maxOutputChars: z.number().int().positive().max(50000).optional().describe(parameterDescription({ description: 'stdout/stderr 返回字符上限。' })),
    parallel: z.boolean().optional().describe(parameterDescription({ description: '是否声明命令可并发。' })),
    allowRepeat: z.boolean().optional().describe(parameterDescription({ description: '是否允许重复运行同一命令。' })),
  }),
  permissions: ['process:exec'],
  capabilities: {
    effectKind: 'execute',
    readScopes: ['system'],
    filesystem: { read: 'system', write: 'system' },
    process: { execution: 'input-dependent' },
    concurrency: 'input-dependent',
    reason: 'system shell command execution',
  },
  isConcurrencySafe: isParallelCommandExecutionSafe,
  execute: async ({ command, cwd, timeoutMs, background, maxOutputChars }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    assertBashCwdOutsideActiveWorkspace(cwd, ctx)
    const plan = analyzeCommandExecution(command)
    const shouldRunInBackground =
      background || ((background ?? true) && plan.shouldStartInBackground)

    if (shouldRunInBackground && !ctx.system.canStartBackgroundCommands()) {
      throw new AppError('PERMISSION', '当前未允许模型启动长期运行的命令。')
    }

    if (plan.shouldRequestConfirmation) {
      await ctx.approval.awaitConfirmation(
        buildBackgroundCommandConfirmationMessage(
          command,
          plan,
          cwd ?? '系统运行环境',
          shouldRunInBackground
        ),
        ctx.abortSignal,
        {
          approvalRisk: plan.isDangerous ? 'high' : 'low',
          riskScope: plan.isDangerous ? 'system-command:dangerous' : undefined,
        }
      )
    }

    const result = await ctx.system.runCommand(
      command,
      { cwd, timeoutMs, background: shouldRunInBackground, maxOutputChars },
      plan.isDangerous,
      ctx.abortSignal
    )

    if (!result.backgroundProcess) return result
    return {
      ...result,
      backgroundProcess: {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
      },
    }
  },
})

const ps = defineSystemTool<{
  include?: Array<'processes' | 'ports' | 'tasks'>
  limit?: number
  pid?: number
  processName?: string
  port?: number
  filter?: string
  onlyRunning?: boolean
  includeCwd?: boolean
}>({
  name: 'ps',
  role: 'inspect',
  summary: '查看进程、监听端口和当前产品记录的后台系统命令任务。',
  suitable: ['排查本机进程、端口占用、dev server 或后台 watch 任务。'],
  forbidden: ['不要用它终止进程；本工具只查询。'],
  usage: [
    'include 默认同时返回 processes、ports、tasks；用 limit 控制每类数量。',
    '找"某服务/某 app 归属的进程或端口"优先用 filter：对进程名+完整命令行联合模糊匹配（进程名常常只是 Electron/node，服务特征在命令行里）。',
  ],
  examples: [
    { include: ['processes', 'ports'], processName: 'node', limit: 20 },
    { include: ['ports'], filter: 'velaros' },
  ],
  notes: [
    'tasks 只含产品登记的后台系统命令，不包含 sub-agent、模型执行计划或短生命周期工具调用。',
    'CLI kernel 下进程 cwd 通常不可用；Electron host 可提供更完整进程归属。',
  ],
  schema: z.object({
    include: z.array(z.enum(['processes', 'ports', 'tasks'])).max(3).optional().describe(
      parameterDescription({ description: '要返回的运行态类别。' })
    ),
    limit: z.number().int().positive().max(100).optional().describe(parameterDescription({ description: '每类最多返回数量。' })),
    pid: z.number().int().positive().optional().describe(parameterDescription({ description: '按 pid 过滤。' })),
    processName: z.string().min(1).optional().describe(parameterDescription({ description: '按进程名过滤。' })),
    port: z.number().int().positive().max(65535).optional().describe(parameterDescription({ description: '按监听端口过滤。' })),
    filter: z.string().min(1).optional().describe(
      parameterDescription({
        description: '对进程名+完整命令行的模糊匹配（不区分大小写）；服务归属查找首选。',
      })
    ),
    onlyRunning: z.boolean().optional().describe(parameterDescription({ description: '任务列表是否只返回运行中任务。' })),
    includeCwd: z.boolean().optional().describe(parameterDescription({ description: '是否尝试补充进程 cwd。' })),
  }),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async ({ include, limit, pid, processName, port, filter, onlyRunning, includeCwd }, ctx) => {
    const includeSet = new Set(include && include.length > 0 ? include : ['processes', 'ports', 'tasks'])
    const result: Record<string, unknown> = { sampledAt: new Date().toISOString() }
    // filter 在工具层后过滤（进程名+命令行联合），存在时先取全量再截 limit，
    // 避免 store 侧 limit 把匹配项挤出窗口。
    const normalizedFilter = filter?.trim().toLowerCase()
    const matchesFilter = (candidate: { processName?: Nullable<string>; name?: Nullable<string>; command?: Nullable<string> }): boolean => {
      if (!normalizedFilter) return true
      const haystack = `${candidate.processName ?? candidate.name ?? ''}\0${candidate.command ?? ''}`.toLowerCase()
      return haystack.includes(normalizedFilter)
    }
    const applyFilter = <T extends { processName?: Nullable<string>; name?: Nullable<string>; command?: Nullable<string> }>(
      items: T[]
    ): T[] => {
      if (!normalizedFilter) return items
      const filtered = items.filter(matchesFilter)
      return limit ? filtered.slice(0, limit) : filtered
    }

    if (includeSet.has('processes')) {
      const items = await ctx.system.listProcesses({
        limit: normalizedFilter ? undefined : limit,
        pid,
        name: processName,
        includeCwd,
      })
      const finalItems = applyFilter(items)
      result.processes = { count: finalItems.length, items: finalItems }
    }

    if (includeSet.has('ports')) {
      const items = await ctx.system.listOpenPorts({
        limit: normalizedFilter ? undefined : limit,
        pid,
        processName,
        port,
        includeCwd,
      })
      const finalItems = applyFilter(items)
      result.ports = { count: finalItems.length, items: finalItems }
    }

    if (includeSet.has('tasks')) {
      const items = await ctx.system.listBackgroundTasks({ limit, onlyRunning })
      result.tasks = { count: items.length, items }
    }

    return result
  },
})

const open = defineSystemTool<{
  action: 'open' | 'reveal' | 'application'
  path?: string
  application?: string
  targetPath?: string
  args?: string[]
}>({
  name: 'open',
  role: 'control',
  summary: '打开路径、在文件管理器中定位路径，或启动本地应用。',
  suitable: ['把生成产物交给用户查看，或启动指定本地应用。'],
  forbidden: ['不要用它读取、修改文件或运行 shell 命令。'],
  usage: [
    'action=open 传 path。',
    'action=reveal 传 path。',
    'action=application 传 application，可选 targetPath 和 args。',
  ],
  examples: [{ action: 'reveal', path: '~/report.pdf' }],
  notes: ['实际打开方式由宿主和操作系统决定。'],
  schema: z
    .object({
      action: z.enum(['open', 'reveal', 'application']).describe(parameterDescription({ description: '打开动作。' })),
      path: z.string().optional().describe(parameterDescription({ description: 'open/reveal 的目标路径。' })),
      application: z.string().optional().describe(parameterDescription({ description: 'application 动作的应用名称。' })),
      targetPath: z.string().optional().describe(parameterDescription({ description: '交给指定应用打开的目标路径。' })),
      args: z.array(z.string()).optional().describe(parameterDescription({ description: '应用启动参数。' })),
    })
    .superRefine((value, refinementContext) => {
      if ((value.action === 'open' || value.action === 'reveal') && !value.path?.trim()) {
        refinementContext.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['path'],
          message: `${value.action} 动作必须提供 path`,
        })
      }
      if (value.action === 'application' && !value.application?.trim()) {
        refinementContext.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['application'],
          message: 'application 动作必须提供 application',
        })
      }
    }),
  permissions: ['system:open'],
  capabilities: SystemOpenCapability,
  execute: async ({ action, path, application, targetPath, args }, ctx) => {
    switch (action) {
      case 'open':
        return ctx.system.openPath(path!)
      case 'reveal':
        return ctx.system.revealPath(path!)
      case 'application':
        return ctx.system.openApplication(application!, { targetPath, args })
    }
  },
})

const systemPrimitiveTools = {
  read,
  write,
  edit,
  list,
  grep,
  bash,
  ps,
  open,
}

export { systemPrimitiveTools }
