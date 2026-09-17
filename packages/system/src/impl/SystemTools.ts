/**
 * 系统空间的七个模型面工具。每个工具的说明就是它的定义：摘要、适用与禁用场景、协议、用法、示例、参数、权限和能力声明都在定义里，上方不再另写一遍；
 * execute 一律只把入参转交给 impl 里的操作方法：读、看、写交给 `SystemFileOperations`，跑命令、演练沙箱、刷新环境、列后台任务交给 `SystemExecutionOperations`。
 * 七个工具的操作方法都在操作接口上，缺一个它就进不了代码面（`baselines/code-surface/system.d.ts`）。
 * 按文件、执行两类排列，文件末尾是它们怎么分组、作为内置 mod 挂进产品、作为能力服务挂进内核。
 * 只留 `system:run` 替代不了的：读和写要把内容和精确匹配绕开 shell 引号，看图片要把内容当图交给模型，后台任务表只在本包，刷新环境改的是宿主进程，演练沙箱要把命令钉在镜像里。PDF 与其他文档归别的 mod。
 * 读、看、写都是 files 每项一个文件，一个文件就一项。列目录、搜文本、看进程和端口、终止进程都用 `system:run` 跑系统命令。
 * 这是人最先看的文件，改了要在差量报告里点名。
 */


