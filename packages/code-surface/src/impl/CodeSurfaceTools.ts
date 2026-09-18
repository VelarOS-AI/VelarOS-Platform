/**
 * 门在模型面上的四个工具，以及把它们挂进 VelarOS 内核的模块。
 *
 * `script:exec` 跑脚本、存脚本、重放：一次给几步，按顺序做；`script:history`、`script:show`、`script:diff` 只读时间线。
 * 别的能力都在脚本里 import——provider 那层协议去不掉，但只剩这四个工具。
 * 写脚本的规矩与常驻模块的完整声明太长，不放工具说明里（说明有长度上限，也不该按空间变），宿主放进系统提示词最前面那段；
 * 这里的说明只讲入参怎么填。回执写成 agent 原样转给模型的内容块（见 `scriptToolResult`）。
 */

import { z } from 'zod'

import { toolDescriptions, toolKernelModules } from '@velaros-ai/agent/tool-contract'
import type { KernelModuleDefinition } from '@velaros-ai/kernel'
import { kernelModules } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'

import { CodeSurfaceKernelModuleVersion, CodeSurfaceLimits, CodeSurfaceModId, CodeSurfaceToolCategoryId, CodeSurfaceToolNames, ScriptDiffKinds, ScriptStepOps } from '../contract/constants.js'
import type { CodeSurfaceCapabilityService, CodeSurfaceToolCollection } from '../contract/provides.js'
import type { CodeSurfaceToolContext, CreateCodeSurfaceKernelModuleOptions } from '../contract/requires.js'
import type { ScriptDiffInput, ScriptExecInput, ScriptHistoryInput, ScriptShowInput } from '../types/gate.js'
import { acceptsImages, scriptToolResult, textToolResult } from '../utils/gate.js'
import { defineCodeSurfaceTool } from '../utils/tool.js'

// ── 入参 ──────────────────────────────────────────────────────

/** 在底稿上改的一处：oldText 照原文一字不差、在底稿里唯一，换成 newText。 */
const editSchema = z.object({
  oldText: z.string().min(1).describe('要换掉的原文：和底稿里的一模一样（含缩进与换行），在底稿里唯一；不唯一就多带几行上下文'),
  newText: z.string().describe('换成什么；空串就是删掉那一段'),
}).strict()

/** exec 的一步：哪几个字段有用看 op。 */
const stepSchema = z.object({
  op: z.enum(ScriptStepOps).describe('这一步做什么：run 跑代码、write 存脚本、edit 改脚本、restore 退回旧版、remove 从库里拿掉、replay 按记录重跑'),
  program: z.string().min(1).max(CodeSurfaceLimits.sourceChars).optional().describe('代码正文，一个 JavaScript ES 模块（run、write）'),
  from: z.string().min(1).optional().describe('已有的代码：lib/x.js（最新版）、lib/x.js@3，或者之前的一步 C3.2（run、edit）；replay 一段时是从哪次调用起，如 C1'),
  to: z.string().min(1).optional().describe('replay 一段时到哪次调用止，如 C4；不给是到最近一次'),
  edits: z.array(editSchema).min(1).optional().describe('在 from 那份代码上改的几处（run、edit）'),
  path: z.string().min(1).max(CodeSurfaceLimits.scriptPathChars).optional().describe('脚本库里的路径，如 lib/changelog.js（write、edit、restore、remove）'),
  version: z.number().int().min(1).optional().describe('退回到第几版（restore）'),
  step: z.string().min(1).optional().describe('重放哪一步，如 C3.2（replay）'),
  input: z.unknown().optional().describe('参数，任意 JSON 值（run）：脚本里 import { input } from \'velar:program\' 取'),
  blobs: z.record(z.string(), z.string()).optional().describe('大段文本（run）：脚本里 import { blobs } from \'velar:program\' 按名字取'),
}).strict()

const execSchema = z.object({
  steps: z.array(stepSchema).min(1).max(CodeSurfaceLimits.steps).describe(`各步，按顺序做，某一步没成就停；一次最多 ${CodeSurfaceLimits.steps} 步`),
}).strict()

const historySchema = z.object({
  script: z.string().min(1).optional().describe('只看写过、改过、跑过这个脚本的步骤，如 lib/changelog.js'),
  file: z.string().min(1).optional().describe('只看改过这个文件的步骤与外部改动（相对工作区根目录）'),
  from: z.string().min(1).optional().describe('从哪次调用起，如 C1'),
  to: z.string().min(1).optional().describe('到哪次调用止，如 C4'),
  limit: z.number().int().min(1).max(CodeSurfaceLimits.historyEntries).optional().describe(`最多列几条，不给是 ${CodeSurfaceLimits.historyDefaultEntries}`),
}).strict()

