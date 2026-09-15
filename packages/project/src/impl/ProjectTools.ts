/**
 * 项目空间的九个模型面工具与可选的 project:code-analysis。每个工具的定义就是模型看到的全部信息面：摘要、适用与禁用场景、协议、用法、示例、
 * 参数（schema 与每个字段的说明）、权限、能力声明都在定义里；execute 一行交给 impl/operations 里的执行类。
 * 按读取、改动、代码理解、执行四类排列，文件末尾是它们怎么分组、作为内置 mod 挂进产品、作为能力服务挂进内核、连同内核组成项目空间。
 * 这是人最先看的文件，改了要在差量报告里点名。
 */

import { z } from 'zod'

import type { AgentModManifest, ToolCapabilitySchema, ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import { isNotUndefined, isUndefined, optionalWhen } from '@velaros-ai/core'
import type { CapabilityToken, KernelModuleDefinition } from '@velaros-ai/kernel/contracts/abi'
import { createCapabilityToken, createKernelCallableCapability, defineKernelModule, KernelModuleApiVersion } from '@velaros-ai/kernel/contracts/abi'

import { ProjectChangeLimits, ProjectCodeAnalysisModId, ProjectCodeAnalysisToolName, ProjectCodeLimits, ProjectCommandLimits, ProjectFileLimits, ProjectModId, ProjectPackageVersion, ProjectSandboxLimits, ProjectSpaceId, ProjectToolExposure, ProjectToolNames } from '../contract/constants.js'
import type { ProjectBundledModDefinition, ProjectCapabilityService, ProjectCodeAnalysisContribution, ProjectSpace, ProjectToolCollection } from '../contract/provides.js'
import type { CreateProjectKernelModuleOptions, CreateProjectKernelOptions, ProjectToolContext } from '../contract/requires.js'
import type { ProjectChangeStep, ProjectEditInput, ProjectFileInput } from '../types/editing.js'
import type { ProjectChangeInput, ProjectCodeAnalysisInput, ProjectCodeInput, ProjectListInput, ProjectReadInput, ProjectRunInput, ProjectSandboxInput, ProjectSearchInput } from '../types/tools.js'
import { ProjectSourceInstructions } from '../utils/agent/source-window.js'
import { isParallelCommandExecutionSafe } from '../utils/command-policy.js'
import { createProjectCallableOperations, defineProjectTool, hasExactlyOneSource } from '../utils/tool.js'

import { createProjectKernel } from './kernel/LocalProjectKernel.js'
import { projectChangeOperations } from './operations/ProjectChangeOperations.js'
import { projectCodeOperations } from './operations/ProjectCodeOperations.js'
import { projectExecutionOperations } from './operations/ProjectExecutionOperations.js'
import { projectFileOperations } from './operations/ProjectFileOperations.js'

// ── 能力声明：读、写、执行三类 ─────────────────────────────────────────

/** 当前活动项目内的只读文件与代码查询。 */
const ProjectReadCapability = {
  effectKind: 'read',
  readScopes: ['project'],
  filesystem: { read: 'project', write: 'none' },
  canReadArbitrarySource: false,
  concurrency: 'safe',
  metadata: { canMutateProject: false },
  reason: 'active project read',
} satisfies ToolCapabilitySchema

/** 当前活动项目内由 Project 事务边界治理的文件修改。 */
const ProjectWriteCapability = {
  effectKind: 'write',
  readScopes: ['project'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  metadata: { canMutateProject: true },
  reason: 'governed active project mutation',
} satisfies ToolCapabilitySchema

/** 项目 cwd 内的命令执行；具体读写与时长由命令参数决定。 */
const ProjectExecutionCapability = {
  effectKind: 'execute',
  readScopes: ['project'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  process: { execution: 'input-dependent' },
  canReadArbitrarySource: false,
  concurrency: 'input-dependent',
  metadata: { canMutateProject: true },
  reason: 'active project command execution',
} satisfies ToolCapabilitySchema

// ── 共用的入参片段 ─────────────────────────────────────────────────────

/** 行号或连续闭区间：51、[51]、[42,45]。 */
const LineNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const ProjectLineRangeSchema = z.union([
  LineNumber,
  z.tuple([LineNumber]),
  z.tuple([LineNumber, LineNumber]).refine(([start, end]) => end >= start, '结束行必须大于或等于起始行。'),
]).describe('行号或连续闭区间：51、[51]、[42,45]；末行不小于首行。')

/** 引用是不透明的回执；示例只说明来源，不编造取值。 */
const ProjectFileRefSchema = z.string().min(1)
  .describe('原样复制本次会话读取或修改回执中的 fileRef；示例中的 <fileRef> 必须替换，不能手写引用。')
const ProjectChangeRefSchema = z.string().min(1)
  .describe('原样复制 edit/file/change 成功回执中的 changeRef；示例占位符不是有效引用。')

/** 一处源码编辑：range 选完整行，match 在区域里选唯一原文，text 只填源码。 */
const EditSelector = {
  range: ProjectLineRangeSchema.optional(),
  match: z.string().min(1).optional().describe('区域中唯一的字面源码；省略 range 时只搜索 fileRef 实际可见区域。'),
}
const ProjectContentEditSchema = z.union([
  z.strictObject({ op: z.literal('replace'), ...EditSelector, text: z.string() })
    .refine((value) => !isUndefined(value.range) || !isUndefined(value.match), 'replace 需要 range 或 match。'),
  z.strictObject({ op: z.literal('insert'), ...EditSelector, side: z.enum(['before', 'after']), text: z.string() })
    .refine((value) => !isUndefined(value.range) || !isUndefined(value.match), '定位插入需要 range 或 match。'),
  z.strictObject({ op: z.literal('insert'), at: z.enum(['start', 'end']), text: z.string() }),
]).describe('range 选择完整行；match 从区域选择唯一原文；text 仅填源码。整行操作维护换行边界，字符操作按 text 插入。')

/** recode 只改磁盘字节表示，不改 Unicode 正文；模型读写文本时永远不接触编码。 */
const ProjectRecodeActionSchema = z.strictObject({
  op: z.literal('recode'),
  paths: z.array(z.string().min(1)).min(1).max(ProjectChangeLimits.recodePaths),
  encoding: z.enum(['utf-8', 'utf-16le', 'utf-16be', 'gb18030']).optional().describe('目标字符编码，默认 utf-8。'),
  bom: z.boolean().optional().describe('是否写入 BOM，默认不写；gb18030 不支持。'),
  newline: z.enum(['lf', 'crlf']).optional().describe('统一物理换行；省略则保留各文件原换行。'),
})

/** project:change 的计划里引用一个文件：fileRef 固定读取版本，sourceRef 跟随此前步骤的移动与修改，path 只引用本计划新建的文件。 */
const PlanSource = {
  fileRef: ProjectFileRefSchema.optional(),
  sourceRef: ProjectFileRefSchema.optional().describe('原样复制原 fileRef；跟随此前计划步骤的移动和修改。'),
  path: z.string().min(1).optional().describe('仅引用本计划创建的文件。'),
}
const OneSourceMessage = '仅填写 fileRef、sourceRef、path 之一。'
const ProjectPlanFileActionSchema = z.union([
  z.strictObject({ op: z.literal('create'), path: z.string().min(1), text: z.string() }),
  z.strictObject({ op: z.literal('overwrite'), ...PlanSource, text: z.string() }).refine(hasExactlyOneSource, OneSourceMessage),
  z.strictObject({ op: z.literal('move'), ...PlanSource, to: z.string().min(1) }).refine(hasExactlyOneSource, OneSourceMessage),
  z.strictObject({ op: z.literal('delete'), ...PlanSource }).refine(hasExactlyOneSource, OneSourceMessage),
  ProjectRecodeActionSchema,
])

/** 代码查询的目标：前序 symbols 返回的 symbolRef，或 {path, symbol, container?}；调用方不需要后端节点 id。 */
const ProjectCodeTargetSchema = z.union([
  z.strictObject({ symbolRef: z.string().startsWith('symbol:') }),
  z.strictObject({ path: z.string().min(1), symbol: z.string().min(1), container: z.string().min(1).optional() }),
])
/** 代码查询共用的范围字段。 */
const CodeScope = {
  language: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  limit: z.number().int().positive().max(ProjectCodeLimits.results).optional(),
  extensions: z.array(z.string().min(1)).max(ProjectCodeLimits.extensions).optional(),
  maxDepth: z.number().int().nonnegative().max(ProjectCodeLimits.scanDepth).optional(),
}

// ── 读取：读源码、列文件、搜源码 ─────────────────────────────────────────

/** project:read —— 读带版本的源码行。 */
const readTool = defineProjectTool<ProjectReadInput>({
  name: ProjectToolNames.read,
  category: 'project-files',
  role: 'inspect',
  summary: '读取带版本的源码行，拿到编辑时用的 fileRef。',
  usage: [
    ProjectSourceInstructions,
    `用 path 加 range（单个行号或 [首行,末行]）、files（每项各自的 range，最多 ${ProjectFileLimits.readFiles} 个文件）或返回的 continuation 三选一。maxChars 是这次调用所有文件共用的字符预算。`,
  ],
  examples: [{ files: [{ path: 'src/service.ts', range: [42, 60] }, { path: 'src/types.ts', range: 20 }] }],
  schema: z.strictObject({
    path: z.string().min(1).optional(),
    range: ProjectLineRangeSchema.optional(),
    files: z.array(z.strictObject({ path: z.string().min(1), range: ProjectLineRangeSchema.optional() })).min(1).max(ProjectFileLimits.readFiles).optional(),
    continuation: z.string().startsWith('read-page:').optional(),
    maxChars: z.number().int().positive().max(ProjectFileLimits.readChars).optional(),
  }).superRefine((input, context) => {
    if ([input.path, input.files, input.continuation].filter(isNotUndefined).length !== 1)
      context.addIssue({ code: 'custom', message: 'path、files、continuation 只能选一个。' })
    if (isNotUndefined(input.range) && isUndefined(input.path))
      context.addIssue({ code: 'custom', path: ['range'], message: 'range 只配合 path 使用；批量读取时每个 files 项各带自己的 range。' })
    if (isNotUndefined(input.maxChars) && input.files && input.maxChars < input.files.length)
      context.addIssue({ code: 'custom', path: ['maxChars'], message: 'maxChars 至少要给每个文件分到一个字符。' })
  }),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: ProjectToolExposure.read,
  isConcurrencySafe: () => true,
  execute: (input, ctx) => projectFileOperations.read(input, ctx),
})

/** project:list —— 列项目文件和目录。 */
const listTool = defineProjectTool<ProjectListInput>({
  name: ProjectToolNames.list,
  category: 'project-files',
  role: 'inspect',
  summary: '列出项目文件和目录，支持路径、glob、深度及稳定分页。',
  protocol: ['include/exclude 相对 path 匹配，也接受项目根相对路径；续页直接传 cursor。'],
  examples: [{ path: 'src', recursive: true, limit: 100 }],
  schema: z.strictObject({
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(ProjectFileLimits.patterns).optional(),
    exclude: z.array(z.string().min(1)).max(ProjectFileLimits.patterns).optional(),
    recursive: z.boolean().optional().default(false),
    maxDepth: z.number().int().nonnegative().max(ProjectFileLimits.listDepth).optional(),
    limit: z.number().int().positive().max(ProjectFileLimits.listPage).optional().default(ProjectFileLimits.listPageDefault),
    cursor: z.string().min(1).optional().describe('直接使用上一页返回的 cursor；其余查询条件由游标保存。'),
  }).superRefine((input, context) => {
    if (input.cursor && (isNotUndefined(input.path) || input.include || input.exclude || isNotUndefined(input.maxDepth) || input.recursive))
      context.addIssue({ code: 'custom', path: ['cursor'], message: '续页只传 cursor 和可选 limit；修改过滤条件请重新查询。' })
  }),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: ProjectToolExposure.list,
  isConcurrencySafe: () => true,
  execute: (input, ctx) => projectFileOperations.list(input, ctx),
})

/** project:search —— 按字面文本或正则搜源码。 */
const searchTool = defineProjectTool<ProjectSearchInput>({
  name: ProjectToolNames.search,
  category: 'project-files',
  role: 'inspect',
  summary: '按字面文本或正则搜索，返回可直接用于编辑的带版本源码窗口。',
  usage: [
    ProjectSourceInstructions,
    'regex=false 时按字面匹配，| 没有特殊含义。只有显示出来的源码窗口带可编辑的 fileRef；只有定位信息的命中要先 read。',
    '符号定义、引用、调用者与依赖影响优先使用当前可用的 project:code；需要查找该能力时，按本轮已提供的工具发现入口操作。仅有文本搜索时，将命中作为候选证据。',
  ],
  examples: [{ query: 'loadSettings', path: 'src' }],
  schema: z.strictObject({
    query: z.string().min(1),
    path: z.string().optional(),
    include: z.array(z.string().min(1)).max(ProjectFileLimits.patterns).optional(),
    exclude: z.array(z.string().min(1)).max(ProjectFileLimits.patterns).optional(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    limit: z.number().int().positive().max(ProjectFileLimits.searchHits).optional(),
    contextLines: z.number().int().nonnegative().max(ProjectFileLimits.searchContextLines).optional(),
  }),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: ProjectToolExposure.search,
  isConcurrencySafe: () => true,
  execute: (input, ctx) => projectFileOperations.search(input, ctx),
})

// ── 改动：文件动作、源码编辑、组合变更 ─────────────────────────────────────

/** project:file 的入参：actions 按顺序执行，每项是 create、overwrite、move、delete、recode 之一。 */
export const ProjectFileSchema = z.strictObject({
  actions: z.array(z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('create'), path: z.string().min(1), text: z.string() }),
    z.strictObject({ op: z.literal('overwrite'), fileRef: ProjectFileRefSchema, text: z.string() }),
    z.strictObject({ op: z.literal('move'), fileRef: ProjectFileRefSchema, to: z.string().min(1) }),
    z.strictObject({ op: z.literal('delete'), fileRef: ProjectFileRefSchema }),
    ProjectRecodeActionSchema,
  ])).min(1).max(ProjectChangeLimits.fileActions),
})

