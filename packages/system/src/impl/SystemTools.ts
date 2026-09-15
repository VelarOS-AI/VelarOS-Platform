/**
 * 系统空间的六个模型面工具。每个工具的说明就是它的定义：摘要、适用与禁用场景、协议、用法、示例、参数、权限、能力声明、审批语义
 * 和 execute 都在定义里，上方不再另写一遍；按文件、执行两类排列，文件末尾是它们怎么分组、作为内置 mod 挂进产品、作为能力服务挂进内核。
 * 只留 `system:run` 替代不了的：读和写要把内容和精确匹配绕开 shell 引号，看图片要把内容当图交给模型，后台任务表只在本包，刷新环境改的是宿主进程。PDF 与其他文档归别的 mod。
 * 读、看、写都是 files 每项一个文件，一个文件就一项。列目录、搜文本、看进程和端口、终止进程都用 `system:run` 跑系统命令。
 * 这是人最先看的文件，改了要在差量报告里点名。
 */

import { z } from 'zod'

import type { AgentModManifest, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import { createApprovalOperationKey, createManualApprovalOptions, structureToolDescriptionsForCategory } from '@velaros-ai/agent/tool-contract'
import { isEmpty, optionalWhen } from '@velaros-ai/core'
import type { CapabilityToken, KernelModuleDefinition } from '@velaros-ai/kernel/contracts/abi'
import { createCapabilityToken, createKernelCallableCapability, defineKernelModule, KernelModuleApiVersion } from '@velaros-ai/kernel/contracts/abi'

import type { SystemToolCategoryId } from '../contract/system.js'
import { SystemModId, SystemSpaceId, SystemToolCategoryByName, SystemToolNames } from '../contract/system.js'
import type { SystemBundledModDefinition, SystemCapabilityService, SystemToolCollection } from '../interface/provides.js'
import type { CreateSystemKernelModuleOptions } from '../interface/requires.js'
import { buildBackgroundCommandConfirmationMessage, isParallelCommandExecutionSafe } from '../utils/command-policy.js'
import { exposeCommandOutputWindow } from '../utils/command-result.js'
import { createSystemCallableOperations, defineSystemTool } from '../utils/tool.js'

import { systemCommandPolicy } from './SystemCommandPolicy.js'
import { systemFileOperations } from './SystemFileOperations.js'

// ── 文件：读文本、看图片、写（都是 files 每项一个；写可以一次改几处）──────────────────────────

/** system:read —— 读文本文件。 */
const readTool = defineSystemTool<{
  files: Array<{
    path: string
    offset?: number
    maxChars?: number
    version?: string
  }>
}>({
  name: SystemToolNames.read,
  role: 'inspect',
  summary: '读文本文件：files 每项一个文件，按字符取一段，返回它的 range 和版本号。',
  suitable: ['看日志、配置、脚本、临时文件等文本，一个或一批。'],
  forbidden: ['图片用 system:view；PDF 和其他文档不在这里读；列目录、搜文本用 system:run。'],
  usage: [
    '只传 path 就默认一次读到上限；没读完的文件把它返回的 range.end 当 offset 接着读。一次调用总共最多 200000 字符，预算在前面的文件用完后，后面的文件不读、那一项是 error，note 会说明。',
    '结果的 files 与传入的一一对应，某个文件读不了只有它那一项是 error；version 是这份内容的版本号，传回去可以读旧内容。',
  ],
  examples: [{ files: [{ path: '~/build.log' }] }, { files: [{ path: '~/.zshrc' }, { path: '~/build.log', offset: 200000 }] }],
  notes: ['其他二进制文件读不了。读私钥、云凭证这类文件会先向用户确认。'],
  schema: z.strictObject({
    files: z.array(z.strictObject({
      path: z.string().min(1).describe('文件路径，支持 ~；相对路径相对 system:run 的默认目录。'),
      offset: z.number().int().nonnegative().optional().describe('从第几个字符开始读，默认 0。'),
      maxChars: z.number().int().positive().max(200_000).optional().describe('最多返回多少字符，默认也是上限 200000。'),
      version: z.string().min(1).optional().describe('读改动前留下的某个版本，版本号来自 read 或 edit 的结果；只有本次运行里 edit 留下的版本能召回。'),
    })).min(1).max(20).describe('要读的文件，每项一个，一次最多 20 个。'),
  }),
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
  execute: async (input, ctx) => systemFileOperations.read(input, ctx),
})

/** system:view —— 看图片。 */
const viewTool = defineSystemTool<{
  files: Array<{
    path: string
  }>
}>({
  name: SystemToolNames.view,
  role: 'inspect',
  summary: '看图片：files 每项一张图，整张交给模型，效果和用户上传一样。',
  suitable: ['看截图、照片、图表等图片的内容。'],
  forbidden: ['文本文件用 system:read；PDF 和其他文档不在这里看。'],
  usage: ['结果的 files 与传入的一一对应，内容块按同样的顺序排；某个文件看不了只有它那一项是 error。'],
  examples: [{ files: [{ path: '~/Desktop/screenshot.png' }] }, { files: [{ path: '~/Desktop/before.png' }, { path: '~/Desktop/after.png' }] }],
  notes: ['只认 PNG、JPEG、GIF、WebP，最大 5 MB；别的格式或太大的先用 system:run 转换、缩小。'],
  schema: z.strictObject({
    files: z.array(z.strictObject({
      path: z.string().min(1).describe('图片路径，支持 ~；相对路径相对 system:run 的默认目录。'),
    })).min(1).max(10).describe('要看的图片，每项一张，一次最多 10 张。'),
  }),
  permissions: ['fs:read'],
  capabilities: {
    effectKind: 'read',
    readScopes: ['any'],
    filesystem: { read: 'any', write: 'none' },
    canReadArbitrarySource: true,
    concurrency: 'safe',
    reason: 'system image view primitive',
  },
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => systemFileOperations.view(input, ctx),
})

/** system:edit —— 写文件：整个写入、改几处、回滚。 */
const editTool = defineSystemTool<{
  files: Array<{
    path: string
    newText?: string
    edits?: Array<{
      range: { offset: number; end: number }
      oldText?: string
      newText: string
    }>
    restore?: string
    version?: string
  }>
}>({
  name: SystemToolNames.edit,
  role: 'edit',
  summary: '写文件：files 每项一个文件；newText 整个写入，edits 改文件里的几处，restore 回滚到某个版本。一批全成或全不成；改完返回每处的新样子和新版本号，不用再读。',
  suitable: ['新建脚本、配置、笔记等文本文件。', '改配置或脚本里的一处或几处。', '一次改一批文件。'],
  forbidden: ['复制、移动、删除、改权限用 system:run。'],
  usage: [
    '先用 system:read 读到要改的那段；edits 每项一处，把返回的 range 原样传回来，oldText 和原文一字不差，只在这段里找。同一个文件的几处放在一个 edits 里，各处不能重叠。把 read 返回的 version 一起传，文件在读之后被改过就不会误改。',
    '一批全成或全不成：任何一处定不下来就什么都不写，失败回执的 details.problems 列出第几个文件第几处出了什么问题，多处匹配带锚点；回执带 inputReuse 时按它的说明只改那一处再发，不要整个重发。',
    'edits 里只给 range 不给 oldText，就是把这段整个换成 newText；range 是空段就是在那个位置插入。',
    '改错了用 restore 传结果里的 previousVersion 回滚；想先看旧内容就用 system:read 传 version。',
  ],
  examples: [
    { files: [{ path: '~/notes/todo.md', newText: '- 买牛奶\n' }] },
    {
      files: [
        {
          path: '~/.zshrc',
          edits: [
            { range: { offset: 0, end: 1200 }, oldText: 'export EDITOR=vim', newText: 'export EDITOR=code' },
            { range: { offset: 0, end: 1200 }, oldText: 'alias ll=', newText: 'alias l=' },
          ],
        },
        { path: '~/.gitconfig', restore: '3f2a9c1d0e7b' },
      ],
    },
  ],
  notes: ['写系统敏感路径、私钥和云凭证这类文件会先向用户确认；路径是符号链接时改的是它指向的文件，结果里 target 给出那个文件。newText 只能写到文本文件或新文件上，已有的二进制文件用 system:run 换。改完之后 windows 每处带新位置，改动那段不超过 20000 字符时 content 和 range 整段给出；旧的 range 已经作废，再改同一个文件用新的。'],
  inputReuse: true,
  schema: z.strictObject({
    files: z.array(z.strictObject({
      path: z.string().min(1).describe('文件路径，支持 ~；相对路径相对 system:run 的默认目录。'),
      newText: z.string().optional().describe('整个文件写入的内容，不存在就新建；改几处时不用给，改动写在 edits 里。'),
      edits: z.array(z.strictObject({
        range: z.strictObject({
          offset: z.number().int().nonnegative().describe('起点字符位置。'),
          end: z.number().int().nonnegative().describe('终点字符位置，不含。'),
        }).describe('system:read 返回的 range，只在这段里改。'),
        oldText: z.string().optional().describe('要换掉的原文，只在 range 里找、必须只出现一次；不给就把整段换成 newText。'),
        newText: z.string().describe('换成的新文本。'),
      })).min(1).max(50).optional().describe('要改的地方，每项一处；同一个文件的几处一起改，全成或全不成，各处不能重叠。'),
      restore: z.string().min(1).optional().describe('回滚到这个版本，版本号来自 read 或 edit 结果里的 version 或 previousVersion；不和 newText、edits 同用，可以带 version 先核对文件没被改过。'),
      version: z.string().min(1).optional().describe('read 返回的这个文件的版本号；给了就先核对文件没被改过，改过就整批不写并给出当前版本。'),
    })).min(1).max(20).describe('要写的文件，每项一个，一次最多 20 个；每项只用 newText、edits、restore 中的一种。'),
  }),
  permissions: ['fs:read', 'fs:write'],
  capabilities: {
    effectKind: 'write',
    readScopes: ['any'],
    writeScopes: ['any'],
    filesystem: { read: 'any', write: 'any' },
    canReadArbitrarySource: true,
    concurrency: 'unsafe',
    reason: 'system file write primitive',
  },
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => systemFileOperations.edit(input, ctx),
})

// ── 执行：跑命令、刷新环境 ──────────────────────────────────

/** system:run —— 在宿主报告的系统 shell 中执行命令。 */
const runTool = defineSystemTool<{
  command: string
  cwd?: string
  timeoutMs?: number
  background?: boolean
  interactive?: boolean
  maxOutputChars?: number
  parallel?: boolean
  allowRepeat?: boolean
}>({
  name: SystemToolNames.run,
  role: 'execute',
  summary: '在宿主已检测并报告的系统 shell 中执行命令。',
  suitable: [
    '执行系统诊断、跨目录探测、工具安装后检查或本地脚本。',
    '处理没有专用 primitive 的系统文件操作，例如复制、移动、删除、归档、解压、权限检查或修改。',
    '列目录、搜文本、看进程和端口、终止进程：POSIX 用 ls / find / grep 或 rg / ps / lsof / kill；PowerShell 用 Get-ChildItem / Select-String / Get-Process / netstat / Stop-Process；CMD 用 dir / findstr / tasklist / netstat / taskkill。',
    '打开文件或网址、在文件管理器里定位、启动本地应用：macOS 用 open、open -R、open -a；Windows 用 start、explorer /select,；Linux 用 xdg-open。',
  ],
  forbidden: ['不要执行危险写命令、长期服务或重复命令，除非已有用户意图或确认。'],
  protocol: [
    '不传 cwd 时用宿主给的默认目录。',
    '生成命令前读取当前运行环境报告的 shell.kind/name；Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的可用性选择，并推荐安装 Git for Windows。',
    '严格使用实际 shell 的语法：Git Bash/POSIX 使用 command -v 和 $NAME；PowerShell 使用 Get-Command 和 $env:NAME；CMD 使用 where 和 %NAME%。刷新环境后按新的 shell 重新生成命令。',
    '命令执行失败后先诊断原始退出码和输出；切换 shell 需要重新生成匹配语法的命令，避免重复执行副作用。',
    '长期服务传 background=true；危险命令会走确认流程。后台命令的状态用返回的 statusContinuation 查；回执里有 outputContinuation 时用它取完整输出，没有就只有结尾窗口。不要用 job:*，也不要把内部 logPath 当普通文件读。',
    '输出可能很长时设置 maxOutputChars；返回窗口固定保留结尾，outputWindow.endPreserved=true 时可直接信任末尾内容。',
  ],
  usage: [
    '传 command；需要特定目录时传 cwd。',
    '命令会问用户口令、y/n 或选项时传 interactive=true：命令在控制台里跑，用户在卡片里输入，本次调用立刻返回，之后用 system:list-tasks 或 outputContinuation 看结果。',
    '停后台任务时执行 system:list-tasks 条目里的 terminateCommand 或 forceTerminateCommand，不要自己拼 pid。',
  ],
  examples: [{ command: 'git --version', maxOutputChars: 2000 }],
  notes: ['实际 shell 由宿主平台决定；cwd 只影响本次命令。'],
  schema: z.strictObject({
    command: z.string().min(1).describe('要执行的 shell 命令。'),
    cwd: z.string().optional().describe('命令的工作目录；不传用宿主给的默认目录。'),
    timeoutMs: z.number().int().positive().max(600000).optional().describe('命令超时时间，单位毫秒。'),
    background: z.boolean().optional().describe('后台启动，立即返回后台任务；长驻服务传 true。'),
    interactive: z.boolean().optional().describe('命令需要用户输入时传 true：命令在控制台里跑，用户在卡片里输入。'),
    maxOutputChars: z.number().int().positive().max(50000).optional().describe('stdout/stderr 返回字符上限。'),
    parallel: z.boolean().optional().describe('命令只读、可以和别的命令同时跑时传 true，调度器会并发执行。'),
    allowRepeat: z.boolean().optional().describe('要故意再跑一遍完全相同的命令时传 true，否则同样的调用会被拦。'),
  }),
  permissions: ['process:exec'],
  capabilities: {
    effectKind: 'execute',
    readScopes: ['system'],
    writeScopes: ['system'],
    filesystem: { read: 'system', write: 'system' },
    process: { execution: 'input-dependent' },
    concurrency: 'input-dependent',
    reason: 'system shell command execution',
  },
  isConcurrencySafe: isParallelCommandExecutionSafe,
  execute: async ({ command, cwd, timeoutMs, background, interactive, maxOutputChars }, ctx) => {
    ctx.abortSignal.throwIfAborted()

    // 执行前分类
    const plan = systemCommandPolicy.analyze(command)
    const commandCwd = ctx.system.resolvePath(cwd)

    // 前台还是后台。交互式命令一定跑在后台：它要一直开着等用户在控制台里输入
    const shouldRunInBackground = !!interactive || (background ?? plan.shouldStartInBackground)

    // 审批。危险命令必须每次由用户亲自裁决：审批端口覆盖 riskScope 后 `:dangerous` 后缀不再可见，
    //    只有 requireManualApproval 能让宿主在任何档位都弹卡。
    if (plan.shouldRequestConfirmation) {
      await ctx.approval.awaitConfirmation(
        buildBackgroundCommandConfirmationMessage(
          command,
          plan,
          cwd ?? '系统运行环境',
          shouldRunInBackground
        ),
        ctx.abortSignal,
        plan.isDangerous
          ? createManualApprovalOptions({
              approvalRisk: 'high',
              riskScope: 'system-command:dangerous',
              operation: {
                key: createApprovalOperationKey('shell-command', { command: command.trim(), cwd: commandCwd, background: shouldRunInBackground }),
                label: command,
                target: commandCwd,
              },
            })
          : { approvalRisk: 'low' }
      )
    }

    // 交给宿主执行
    const result = await ctx.system.runCommand(
      command,
      { cwd: commandCwd, timeoutMs, background: shouldRunInBackground, interactive, maxOutputChars },
      plan.isDangerous,
      ctx.abortSignal
    )

    // 整形。要了控制台却没拿到，说明这个宿主跑不了交互式命令，直说，别让模型干等用户输入
    const shaped = exposeCommandOutputWindow(result)
    const note = optionalWhen(
      !!interactive && !result.backgroundProcess?.console,
      '当前宿主没有把它跑成控制台任务，用户无法输入：改成不需要输入的写法（答案用管道喂进去、加 --yes 这类参数），并用 system:list-tasks 里的 terminateCommand 停掉可能已经起来的任务。'
    )
    if (!result.backgroundProcess) return { ...shaped, note }
    return {
      ...shaped,
      note,
      backgroundProcess: {
        ...result.backgroundProcess,
        ports: plan.ports,
        reason: plan.reason,
        autoStarted: plan.shouldStartInBackground && !background,
        statusContinuation: result.backgroundProcess.taskId
          ? { tool: SystemToolNames.listTasks, args: { taskId: result.backgroundProcess.taskId } }
          : result.backgroundProcess.statusContinuation,
      },
    }
  },
})

/** system:refresh-environment —— 刷新宿主进程的 shell 环境。 */
const refreshEnvironmentTool = defineSystemTool<Record<string, unknown>>({
  name: SystemToolNames.refreshEnvironment,
  role: 'control',
  summary: '刷新登录 shell 环境缓存。',
  suitable: ['刚安装 CLI、改了 shell 配置或发现 PATH 里缺命令时重新加载环境，让后续命令看到最新的 PATH 和环境变量。'],
  forbidden: [
      '不要把它当作命令存在性检查；检查命令可用性用 system:run（Windows 用 where，macOS/Linux 用 command -v）。',
      '不要在宿主环境未允许刷新 shell 时反复调用。',
    ],
  protocol: [
      '先确认缺失命令或 PATH 变化，再刷新；刷新后用 system:run 按宿主 shell 语法验证目标命令是否可见。',
    ],
  notes: ['只重新加载宿主进程的环境，不会改用户的 shell 配置文件。'],
  // 没有参数就不校验：传了什么都不报错，只在结果里提醒一句。
  schema: z.record(z.string(), z.unknown()),
  permissions: [],
  capabilities: {
    effectKind: 'write',
    readScopes: ['system'],
    writeScopes: ['system'],
    filesystem: { read: 'none', write: 'none' },
    canReadArbitrarySource: false,
    concurrency: 'unsafe',
    reason: 'refresh host shell environment cache',
  },
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    // 由 system provider 重新加载 PATH 和 shell 环境变量。传了参数不报错，只提醒一句。
    const refreshed = await ctx.system.refreshShellEnvironment()
    return isEmpty(Object.keys(input)) ? refreshed : { ...refreshed, note: '这个工具不需要参数，传来的内容已忽略。' }
  },
})