const showSchema = z.object({
  ref: z.string().min(1).optional().describe('看什么：调用 C3、步骤 C3.2、脚本 lib/x.js 或 lib/x.js@3；不给就是脚本库目录'),
  blob: z.string().min(1).optional().describe('ref 是步骤时，只看它 blobs 里的这一段'),
}).strict()

const diffSchema = z.object({
  from: z.string().min(1).describe('旧的那一边：代码（lib/x.js@2、C3.2）或时间点（C3、C3.2、now）'),
  to: z.string().min(1).optional().describe('新的那一边；不给时代码比这个脚本的最新版，时间点比现在'),
  of: z.enum(ScriptDiffKinds).optional().describe('比代码（code）还是比文件（files）；不给时调用号与 now 比文件，其余比代码'),
}).strict()

// ── 工具：跑脚本、存脚本、重放 ─────────────────────────────────

const exec = defineCodeSurfaceTool<ScriptExecInput>({
  name: CodeSurfaceToolNames.exec,
  role: 'execute',
  summary: '跑脚本、存脚本：steps 按顺序做，某一步没成就停，后面的不做。',
  suitable: ['这个空间里的事都写成脚本做：import 能力模块、调它们的方法；要反复用的存进脚本库。'],
  protocol: [
    'run 跑一段代码：program 给正文，或者 from 给已有的代码（lib/x.js 最新版、lib/x.js@3、之前的一步 C3.2——沿用它当时的 input 与 blobs，给了新的就用新的），带 edits 就先在它上面改几处再跑。',
    'write 把 program 存成脚本库里 path 的新版本；edit 在 from（不给就是 path 的最新版）上改几处，存成 path 的新版本；restore 把 path 的第 version 版存成最新版——这三种都先过类型检查，不跑。remove 把 path 从库里拿掉，各版本还在，restore 能找回来。',
    'replay 按记录重跑：step 填一步（C3.2），或者 from、to 填一段调用号（C1 到 C4，to 不给是到最近一次），按先后重跑那一段里跑成了、改过文件的每一步，改动已经在了的跳过。同一份代码、同一组参数、当时的库版本；跑前核对它改过的文件还是当时改前的样子，跑完核对改出来的和当时一样，对不上就停。',
  ],
  usage: ['edits 每处 oldText 照原文一字不差、在代码里唯一，newText 写新的；诊断里框出来的那段原文可以直接当 oldText。'],
  examples: [{ steps: [
    { op: 'write', path: 'lib/todo.js', program: "import { run } from 'velar:shell'\nexport async function todos(dir) {\n  const { stdout } = await run({ command: 'grep -rn TODO ' + dir })\n  return stdout.split('\\n').filter(Boolean)\n}" },
    { op: 'run', program: "import { input } from 'velar:program'\nimport { todos } from './lib/todo.js'\nexport default (await todos(input.dir)).length", input: { dir: 'src' } },
  ] }],
  notes: ['回执按步骤分段，每段开头是步骤号（C4.2）；项目空间里还写着这一步改了哪些文件。'],
  schema: execSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: {
    effectKind: 'execute',
    concurrency: 'unsafe',
    canReadArbitrarySource: true,
    reason: '脚本经能力模块读写文件、跑命令；危险判定在每一次能力调用里撞',
  },
  exposure: { tier: 'essential', alwaysResident: true },
  outputInline: true,
  // 同一条时间线上的 exec 本来就排队做；同一个会话里并着交也没有意义。
  isConcurrencySafe: () => false,
  execute: async (input, ctx: CodeSurfaceToolContext) => scriptToolResult(
    await ctx.gate.exec({ sessionId: ctx.sessionId, steps: input.steps, space: ctx.space, signal: ctx.abortSignal, events: ctx.events }),
    acceptsImages(ctx),
  ),
})

// ── 工具：读时间线 ────────────────────────────────────────────

const history = defineCodeSurfaceTool<ScriptHistoryInput>({
  name: CodeSurfaceToolNames.history,
  role: 'read',
  summary: '列时间线：每次调用、每一步做了什么（代码从哪来、参数、成没成、改了哪些文件），最新的在后面。',
  suitable: ['复盘做过什么、找要复用或重放的步骤号、看某个文件被哪几步改过。'],
  usage: [`都不给就列最近 ${CodeSurfaceLimits.historyDefaultEntries} 条；script 只看写过、改过、跑过这个脚本的，file 只看改过这个文件的，from、to 按调用号圈一段（C1 到 C4）。`],
  examples: [{ file: 'src/index.ts' }],
  schema: historySchema,
  permissions: ['fs:read'],
  capabilities: { effectKind: 'read', concurrency: 'safe', reason: '只读这个空间的时间线' },
  exposure: { tier: 'essential', alwaysResident: true },
  outputInline: true,
  isConcurrencySafe: () => true,
  execute: async (input, ctx: CodeSurfaceToolContext) => textToolResult(await ctx.gate.history({ sessionId: ctx.sessionId, timeline: ctx.space.timeline, query: input, signal: ctx.abortSignal })),
})