/** project:file —— 创建、覆盖、移动、删除文件，或批量转换磁盘编码。 */
const fileTool = defineProjectTool<ProjectFileInput>({
  name: ProjectToolNames.file,
  category: 'project-changes',
  role: 'edit',
  summary: '通过事务创建、整体覆盖、移动、删除项目文件，或批量转换文件的磁盘编码。',
  usage: [
    'actions 中 create 传 path/text；overwrite 传 fileRef/text；move 传 fileRef/to；delete 传 fileRef。create 拒绝覆盖已有路径。',
    'recode 传 paths 与可选 encoding（默认 utf-8）、bom、newline：框架探测原编码并按目标格式重写字节，Unicode 正文不变，已是目标格式的文件跳过；读取与编辑永远只处理文本，不需要也不接受编码参数。',
    'move 本身只移动文件。移动与源码引用更新需要共同提交且本轮提供 project:change 时，用它组合文件动作和编辑。',
    '失败回执包含 inputReuse 时，用 reuse + changes 修正字段，正文自动复用。',
    '本轮提供 project:change 时，整组撤销用回执的 changeRef 调用 undo，无需重新输入原文件内容。需要查找该能力时，按本轮已提供的工具发现入口操作。',
  ],
  examples: [{ actions: [{ op: 'create', path: 'src/cache.ts', text: 'export const cache = new Map()\n' }] }],
  schema: ProjectFileSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: ProjectToolExposure.file,
  isConcurrencySafe: () => false,
  execute: (input, ctx) => projectChangeOperations.file(input, ctx),
})