// ── 后台任务：列出 run 启动的后台任务 ────────────────────────

/** system:list-tasks —— 列出本产品启动过的后台任务。 */
const listTasksTool = defineSystemTool<{
  limit?: number
  onlyRunning?: boolean
  taskId?: string
}>({
  name: SystemToolNames.listTasks,
  role: 'inspect',
  summary: '列出后台任务。',
  suitable: ['查 dev server、watcher 或长任务状态。'],
  forbidden: ['看系统全部进程和端口用 system:run 跑 ps / lsof；这里只有本产品启动的后台任务。'],
  usage: ['传 taskId 精确查询 system:run 返回的后台任务；或传 limit/onlyRunning 看列表，最新启动的在前。'],
  examples: [
    // 全部后台任务（含已结束）
    {},
    // 只看还在运行的
    { onlyRunning: true },
    // 精确查询 system:run 返回的后台任务
    { taskId: 'task-abc123' },
  ],
  notes: ['taskId 只在这里和 system:run 之间流转，不交给 job:*。', '要停掉任务，用 system:run 执行条目里的 terminateCommand；强制停用 forceTerminateCommand。'],
  schema: z.strictObject({
    limit: z.number().int().positive().max(100).optional().describe('最多返回数量。'),
    onlyRunning: z.boolean().optional().describe('是否只返回运行中任务。'),
    taskId: z.string().min(1).max(120).optional().describe('精确后台任务 id；取自 system:run 的 backgroundProcess.taskId。'),
  }),
  permissions: [],
  capabilities: {
    effectKind: 'read',
    readScopes: ['system'],
    filesystem: { read: 'none', write: 'none' },
    canReadArbitrarySource: false,
    concurrency: 'safe',
    reason: 'managed system background task inspection',
  },
  isConcurrencySafe: () => true,
  execute: async ({ limit, onlyRunning, taskId }, ctx) => {
    // onlyRunning 可过滤掉已结束的历史任务。
    const tasks = await ctx.system.listBackgroundTasks({
      limit: taskId ? undefined : limit,
      onlyRunning,
      taskId,
    })

    return {
      // count 给调用方提供轻量摘要。
      count: tasks.length,
      tasks,
    }
  },
})