const show = defineCodeSurfaceTool<ScriptShowInput>({
  name: CodeSurfaceToolNames.show,
  role: 'read',
  summary: '看时间线上的一样东西：一次调用、一步、一版脚本；不给 ref 是脚本库目录。',
  suitable: ['看一步的代码、参数、结果、改了哪些文件，看一版脚本的正文，看脚本库里有什么。'],
  usage: ['步骤给出代码、input、blobs 的名字与大小、结果、调过的能力（带 changeRef 的可以拿去 velar:project 的 undo 撤那次改动）、改了哪些文件（前后哈希）；blob 填名字就只看那一段。'],
  examples: [{ ref: 'C3.2' }],
  schema: showSchema,
  permissions: ['fs:read'],
  capabilities: { effectKind: 'read', concurrency: 'safe', reason: '只读这个空间的时间线' },
  exposure: { tier: 'essential', alwaysResident: true },
  outputInline: true,
  isConcurrencySafe: () => true,
  execute: async (input, ctx: CodeSurfaceToolContext) => textToolResult(await ctx.gate.show({ sessionId: ctx.sessionId, timeline: ctx.space.timeline, query: input, signal: ctx.abortSignal })),
})

const diff = defineCodeSurfaceTool<ScriptDiffInput>({
  name: CodeSurfaceToolNames.diff,
  role: 'read',
  summary: '比两样东西：两版代码逐行比，两个时间点之间的工作区按文件比。',
  suitable: ['看一个脚本两版之间改了什么；撤回或重放之后，核对工作区到没到某个时间点。'],
  usage: [
    '比代码：from、to 填 lib/x.js@2、lib/x.js（最新版）或步骤号 C3.2；to 不给时比 from 这个脚本的最新版。',
    '比文件：填调用号 C3（那次调用做完时）、now，或者步骤号加 of: "files"（那一步做完时）；to 不给就是 now。只比到文件：新增、删除、改了，前后哈希。',
  ],
  examples: [{ from: 'C3', to: 'now' }],
  schema: diffSchema,
  permissions: ['fs:read'],
  capabilities: { effectKind: 'read', concurrency: 'safe', reason: '只读这个空间的时间线，比文件时扫一遍工作区算哈希' },
  exposure: { tier: 'essential', alwaysResident: true },
  outputInline: true,
  isConcurrencySafe: () => true,
  execute: async (input, ctx: CodeSurfaceToolContext) => textToolResult(await ctx.gate.diff({ sessionId: ctx.sessionId, timeline: ctx.space.timeline, query: input, signal: ctx.abortSignal })),
})

// ── 工具集合 ──────────────────────────────────────────────────

/** 门在模型面上的工具，按工具名索引。 */
export const codeSurfaceTools: CodeSurfaceToolCollection = toolDescriptions.forCategory(
  {
    [CodeSurfaceToolNames.exec]: exec,
    [CodeSurfaceToolNames.history]: history,
    [CodeSurfaceToolNames.show]: show,
    [CodeSurfaceToolNames.diff]: diff,
  },
  CodeSurfaceToolCategoryId,
) as CodeSurfaceToolCollection

// ── 作为能力服务挂进 VelarOS 内核 ─────────────────────────────

/** 门的能力服务在内核里的身份令牌，宿主按它取到注入的工具集合。 */
export const CodeSurfaceCapability: CapabilityToken<CodeSurfaceCapabilityService> =
  kernelModules.token<CodeSurfaceCapabilityService>(CodeSurfaceModId)

/** 创建门的内核模块：激活时把四个工具登记成能力服务；宿主给了上下文解析器，它们才能被按名调用。 */
export function createCodeSurfaceKernelModule(options: CreateCodeSurfaceKernelModuleOptions = {}): KernelModuleDefinition {
  return toolKernelModules.define<CodeSurfaceToolContext, CodeSurfaceCapabilityService>({
    id: CodeSurfaceModId,
    version: CodeSurfaceKernelModuleVersion,
    permissions: ['fs:read', 'fs:write', 'process:exec'],
    token: CodeSurfaceCapability,
    tools: codeSurfaceTools,
    resolveContext: options.resolveContext,
    label: '脚本',
  })
}