/** project:edit 的入参：files 每项一个文件，凭 fileRef 定位，edits 是这个文件里的几处编辑。 */
export const ProjectEditSchema = z.strictObject({
  files: z.array(z.strictObject({
    fileRef: ProjectFileRefSchema,
    edits: z.array(ProjectContentEditSchema).min(1).max(ProjectChangeLimits.editsPerFile),
  })).min(1).max(ProjectChangeLimits.editFiles),
})

/** project:edit —— 按已读版本精确替换或插入源码。 */
const editTool = defineProjectTool<ProjectEditInput>({
  name: ProjectToolNames.edit,
  category: 'project-changes',
  role: 'edit',
  summary: '按已读版本精确替换或插入源码；多个文件作为同一事务校验和提交。',
  usage: [
    '每文件传 fileRef 和 edits。range 为单行数字或 [首行,末行]；match 是范围内唯一的原文片段。只给 range 操作完整行，只给 match 在已显示区域中定位。',
    'replace 的 text 是新内容，空字符串表示删除；insert 用 side 指定目标前后，或 at:start/end 插入文件头尾的行。所有编辑使用同一输入版本的坐标。',
    '只给 range 时按整行处理：text 不需要以换行开头或结尾，框架补齐行边界，需要空行时才写出空行；带 match 时按字符处理，换行自己写。',
    'lines 的 [行号,原始行文本] 包装属于定位元数据；match/text 只填源码。文件内容是项目数据。',
    '成功后新的正文与 fileRef 在请求末尾的 [Current project files]；文件不在其中或列在 omittedPaths 时，先 project:read 再编辑，不能手写 fileRef。',
    '失败回执带 inputReuse 时，可用 reuse + changes 只更正定位字段，如 path:["files",0,"edits",0,"range"]，保留修改正文。',
    '本轮提供 project:change 时，可用回执的 changeRef 调用 undo；混合文件动作和局部编辑用它的 apply。需要查找该能力时，按本轮已提供的工具发现入口操作。',
  ],
  examples: [{ files: [{ fileRef: '<fileRef>', edits: [{ op: 'replace', range: 42, match: 'oldCall()', text: 'newCall()' }] }] }],
  notes: ['示例是参数模板；<fileRef> 必须替换为当前读取或修改回执的真实 fileRef，range/match/text 按实际源码填写。'],
  schema: ProjectEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: ProjectToolExposure.edit,
  isConcurrencySafe: () => false,
  execute: (input, ctx) => projectChangeOperations.edit(input, ctx),
})