import type { AgentModManifest, ToolCategoryDefinition } from '@velaros-ai/agent/contracts'
import { isEmpty, optionalWhen } from '@velaros-ai/core'
import type {
  KernelModuleDefinition,
} from '@velaros-ai/kernel'
import {
  kernelModules,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'
import { shellCommandPolicy } from '@velaros-ai/shell-command'
import { toolDescriptions, toolKernelModules } from '@velaros-ai/tool-contract'

import type { SystemToolCategoryId } from '../contract/constants.js'
import { SystemCommandLimits, SystemFileLimits, SystemModId, SystemSpaceId, SystemToolCategoryByName, SystemToolNames } from '../contract/constants.js'
import type { SystemBundledModDefinition, SystemCapabilityService, SystemToolCollection } from '../contract/provides.js'
import type { CreateSystemKernelModuleOptions, SystemToolContext } from '../contract/requires.js'
import type { SystemListTasksInput, SystemRefreshEnvironmentInput, SystemRunInput } from '../types/commands.js'
import type { SystemEditInput, SystemReadInput, SystemViewInput } from '../types/files.js'
import type { SystemSandboxInput } from '../types/sandbox.js'
import {
  editInputSchema,
  listTasksInputSchema,
  readInputSchema,
  refreshEnvironmentInputSchema,
  runInputSchema,
  sandboxInputSchema,
  viewInputSchema,
} from '../utils/operation-schemas.js'
import { defineSystemTool } from '../utils/tool.js'

import { systemExecutionOperations } from './SystemExecutionOperations.js'
import { systemFileOperations } from './SystemFileOperations.js'

// ── 文件：读文本、看图片、写（都是 files 每项一个；写可以一次改几处）──────────────────────────

/** system:read —— 读文本文件。 */
const readTool = defineSystemTool<SystemReadInput>({
  name: SystemToolNames.read,
  role: 'inspect',
  summary: '读文本文件：files 每项一个文件，按字符取一段，返回它的 range 和版本号。',
  suitable: ['看日志、配置、脚本、临时文件等文本，一个或一批。'],
  forbidden: ['图片用 system:view；PDF 和其他文档不在这里读；列目录、搜文本用 system:run。'],
  usage: [
    `只传 path 就默认一次读到上限；没读完的文件把它返回的 range.end 当 offset 接着读。一次调用总共最多 ${SystemFileLimits.readChars} 字符，预算在前面的文件用完后，后面的文件不读、那一项是 error，note 会说明。`,
    '结果的 files 与传入的一一对应，某个文件读不了只有它那一项是 error；version 是这份内容的版本号，传回去可以读旧内容。',
  ],
  examples: [{ files: [{ path: '~/build.log' }] }, { files: [{ path: '~/.zshrc' }, { path: '~/build.log', offset: SystemFileLimits.readChars }] }],
  notes: ['其他二进制文件读不了。读私钥、云凭证这类文件会先向用户确认。'],
  schema: readInputSchema,
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
  execute: (input, ctx) => systemFileOperations.read(input, ctx),
})

/** system:view —— 看图片。 */
const viewTool = defineSystemTool<SystemViewInput>({
  name: SystemToolNames.view,
  role: 'inspect',
  summary: '看图片：files 每项一张图，整张交给模型，效果和用户上传一样。',
  suitable: ['看截图、照片、图表等图片的内容。'],
  forbidden: ['文本文件用 system:read；PDF 和其他文档不在这里看。'],
  usage: ['结果的 files 与传入的一一对应，内容块按同样的顺序排；某个文件看不了只有它那一项是 error。'],
  examples: [{ files: [{ path: '~/Desktop/screenshot.png' }] }, { files: [{ path: '~/Desktop/before.png' }, { path: '~/Desktop/after.png' }] }],
  notes: [`只认 PNG、JPEG、GIF、WebP，最大 ${SystemFileLimits.imageBytes / 1024 / 1024} MB；别的格式或太大的先用 system:run 转换、缩小。`],
  schema: viewInputSchema,
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
  execute: (input, ctx) => systemFileOperations.view(input, ctx),
})

/** system:edit —— 写文件：整个写入、改几处、回滚。 */
const editTool = defineSystemTool<SystemEditInput>({
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
  notes: [`写系统敏感路径、私钥和云凭证这类文件会先向用户确认；路径是符号链接时改的是它指向的文件，结果里 target 给出那个文件。newText 只能写到文本文件或新文件上，已有的二进制文件用 system:run 换。改完之后 windows 每处带新位置，改动那段不超过 ${SystemFileLimits.editWholeChars} 字符时 content 和 range 整段给出；旧的 range 已经作废，再改同一个文件用新的。`],
  inputReuse: true,
  schema: editInputSchema,
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
  execute: (input, ctx) => systemFileOperations.edit(input, ctx),
})

// ── 执行：跑命令、刷新环境 ──────────────────────────────────

/** system:run —— 在系统 shell 中执行命令，shell 字段挑哪一个。 */
const runTool = defineSystemTool<SystemRunInput>({
  name: SystemToolNames.run,
  role: 'execute',
  summary: '在系统 shell 里执行命令：不填 shell 就用环境报告里的默认那个。',
  suitable: [
    '执行系统诊断、跨目录探测、工具安装后检查或本地脚本。',
    '处理没有专用 primitive 的系统文件操作，例如复制、移动、删除、归档、解压、权限检查或修改。',
    '列目录、搜文本、看进程和端口、终止进程：POSIX 用 ls / find / grep 或 rg / ps / lsof / kill；PowerShell 用 Get-ChildItem / Select-String / Get-Process / netstat / Stop-Process；CMD 用 dir / findstr / tasklist / netstat / taskkill。',
    '打开文件或网址、在文件管理器里定位、启动本地应用：macOS 用 open、open -R、open -a；Windows 用 start、explorer /select,；Linux 用 xdg-open。',
  ],
  forbidden: ['不要执行危险写命令、长期服务或重复命令，除非已有用户意图或确认。'],
  protocol: [
    '不传 cwd 时用宿主给的默认目录。',
    '不传 shell 就用环境报告里的默认 shell，命令按它的语法写：Git Bash/POSIX 用 command -v、$NAME；PowerShell 用 Get-Command、$env:NAME；CMD 用 where、%NAME%。要用别的就填 shell，可用清单见环境报告；Windows 上首选 git-bash，没有时建议用户装 Git for Windows。',
    '命令执行失败后先诊断原始退出码和输出；换一个 shell 重跑之前先按新语法重写命令，避免重复执行副作用。',
    `长期服务传 background=true；危险命令会走确认流程。后台命令的状态用返回的 statusContinuation 查；回执里有 outputContinuation 时用它取更多输出，没有就用 system:list-tasks 条目里的 recentOutput（末尾 ${SystemCommandLimits.recentOutputChars} 字符）。不要用 job:*，也不要把内部 logPath 当普通文件读。`,
    '输出可能很长时设置 maxOutputChars；返回窗口固定保留结尾，outputWindow.endPreserved=true 时可直接信任末尾内容。',
  ],
  usage: [
    '传 command；需要特定目录时传 cwd。',
    `命令会问用户口令、y/n 或选项时传 interactive=true：命令在控制台里跑，用户在卡片里输入，本次调用立刻返回，之后用 system:list-tasks 看结果（recentOutput 是末尾 ${SystemCommandLimits.recentOutputChars} 字符）。`,
    '停后台任务时执行 system:list-tasks 条目里的 terminateCommand 或 forceTerminateCommand，不要自己拼 pid。',
  ],
  examples: [
    { command: 'git --version', maxOutputChars: 2000 },
    // 环境报告把 pwsh 列为可用时，才这么挑
    { command: 'Get-ChildItem -Force', shell: 'pwsh' },
  ],
  notes: ['cwd 与 shell 只影响本次命令，不改宿主的默认值。'],
  schema: runInputSchema,
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
  isConcurrencySafe: (input) => shellCommandPolicy.isParallelSafe(input),
  execute: (input, ctx) => systemExecutionOperations.run(input, ctx),
})

/** system:refresh-environment —— 刷新宿主进程的 shell 环境。 */
const refreshEnvironmentTool = defineSystemTool<SystemRefreshEnvironmentInput>({
  name: SystemToolNames.refreshEnvironment,
  role: 'control',
  summary: '刷新宿主进程的 shell 环境：Windows 上重读用户与系统环境变量并写回本进程；其他平台重新选定 shell（每条命令本来就经登录 shell 重读配置）。',
  suitable: ['Windows 上刚安装 CLI、改了环境变量后 PATH 里还缺命令时刷新一次，让后续命令看到新的 PATH。'],
  forbidden: [
      '不要把它当作命令存在性检查；检查命令可用性用 system:run（Windows 用 where，macOS/Linux 用 command -v）。',
      '同一个问题只刷新一次；刷新后还缺就是没装，不要反复调用。',
    ],
  protocol: [
      '先确认缺失命令或 PATH 变化，再刷新；刷新后用 system:run 按宿主 shell 语法验证目标命令是否可见。',
    ],
  notes: ['只改宿主进程的环境，不会改用户的 shell 配置文件；结果里的 reason 说明 Windows 上为什么没刷新成功。'],
  // 没有参数就不校验：传了什么都不报错，只在结果里提醒一句。
  schema: refreshEnvironmentInputSchema,
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
  // 传了参数不报错，只提醒一句：这是工具面 schema 收得宽才有的情况，代码面的 refreshEnvironment 不收入参。
  execute: async (input, ctx) => {
    const refreshed = await systemExecutionOperations.refreshEnvironment(ctx)
    return isEmpty(Object.keys(input)) ? refreshed : { ...refreshed, note: '这个工具不需要参数，传来的内容已忽略。' }
  },
})

// ── 后台任务：列出 run 启动的后台任务 ────────────────────────

/** system:list-tasks —— 列出本产品启动过的后台任务。 */
const listTasksTool = defineSystemTool<SystemListTasksInput>({
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
    { taskId: '3f6c2c2e-8a1d-4b7e-9c2a-6f1e0d2b4a55' },
  ],
  notes: ['taskId 只在这里和 system:run 之间流转，不交给 job:*。', '要停掉任务，用 system:run 执行条目里的 terminateCommand；强制停用 forceTerminateCommand。'],
  schema: listTasksInputSchema,
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
  execute: (input, ctx) => systemExecutionOperations.listTasks(input, ctx),
})