// ── 工具集合：按职责类别分组 ────────────────────────────────────

/**
 * 工具集合的装配：六个工具按两个职责类别分组。
 *
 * 每个工具的定义（提示词、schema、权限、execute）在上面；这里只决定谁属于哪一类、以及全量集合长什么样。
 * 类别 id 与 `contract/system.ts` 里的表一致。
 */

const systemFileTools = structureToolDescriptionsForCategory({
  [SystemToolNames.read]: readTool,
  [SystemToolNames.view]: viewTool,
  [SystemToolNames.edit]: editTool,
}, 'system-files')

const systemExecutionTools = structureToolDescriptionsForCategory({
  [SystemToolNames.run]: runTool,
  [SystemToolNames.refreshEnvironment]: refreshEnvironmentTool,
  [SystemToolNames.listTasks]: listTasksTool,
}, 'system-execution')

/** 系统空间的六个模型面工具，按工具名索引。 */
export const systemTools: SystemToolCollection = Object.freeze({
  ...systemFileTools,
  ...systemExecutionTools,
})

// ── 作为官方内置 mod 挂进产品 ──────────────────────────────

/**
 * 系统空间的常驻工具：读—看—改—跑这条主回路，找文件也走 run。
 *
 * 后台任务、环境刷新是排障与收尾场景，留在 loadable 由 `tooling:map` 按名换入。
 */