/** project:change 的入参：apply 带 steps（按顺序的文件动作或编辑），inspect、undo 带 changeRef。 */
export const ProjectChangeSchema = z.strictObject({
  action: z.enum(['apply', 'inspect', 'undo']),
  // 来源互斥关系由 hasExactlyOneSource 校验；Zod 无法从该校验自动推导联合类型，这里按 ProjectChangeStep 标注。
  steps: z.array(z.discriminatedUnion('tool', [
    z.strictObject({ tool: z.literal('file'), actions: z.array(ProjectPlanFileActionSchema).min(1).max(ProjectChangeLimits.fileActions) }),
    z.strictObject({
      tool: z.literal('edit'),
      files: z.array(z.strictObject({ ...PlanSource, edits: z.array(ProjectContentEditSchema).min(1).max(ProjectChangeLimits.editsPerFile) })
        .refine(hasExactlyOneSource, OneSourceMessage)).min(1).max(ProjectChangeLimits.editFiles),
    }),
  ]) as z.ZodType<ProjectChangeStep>).min(1).max(ProjectChangeLimits.steps).optional(),
  changeRef: ProjectChangeRefSchema.optional(),
}).superRefine((value, context) => {
  if (value.action === 'apply' ? !value.steps || !isUndefined(value.changeRef) : !value.changeRef || !isUndefined(value.steps))
    context.addIssue({ code: 'custom', message: 'apply 仅填写 steps；inspect/undo 仅填写 changeRef。' })
})

/** project:change —— 组合文件动作与编辑为一个事务，查看或撤销变更。 */
const changeTool = defineProjectTool<ProjectChangeInput>({
  name: ProjectToolNames.change,
  category: 'project-changes',
  role: 'edit',
  summary: '组合文件操作与源码编辑为一个事务，查看或撤销变更回执。',
  usage: [
    'apply 的 steps 按顺序使用 file.actions 或 edit.files。fileRef 固定读取版本；sourceRef 跟随计划中此前的移动和修改；path 只引用计划创建的文件。',
    'inspect/undo 只传 changeRef；undo 遇到外部修改会拒绝覆盖。普通 edit/file 已自动提交，不需要另行调用 apply。',
    '同一个 edit 步骤内坐标固定；后续步骤可以编辑此前步骤产生的新内容。失败用 reuse + changes 复用未变正文。',
  ],
  examples: [{ action: 'inspect', changeRef: '<changeRef>' }],
  notes: ['示例是参数模板；<changeRef> 必须替换为实际 edit/file/change 回执中的 changeRef。'],
  schema: ProjectChangeSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: ProjectWriteCapability,
  exposure: ProjectToolExposure.change,
  isConcurrencySafe: (input) => input.action === 'inspect',
  execute: (input, ctx) => projectChangeOperations.change(input, ctx),
})