// ── 演练沙箱：把目录镜像到临时区，脚本先在镜像里跑 ────────────

/** system:sandbox —— 演练沙箱：建镜像、看差量、落回、丢弃。 */
const sandboxTool = defineSystemTool<SystemSandboxInput>({
  name: SystemToolNames.sandbox,
  role: 'edit',
  summary: '演练沙箱：把一个目录镜像到临时区，脚本先在镜像里跑（写不到镜像外），diff 看变了什么，确认后 apply 落回源目录。',
  suitable: ['要一次改很多文件、删目录、跑迁移或批处理脚本之前，先在镜像里跑一遍看结果。', '拿不准一段脚本会不会误删误改的时候。'],
  forbidden: ['改一两个文件直接用 system:edit；只读命令直接用 system:run。', '不要把镜像里的结果当成已经发生：落回之前源目录一个字节都没变。'],
  usage: [
    'create 返回 root（镜像根）：把脚本用 system:edit 写进 root，用 system:run 传 cwd=root 跑；镜像里的命令只能写镜像和它自己的临时目录，写到源目录会直接失败，所以脚本里算错的路径在这里只会报错。',
    'diff 看新增、修改、删除三列和文本差量；不对就改脚本再跑，镜像随便糟蹋。',
    'apply 把文件变化落回源目录，会先向用户确认并列出删除与覆盖；源文件在这期间被别人改过就整批不落。git 历史的变化不落回，要在真实目录重放那几条 git 命令。',
    '用完 discard。gitignore 忽略的目录（node_modules 等）缺省是指向真实目录的链接，脚本能用依赖但写不进去；要在镜像里重新构建就 create 时传 ignored=copy。',
  ],
  examples: [
    { action: 'create', source: '~/projects/app' },
    { action: 'diff', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'apply', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'discard', sandboxId: '20260915-183000-3fa2c1' },
  ],
  notes: ['镜像里的命令连不上网，除非 create 时传 network=true；镜像仓库推不出去。没有进程约束后端的机器上建不出沙箱。'],
  schema: sandboxInputSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: {
    effectKind: 'write',
    readScopes: ['any'],
    writeScopes: ['any'],
    filesystem: { read: 'any', write: 'any' },
    canReadArbitrarySource: true,
    concurrency: 'unsafe',
    reason: 'rehearsal sandbox lifecycle',
  },
  isConcurrencySafe: () => false,
  execute: (input, ctx) => systemExecutionOperations.sandbox(input, ctx),
})