const SystemResidentToolNames = new Set<string>([
  SystemToolNames.read,
  SystemToolNames.view,
  SystemToolNames.edit,
  SystemToolNames.run,
])

const SystemToolCategories = Object.freeze({
  'system-files': Object.freeze<ToolCategoryDefinition>({
    id: 'system-files',
    label: 'System files',
    description: '显式系统路径下的有界文件操作。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
  'system-execution': Object.freeze<ToolCategoryDefinition>({
    id: 'system-execution',
    label: 'System execution',
    description: '受治理的系统命令与后台任务。',
    toolOs: { domain: 'system', defaultState: 'resident' },
  }),
} satisfies Record<SystemToolCategoryId, ToolCategoryDefinition>)

/** 系统空间 mod 的清单，按上游 `AgentModManifest` 契约校验。 */
const SystemAgentModManifest = Object.freeze<AgentModManifest>({
  id: SystemModId,
  version: '1.0.0',
  publisher: 'VelarOS',
  displayName: 'VelarOS System',
  description: '系统空间的文件与执行职责包。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: Object.values(SystemToolCategories).map((category, order) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      order: 10 + order,
    })),
    tools: Object.values(SystemToolNames).map((name) => ({
      name,
      categoryId: SystemToolCategoryByName[name],
      availableInSpaces: [SystemSpaceId],
      residentInSpaces: optionalWhen(SystemResidentToolNames.has(name), [SystemSpaceId]),
    })),
    // 只声明**真被消费**的那几格（身份策略 / 绑定能力 / 职责类别）。空间的文案、图标、
    // 顺序与 surface 分档权威在产品壳的枚举表，manifest 里再写一份没有读者。
    spaces: [{
      id: SystemSpaceId,
      identityStrategy: 'ordinal',
      boundCapabilityIds: [SystemModId],
      toolCategoryIds: Object.keys(SystemToolCategories),
    }],
  },
})