// ── 代码理解 ─────────────────────────────────────────────────────────────

/** project:code —— 查询符号、引用候选、依赖、关系、影响与诊断。 */
const codeTool = defineProjectTool<ProjectCodeInput>({
  name: ProjectToolNames.code,
  category: 'development-code',
  role: 'inspect',
  summary: '查询符号、引用候选、依赖、调用/类型关系、影响范围与诊断；返回查询来源和覆盖范围。',
  suitable: ['需要理解代码结构、定位声明、评估修改影响或检查诊断。'],
  usage: [
    'symbols 可按 query/path 搜索；exportedOnly=true 包含可选 re-export；target 返回声明/body 范围和当前源码。',
    'target 使用前序 symbolRef 或 {path,symbol,container?}，无需填写后端节点 ID。path 搜索范围与 target 声明位置分开。',
    'dependencies：outgoing 查询 path 内的依赖，可选 kind/includeExternal；incoming 查询谁依赖 path 或 specifier，可选 within/includeReExports。按 direction 所属分支填写字段。',
    'degraded 表示能力或覆盖有限；引用候选、空诊断和未启用的关系后端不能当作精确验证。',
  ],
  notes: ['本轮提供 project:code-analysis 时，可用它查询高级 trace/cycles/deadcode/routing；索引生命周期由宿主管理。'],
  examples: [
    { action: 'symbols', query: 'UserService' },
    { action: 'references', target: { path: 'src/user.ts', symbol: 'UserService' } },
    { action: 'dependencies', direction: 'outgoing', path: 'src', includeExternal: true },
    { action: 'dependencies', direction: 'incoming', path: 'src/user.ts', within: 'src', includeReExports: true },
  ],
  schema: z.discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('symbols'),
      ...CodeScope,
      query: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      kinds: z.array(z.string().min(1)).max(ProjectCodeLimits.kinds).optional(),
      exact: z.boolean().optional(),
      exportedOnly: z.boolean().optional(),
      includeReExports: z.boolean().optional(),
      target: ProjectCodeTargetSchema.optional().describe('取得一个符号的声明/body 范围和当前源码。'),
    }).superRefine((input, context) => {
      if (input.target && [input.query, input.path, input.kinds, input.exact, input.exportedOnly, input.includeReExports].some(isNotUndefined))
        context.addIssue({ code: 'custom', message: 'target 详情与搜索过滤互斥。', path: ['target'] })
      if (isNotUndefined(input.includeReExports) && !input.exportedOnly)
        context.addIssue({ code: 'custom', message: 'includeReExports 仅用于 exportedOnly=true。', path: ['includeReExports'] })
    }),
    z.strictObject({
      action: z.literal('references'),
      ...CodeScope,
      target: ProjectCodeTargetSchema,
      path: z.string().min(1).optional().describe('限定引用搜索范围；声明位置由 target 指定。'),
    }),
    z.discriminatedUnion('direction', [
      z.strictObject({
        action: z.literal('dependencies'),
        ...CodeScope,
        direction: z.literal('incoming').describe('谁依赖目标：path 或 specifier 至少提供一个。'),
        path: z.string().min(1).optional().describe('被依赖的目标文件。'),
        specifier: z.string().min(1).optional().describe('匹配 import 的模块说明符，如 node:fs。'),
        within: z.string().min(1).optional().describe('限定调用方的搜索范围。'),
        includeReExports: z.boolean().optional().describe('是否包含重导出该目标的文件。'),
      }).refine((input) => isNotUndefined(input.path) || isNotUndefined(input.specifier), {
        message: 'incoming 需要 path 或 specifier。',
        path: ['path'],
      }).meta({
        // Zod refine 只参与运行时校验；显式把相同的定位要求传给模型。
        anyOf: [{ required: ['path'] }, { required: ['specifier'] }],
      }),
      z.strictObject({
        action: z.literal('dependencies'),
        ...CodeScope,
        direction: z.literal('outgoing').describe('范围内代码依赖谁。'),
        path: z.string().min(1).optional().describe('要查询的文件或目录；省略时查询项目。'),
        specifier: z.string().min(1).optional().describe('按 import 的模块说明符过滤，如 node:fs。'),
        kind: z.string().min(1).optional().describe('按依赖种类过滤。'),
        includeExternal: z.boolean().optional().describe('是否包含项目外部依赖。'),
      }),
    ]),
    z.strictObject({
      action: z.literal('relations'),
      cwd: CodeScope.cwd,
      limit: CodeScope.limit,
      target: ProjectCodeTargetSchema,
      kind: z.enum(['calls', 'types', 'related']),
      direction: z.enum(['incoming', 'outgoing', 'both']).optional().default('both'),
      depth: z.number().int().positive().max(ProjectCodeLimits.relationDepth).optional().default(ProjectCodeLimits.relationDepthDefault),
    }),
    z.strictObject({
      action: z.literal('impact'),
      ...CodeScope,
      target: ProjectCodeTargetSchema,
      path: z.string().min(1).optional(),
      kinds: z.array(z.string().min(1)).max(ProjectCodeLimits.kinds).optional(),
      depth: z.number().int().positive().max(ProjectCodeLimits.relationDepth).optional().default(ProjectCodeLimits.relationDepthDefault),
    }),
    z.strictObject({ action: z.literal('diagnostics'), ...CodeScope, path: z.string().min(1) }),
  ]),
  permissions: ['fs:read'],
  capabilities: ProjectReadCapability,
  exposure: ProjectToolExposure.code,
  isConcurrencySafe: () => true,
  execute: (input, ctx) => projectCodeOperations.code(input, ctx),
})

