/**
 * 门在模型面上的那一个工具：`program:run`，以及把它挂进 VelarOS 内核的模块。
 *
 * 模型交一段程序就用它，别的能力都在程序里 import——provider 那层协议去不掉，但只剩这一个工具。
 * 规矩与常驻模块的完整声明太长，不放工具说明里（说明有长度上限，也不该按空间变），宿主放进系统提示词最前面那段；
 * 这里的说明只讲入参怎么填。回执写成 agent 原样转给模型的内容块（见 `programToolResult`）。
 */

import { z } from 'zod'

import type { KernelModuleDefinition } from '@velaros-ai/kernel'
import { kernelModules } from '@velaros-ai/kernel'
import type { CapabilityToken } from '@velaros-ai/kernel/contracts'
import { toolDescriptions, toolKernelModules } from '@velaros-ai/tool-contract'

import { CodeSurfaceKernelModuleVersion, CodeSurfaceLimits, CodeSurfaceModId, CodeSurfaceToolNames } from '../contract/constants.js'
import type { CodeSurfaceCapabilityService, CodeSurfaceToolCollection } from '../contract/provides.js'
import type { CodeSurfaceToolContext, CreateCodeSurfaceKernelModuleOptions } from '../contract/requires.js'
import type { RunProgramInput } from '../types/gate.js'
import { programRequestOf, programToolResult } from '../utils/gate.js'
import { defineCodeSurfaceTool } from '../utils/tool.js'

// ── 入参 ──────────────────────────────────────────────────────

/** 在上一份程序上改的一处：oldText 定位、newText 换上；range 只用来把查找收窄。 */
const programEditSchema = z.object({
  oldText: z.string().optional().describe('要换掉的原文：和上一份程序里的一模一样（含缩进与换行），在程序里唯一'),
  newText: z.string().describe('换成什么；空串就是删掉那一段'),
  range: z.object({
    offset: z.number().int().min(0).describe('起点，从 0 起的字符偏移'),
    end: z.number().int().min(0).describe('终点，右开'),
  }).strict().optional().describe('可选：把查找收窄到这一段字符'),
}).strict()

const runProgramSchema = z.object({
  program: z.string().min(1).max(CodeSurfaceLimits.sourceChars).optional().describe('程序正文，一个 JavaScript ES 模块；与 edits 只给一个'),
  edits: z.array(programEditSchema).min(1).optional().describe('在这个会话的上一份程序上改的几处；与 program 只给一个'),
  blobs: z.record(z.string(), z.string()).optional().describe('大段文本，程序里 import { blobs } from \'velar:program\' 按名字取'),
}).strict()

// ── 工具：交一段程序 ──────────────────────────────────────────

const runProgram = defineCodeSurfaceTool<RunProgramInput>({
  name: CodeSurfaceToolNames.runProgram,
  role: 'execute',
  summary: '交一段 JavaScript 程序，在程序里 import 能力模块（velar:*）把事情一次办完。',
  suitable: ['读写文件、跑命令、查代码、看图——这个空间的能力都在程序里调，没有别的工具。'],
  protocol: [
    '程序是 ES 模块：import 能力模块、顶层直接 await、export default 交出答案；有哪些模块、每个怎么调，见系统提示词里门的说明与声明。',
    'program 与 edits 只给一个：改上一份程序传 edits（oldText 照原文一字不差、在程序里唯一，newText 写新的），不用整份重发。',
  ],
  usage: ['大段文本（文件正文、补丁）放进 blobs，程序里按名字取，不要写进源码。'],
  examples: [{ program: "import { read } from 'velar:project'\nconst { files: [file] } = await read({ files: [{ path: 'package.json' }] })\nexport default file.lines.slice(0, 20)" }],
  notes: ['只有 export default 的值回到你这里；typecheck 没过或者头一次 import 按需模块时，程序一行都不执行，回的是诊断或那个模块的完整声明。'],
  schema: runProgramSchema,
  permissions: ['fs:read', 'fs:write', 'process:exec'],
  capabilities: {
    effectKind: 'execute',
    concurrency: 'unsafe',
    canReadArbitrarySource: true,
    reason: '程序经能力模块读写文件、跑命令；审批与危险判定在每一次能力调用里撞',
  },
  exposure: { tier: 'essential', alwaysResident: true },
  outputInline: true,
  // 门在检查之前就记下了这份程序（后面的 edits 在它上面改），同一个会话里两段程序不能并着跑。
  isConcurrencySafe: () => false,
  execute: async (input, ctx: CodeSurfaceToolContext) => programToolResult(
    await ctx.gate.run({ sessionId: ctx.sessionId, program: programRequestOf(input), modules: ctx.space.modules, capabilities: ctx.space.capabilities, signal: ctx.abortSignal, events: ctx.events }),
    ctx.getSupportedModelInputModalities?.().includes('image') ?? true,
  ),
})

// ── 工具集合 ──────────────────────────────────────────────────

/** 门在模型面上的工具，按工具名索引。 */
export const codeSurfaceTools: CodeSurfaceToolCollection = toolDescriptions.forCategory(
  { [CodeSurfaceToolNames.runProgram]: runProgram },
  'program',
) as CodeSurfaceToolCollection

// ── 作为能力服务挂进 VelarOS 内核 ─────────────────────────────

/** 门的能力服务在内核里的身份令牌，宿主按它取到注入的工具集合。 */
export const CodeSurfaceCapability: CapabilityToken<CodeSurfaceCapabilityService> =
  kernelModules.token<CodeSurfaceCapabilityService>(CodeSurfaceModId)

/** 创建门的内核模块：激活时把 `program:run` 登记成能力服务；宿主给了上下文解析器，它才能被按名调用。 */
export function createCodeSurfaceKernelModule(options: CreateCodeSurfaceKernelModuleOptions = {}): KernelModuleDefinition {
  return toolKernelModules.define<CodeSurfaceToolContext, CodeSurfaceCapabilityService>({
    id: CodeSurfaceModId,
    version: CodeSurfaceKernelModuleVersion,
    permissions: ['fs:read', 'fs:write', 'process:exec'],
    token: CodeSurfaceCapability,
    tools: codeSurfaceTools,
    resolveContext: options.resolveContext,
    label: '程序',
  })
}