/** 创建系统空间作为官方内置 mod 的定义，产品壳的 mod 加载器按它挂载系统空间。 */
export function createSystemBundledModDefinition(): SystemBundledModDefinition {
  return Object.freeze({
    id: SystemModId,
    specifier: `bundled:${SystemModId}`,
    defaultEnabled: true,
    manifest: SystemAgentModManifest,
    bindings: Object.freeze({ tools: systemTools, toolCategories: SystemToolCategories }),
  })
}

// ── 作为能力服务挂进 VelarOS 内核 ──────────────────────

/** 系统能力服务在内核里的身份令牌，宿主按它取到注入的系统工具集合。 */
export const SystemCapability: CapabilityToken<SystemCapabilityService> =
  createCapabilityToken<SystemCapabilityService>(SystemModId)

/** 创建系统空间的内核模块：激活时把六个工具登记成能力服务；宿主给了上下文解析器，工具才能被按名调用。 */
export function createSystemKernelModule(
  options: CreateSystemKernelModuleOptions = {},
): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: SystemModId,
      version: '1.0.0',
      apiVersion: KernelModuleApiVersion,
      provides: [SystemCapability],
      requires: [],
      optionalRequires: [],
      permissions: [
        'fs:read',
        'fs:write',
        'process:exec',
      ],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(
        createSystemCallableOperations(systemTools, options.resolveContext),
      )
      const service: SystemCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...systemTools }),
      })
      context.registerService(SystemCapability, service)
    },
  })
}