/**
 * 创建可选的 project:code-analysis：代码路径追踪、依赖环、未使用代码候选和框架路由，由宿主的图后端提供；
 * 不在默认工具集合里，宿主给出可用性判断后单独登记。
 */
export function createProjectCodeAnalysisTools(isAvailable: (context: ProjectToolContext) => boolean): ProjectToolCollection {
  const analysisTool = defineProjectTool<ProjectCodeAnalysisInput>({
    name: ProjectCodeAnalysisToolName,
    category: 'development-code',
    role: 'inspect',
    summary: '按需查询代码路径追踪、依赖环、未使用代码候选和框架路由。',
    usage: ['trace 的 from/to 使用符号引用或 {path,symbol}。deadcode 返回候选，删除之前必须核验动态入口。'],
    notes: ['由宿主提供图后端时加载；查询能力与覆盖以实际回执为准。'],
    examples: [{ action: 'cycles' }, { action: 'deadcode', limit: 20 }],
    schema: z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('trace'), from: ProjectCodeTargetSchema, to: ProjectCodeTargetSchema }),
      z.strictObject({ action: z.literal('cycles'), maxFiles: z.number().int().min(ProjectCodeLimits.cycleFilesMin).max(ProjectCodeLimits.cycleFiles).optional() }),
      z.strictObject({ action: z.literal('deadcode'), limit: z.number().int().positive().max(ProjectCodeLimits.deadCodeCandidates).optional() }),
      z.strictObject({ action: z.literal('routing'), framework: z.string().min(1).optional() }),
    ]),
    permissions: ['fs:read'],
    capabilities: ProjectReadCapability,
    exposure: ProjectToolExposure.codeAnalysis,
    hideWhenUnavailable: true,
    isAvailable,
    isConcurrencySafe: () => true,
    execute: (input, ctx) => projectCodeOperations.codeAnalysis(input, ctx),
  })
  return Object.freeze({ [ProjectCodeAnalysisToolName]: analysisTool })
}

// ── 执行：跑命令、演练沙箱 ─────────────────────────────────────────────────

/** project:run —— 在项目边界内运行命令。 */
const runTool = defineProjectTool<ProjectRunInput>({
  name: ProjectToolNames.run,
  category: 'project-execution',
  role: 'execute',
  summary: '在项目边界内运行可取消、可审计且支持后台任务的命令。',
  protocol: [
    '生成命令前读取宿主报告的实际 shell.kind/name。Windows 按 Git Bash、PowerShell 7、Windows PowerShell、CMD 的可用性选择，并推荐安装 Git for Windows。',
    'Git Bash/POSIX 使用 command -v、$NAME；PowerShell 使用 Get-Command、$env:NAME；CMD 使用 where、%NAME%。刷新环境后按当前 shell 重新生成命令；失败先诊断退出码和输出，避免重复执行副作用。',
  ],
  examples: [{ command: 'bun test' }],
  schema: z.strictObject({
    command: z.string().min(1),
    cwd: z.string().optional().describe('当前项目内的工作目录，可用相对路径或绝对路径；省略时使用当前项目目录。不能用它切换到项目之外。'),
    timeoutMs: z.number().int().positive().max(ProjectCommandLimits.timeoutMs).optional().describe('命令超时时间，单位毫秒。'),
    background: z.boolean().optional(),
    maxOutputChars: z.number().int().positive().max(ProjectCommandLimits.outputChars).optional().describe('stdout/stderr 返回字符上限。'),
  }),
  permissions: ['process:exec'],
  capabilities: ProjectExecutionCapability,
  exposure: ProjectToolExposure.run,
  isConcurrencySafe: (input) => isParallelCommandExecutionSafe(input),
  execute: (input, ctx) => projectExecutionOperations.run(input, ctx),
})