// ── 工具集合：按职责类别分组 ────────────────────────────────────

/**
 * 工具集合的装配：七个工具按两个职责类别分组。
 *
 * 每个工具的定义（提示词、schema、权限、execute）在上面；这里只决定谁属于哪一类、以及全量集合长什么样。
 * 类别 id 与 `contract/system.ts` 里的表一致。
 */

const systemFileTools = toolDescriptions.forCategory({
  [SystemToolNames.read]: readTool,
  [SystemToolNames.view]: viewTool,
  [SystemToolNames.edit]: editTool,
}, 'system-files')

const systemExecutionTools = toolDescriptions.forCategory({
  [SystemToolNames.run]: runTool,
  [SystemToolNames.refreshEnvironment]: refreshEnvironmentTool,
  [SystemToolNames.listTasks]: listTasksTool,
  [SystemToolNames.sandbox]: sandboxTool,
}, 'system-execution')

/** 系统空间的七个模型面工具，按工具名索引。 */
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
  kernelModules.token<SystemCapabilityService>(SystemModId)

/** 创建系统空间的内核模块：激活时把七个工具登记成能力服务；宿主给了上下文解析器，工具才能被按名调用。 */
export function createSystemKernelModule(
  options: CreateSystemKernelModuleOptions = {},
): KernelModuleDefinition {
  return toolKernelModules.define<SystemToolContext, SystemCapabilityService>({
    id: SystemModId,
    version: '1.0.0',
    permissions: ['fs:read', 'fs:write', 'process:exec'],
    token: SystemCapability,
    tools: systemTools,
    resolveContext: options.resolveContext,
    label: '系统',
  })
}