/** project:sandbox —— 演练沙箱：镜像项目，脚本先在镜像里跑，确认后落回。 */
const sandboxTool = defineProjectTool<ProjectSandboxInput>({
  name: ProjectToolNames.sandbox,
  category: 'project-execution',
  role: 'edit',
  summary: '演练沙箱：把项目（或其中一个目录）镜像到临时区，脚本先在镜像里跑（写不到镜像外），diff 看变了什么，确认后 apply 落回项目。',
  suitable: ['要一次改很多文件、删目录、跑迁移或批处理脚本之前，先在镜像里跑一遍看结果。', '拿不准一段脚本会不会误删误改的时候。'],
  forbidden: ['改一两个文件直接用 project:edit 或 project:file；只读命令直接用 project:run。', '不要把镜像里的结果当成已经发生：落回之前项目一个字节都没变。'],
  protocol: ['项目工具出不了项目边界：脚本先用 project:file 写进项目再 create（脚本随镜像一起进沙箱），或者用 run 直接传命令；镜像里的文件用 diff 的文本差量看，或者 run 一条 cat。'],
  usage: [
    'create 镜像整个项目或 source 指定的子目录；run 在镜像里跑命令，写到源目录会直接失败，所以脚本里算错的路径在这里只会报错。',
    'diff 看新增、修改、删除三列和文本差量；不对就改脚本再 run，镜像随便糟蹋。',
    'apply 把文件变化落回项目，会先向用户确认并列出删除与覆盖；项目里的文件在这期间被别人改过就整批不落。git 历史的变化不落回，要在项目里重放那几条 git 命令。',
    '用完 discard。gitignore 忽略的目录（node_modules 等）缺省是指向真实目录的链接，脚本能用依赖但写不进去；要在镜像里重新构建就 create 时传 ignored=copy。',
  ],
  examples: [
    { action: 'create' },
    { action: 'run', sandboxId: '20260915-183000-3fa2c1', command: 'bun scripts/migrate.ts' },
    { action: 'diff', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'apply', sandboxId: '20260915-183000-3fa2c1' },
    { action: 'discard', sandboxId: '20260915-183000-3fa2c1' },
  ],
  notes: ['镜像里的命令连不上网，除非 create 时传 network=true；镜像仓库推不出去。宿主没有进程约束后端时建不出沙箱，这个工具也不会出现。', '落回不经过 project:change 的撤销账本，要撤销用 git。'],
  schema: z.strictObject({
    action: z.enum(['create', 'run', 'diff', 'apply', 'discard']).describe('create 建沙箱；run 在镜像里跑命令；diff 看镜像相对创建时的变化；apply 把变化落回项目（会向用户确认）；discard 删掉镜像。'),
    source: z.string().min(1).optional().describe('create：要镜像的项目内目录，相对项目根；不传就是整个项目。'),
    network: z.boolean().optional().describe('create：镜像里的命令能不能联网，默认不能。'),
    ignored: z.enum(['link', 'copy', 'skip']).optional().describe('create：gitignore 忽略的目录怎么处理：link 链接到真实目录（能读不能写，默认）、copy 复制、skip 不要；忽略的文件一律不复制。'),
    sandboxId: z.string().min(1).max(ProjectSandboxLimits.idChars).optional().describe('run / diff / apply / discard：create 返回的沙箱 id。'),
    command: z.string().min(1).optional().describe('run：在镜像根里执行的 shell 命令。'),
    timeoutMs: z.number().int().positive().max(ProjectCommandLimits.timeoutMs).optional().describe('run：超时毫秒数。'),
    maxOutputChars: z.number().int().positive().max(ProjectCommandLimits.outputChars).optional().describe('run：最多返回多少字符的输出。'),
    paths: z.array(z.string().min(1)).max(ProjectSandboxLimits.applyPaths).optional().describe('apply：只落这些相对路径；不传就全部。'),
    maxFiles: z.number().int().positive().max(ProjectSandboxLimits.diffFilesMax).optional().describe(`diff：新增与修改各列最多列多少条，默认 ${ProjectSandboxLimits.diffFiles}；删除列永远完整。`),
  }),
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: ProjectExecutionCapability,
  exposure: ProjectToolExposure.sandbox,
  hideWhenUnavailable: true,
  isAvailable: (context) => !!context.project.sandbox,
  isConcurrencySafe: () => false,
  execute: (input, ctx) => projectExecutionOperations.sandbox(input, ctx),
})

// ── 工具集合：按职责类别分组 ─────────────────────────────────────────────

/** 读取类：读源码、列文件、搜源码。 */
export const projectFileTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.read]: readTool,
  [ProjectToolNames.list]: listTool,
  [ProjectToolNames.search]: searchTool,
})

/** 改动类：文件动作、源码编辑、组合变更。 */
export const projectChangeTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.file]: fileTool,
  [ProjectToolNames.edit]: editTool,
  [ProjectToolNames.change]: changeTool,
})

/** 执行类：跑命令、演练沙箱。 */
export const projectExecutionTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.run]: runTool,
  [ProjectToolNames.sandbox]: sandboxTool,
})

/** 代码理解类：project:code。 */
export const projectCodeTools: ProjectToolCollection = Object.freeze({
  [ProjectToolNames.code]: codeTool,
})

/** 项目空间的九个模型面工具，按工具名索引。 */
export const projectTools: ProjectToolCollection = Object.freeze({
  ...projectFileTools,
  [ProjectToolNames.file]: fileTool,
  [ProjectToolNames.edit]: editTool,
  ...projectCodeTools,
  [ProjectToolNames.change]: changeTool,
  ...projectExecutionTools,
})

// ── 作为官方内置 mod 挂进产品 ─────────────────────────────────────────────

const ProjectToolCategories = Object.freeze({
  'project-files': Object.freeze<ToolCategoryDefinition>({
    id: 'project-files',
    label: 'Project files',
    description: '项目边界内的读取、列举与正文搜索。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
  'project-changes': Object.freeze<ToolCategoryDefinition>({
    id: 'project-changes',
    label: 'Project changes',
    description: '项目边界内的原子编辑与回滚。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
  'project-execution': Object.freeze<ToolCategoryDefinition>({
    id: 'project-execution',
    label: 'Project execution',
    description: '项目边界内受治理的命令执行。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
  'development-code': Object.freeze<ToolCategoryDefinition>({
    id: 'development-code',
    label: 'Code intelligence',
    description: '项目内置的代码符号、引用、依赖、诊断与影响面查询。',
    toolOs: { domain: 'project', defaultState: 'resident' },
  }),
})

/**
 * 项目空间的常驻工具：读—找—改—跑这条主回路，写码会话每轮都在用。
 *
 * 语义查询和混合变更通过 tooling:map 发现并按需加载。
 */
const ProjectResidentToolNames = new Set<string>([
  ProjectToolNames.read,
  ProjectToolNames.list,
  ProjectToolNames.search,
  ProjectToolNames.edit,
  ProjectToolNames.file,
  ProjectToolNames.run,
])

/** 每个类别下的工具，mod 清单按它给每个工具标类别。 */
const ProjectCategoryTools = Object.freeze({
  'project-files': projectFileTools,
  'project-changes': projectChangeTools,
  'project-execution': projectExecutionTools,
  'development-code': projectCodeTools,
})

/** 项目空间 mod 的清单，按上游 `AgentModManifest` 契约校验。 */
const ProjectAgentModManifest = Object.freeze<AgentModManifest>({
  id: ProjectModId,
  version: ProjectPackageVersion,
  publisher: 'VelarOS',
  displayName: 'VelarOS Project',
  description: '项目空间的文件、代码理解、变更与执行职责包。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: Object.values(ProjectToolCategories).map((category, order) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      order: 30 + order,
    })),
    tools: Object.values(ProjectToolNames).map((name) => ({
      name,
      categoryId: Object.entries(ProjectCategoryTools).find(([, tools]) => Object.hasOwn(tools, name))![0],
      availableInSpaces: [ProjectSpaceId],
      residentInSpaces: optionalWhen(ProjectResidentToolNames.has(name), [ProjectSpaceId]),
    })),
    // 只声明**真被消费**的那几格（身份策略 / 绑定能力 / 职责类别）。空间的文案、图标、
    // 顺序与 surface 分档权威在产品壳的枚举表，manifest 里再写一份没有读者，只会让人
    // 改了 manifest 却什么都没变。理由与 browser mod 同一条，别再补回来。
    spaces: [{
      id: ProjectSpaceId,
      identityStrategy: 'path',
      boundCapabilityIds: [ProjectModId],
      toolCategoryIds: Object.keys(ProjectToolCategories),
    }],
  },
})

/** 创建项目空间作为官方内置 mod 的定义，产品壳的 mod 加载器按它挂载项目空间。 */
export function createProjectBundledModDefinition(): ProjectBundledModDefinition {
  return Object.freeze({
    id: ProjectModId,
    specifier: `bundled:${ProjectModId}`,
    defaultEnabled: true,
    manifest: ProjectAgentModManifest,
    bindings: Object.freeze({ tools: projectTools, toolCategories: ProjectToolCategories }),
  })
}

/** 代码图分析扩展的清单：只声明工具这一个能力轴，project:code-analysis 只在项目空间里可用。 */
const ProjectCodeAnalysisManifest = Object.freeze<AgentModManifest>({
  id: ProjectCodeAnalysisModId,
  version: ProjectPackageVersion,
  publisher: 'VelarOS',
  displayName: 'Project code analysis',
  description: '按需代码图分析扩展。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools'],
  contributes: { tools: [{ name: ProjectCodeAnalysisToolName, categoryId: 'development-code', availableInSpaces: [ProjectSpaceId] }] },
})

/** 创建可选的代码图分析扩展：只贡献 project:code-analysis，宿主给出可用性判断后单独挂载。 */
export function createProjectCodeAnalysisContribution(isAvailable: (context: ProjectToolContext) => boolean): ProjectCodeAnalysisContribution {
  return Object.freeze({
    id: ProjectCodeAnalysisModId,
    version: ProjectPackageVersion,
    manifest: ProjectCodeAnalysisManifest,
    bindings: Object.freeze({ tools: createProjectCodeAnalysisTools(isAvailable) }),
  })
}

// ── 作为能力服务挂进 VelarOS 内核 ─────────────────────────────────────────

/** 项目能力服务在内核里的身份令牌，宿主按它取到注入的项目工具集合。 */
export const ProjectCapability: CapabilityToken<ProjectCapabilityService> =
  createCapabilityToken<ProjectCapabilityService>(ProjectModId)

/** 创建项目空间的内核模块：激活时把九个工具登记成能力服务；每次调用先严格解析入参，再向宿主解析一次上下文。 */
export function createProjectKernelModule(options: CreateProjectKernelModuleOptions): KernelModuleDefinition {
  return defineKernelModule({
    manifest: {
      id: ProjectModId,
      version: ProjectPackageVersion,
      apiVersion: KernelModuleApiVersion,
      provides: [ProjectCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['fs:read', 'fs:write', 'process:exec'],
      isolation: 'in-process',
    },
    activate(context) {
      const callable = createKernelCallableCapability(createProjectCallableOperations(projectTools, options.resolveContext))
      context.registerService(ProjectCapability, Object.freeze({ ...callable, tools: Object.freeze({ ...projectTools }) }))
    },
  })
}

// ── 项目空间：内核加工具 ───────────────────────────────────────────────────

/** 创建一个项目空间：按选项建项目内核（锚定在 root），配上九个工具。 */
export async function createProjectSpace(options: CreateProjectKernelOptions): Promise<ProjectSpace> {
  const kernel = await createProjectKernel(options)
  return Object.freeze({ id: ProjectSpaceId, kernel, tools: projectTools })
}
