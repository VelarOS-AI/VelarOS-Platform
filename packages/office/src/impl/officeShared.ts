/**
 * 办公文档工具集的共享上下文面：宿主端口类型、工具定义器、能力元数据，以及所有需要 ctx 的操作
 * （授权、写盘、跑外部命令、归一化旧版 .doc）。纯函数已经搬进 utils，这里只剩要跟宿主打交道的那一层。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { z } from 'zod'

import type {
  ToolCapabilitySchema,
} from '@velaros-ai/agent/protocol'
import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { AppError } from '@velaros-ai/core/error'

import { OfficeInputLimits, OfficeToolCategoryId } from '../contract/constants.js'
import type {
  NormalizedWordInput,
  NormalizeWordInputResult,
  OfficeEnvironmentCommandAvailability,
  OfficeEnvironmentInspection,
  OfficeNativeCommand,
  OfficeProjectAuthorizationDecision,
  OfficeProjectMutationAuthorizationInput,
  OfficeSystemCommandResult,
  OfficeSystemToolInstallAlternative,
  OfficeSystemToolInstallSuggestion,
} from '../types/office.js'
import { describeOfficeNativeCommand, libreOfficeCommandCandidates } from '../utils/commands.js'
import {
  findGeneratedOfficeFile,
  isOfficePathInsideProject,
  prepareOfficeOutputPath as prepareOutputPath,
  resolveInputPathWithExtensions,
} from '../utils/paths.js'
import { OfficeTuning } from '../utils/tuning.js'
import { buildMacLibreOfficeFontConfig } from '../utils/word/fonts.js'

export type OfficeToolPermission =
  | 'fs:read'
  | 'fs:write'
  | 'process:exec'
  | 'process:exec:unsafe'
  | 'system:open'
  | 'system:app'
  | 'project:root'
  | 'screen:capture'
  | 'window:track'
  | 'input:control'
  | 'network'
  | 'memory:read'
  | 'memory:write'

// Office 仅声明自己消费的结构端口；宿主可用 Project 决策实现该端口，但 Office 不依赖其包。
export interface OfficeProjectApi {
  getRootPath: () => string
  runInDirectory: <T>(cwd: string, action: () => Promise<T>) => Promise<T>
  prepareMutation: (
    input: OfficeProjectMutationAuthorizationInput
  ) => Promise<OfficeProjectAuthorizationDecision>
}

export interface OfficeSystemApi {
  inspectEnvironment: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
  createSystemToolInstallSuggestion: (input: {
    command: string
    reason: string
    scope: 'project' | 'system'
  }) => Nullable<OfficeSystemToolInstallSuggestion>
  runCommand: (
    command: string,
    options?: {
      cwd?: string
      timeoutMs?: number
      maxOutputChars?: number
      nativeCommand?: OfficeNativeCommand
    },
    allowDangerous?: boolean
  ) => Promise<OfficeSystemCommandResult>
}

/** Office 工具唯一消费的宿主能力；Project 与 System 只以窄端口组合进来。 */
export interface OfficeHostApi {
  hasProjectRoot: () => boolean
  project: OfficeProjectApi
  system: OfficeSystemApi
}

export interface OfficeToolContext {
  abortSignal: AbortSignal
  office: OfficeHostApi
}

export type VelaTool<TInput extends Record<string, unknown> = Record<string, unknown>> =
  ToolContractRuntimeSpec<TInput, OfficeToolContext, unknown, OfficeToolPermission>

type DefineOfficeToolInput<TInput extends Record<string, unknown>> = Omit<
  DefineToolRuntimeSpecInput<TInput, OfficeToolContext, unknown, OfficeToolPermission>,
  'category'
>

export function defineOfficeTool<TInput extends Record<string, unknown>>(
  input: DefineOfficeToolInput<TInput>
): VelaTool<TInput> {
  return defineToolRuntimeSpec({ ...input, category: OfficeToolCategoryId })
}

export type OfficeToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

export const OfficeDocumentReadCapability = {
  effectKind: 'read',
  readScopes: ['project', 'system'],
  filesystem: { read: 'project', write: 'none' },
  canReadArbitrarySource: false,
  metadata: {
    project: {
      requiresActiveProject: true,
      requiresProjectSwitchForExternalCwd: true,
      arbitraryRead: true,
    },
    canMutateProject: false,
  },
  concurrency: 'safe',
  reason: 'office document inspection',
} satisfies OfficeToolCapabilitySchema

export const OfficeDocumentWriteCapability = {
  effectKind: 'write',
  readScopes: ['project', 'system'],
  writeScopes: ['project'],
  filesystem: { read: 'project', write: 'project' },
  metadata: {
    project: {
      requiresActiveProject: true,
      requiresProjectSwitchForExternalCwd: true,
      mutation: 'non-transactional',
      arbitraryRead: true,
    },
    canMutateProject: true,
  },
  concurrency: 'unsafe',
  reason: 'office document creation or conversion',
} satisfies OfficeToolCapabilitySchema

export const OfficeDocumentProcessCapability = {
  ...OfficeDocumentWriteCapability,
  process: { execution: 'input-dependent' },
  reason: 'office document conversion with local process execution',
} satisfies OfficeToolCapabilitySchema

/** Office 工具使用的上下文别名。 */
export type ToolContext = OfficeToolContext

// ─── Shared Zod schema helpers ─────────────────────────────────────────────────

/** Office 输出路径 schema；具体工具会再按扩展名校验。 */
export const outputPathSchema = z
  .string()
  .min(1)
  .max(OfficeInputLimits.pathChars)
  .describe(
    parameterDescription({
      description: '输出文件路径。',
      usage: ['支持相对当前工作区的路径。'],
      notes: ['无扩展名时会按工具类型自动补齐。'],
    })
  )

// ─── Path & project helpers ──────────────────────────────────────────────────

/**
 * Office 工具必须有可解析的执行根，因为产物只能写入根内。
 * 能力范围由 toolSpacePolicy 限制在日常工作区；这里继续按执行根判断，允许日常会话
 * 使用自己的 scratch 根，同时防止没有任何可用根时进入具体工具实现。
 */
export function toolRequiresProject(ctx: ToolContext): boolean {
  try {
    return !!ctx.office.project.getRootPath()
  } catch {
    // arch-guard:silent-catch-ok 无任何可用根（未激活工作区）时执行根解析会抛错，等价于"工具不可用"，不是故障。
    return false
  }
}

/**
 * 在可选 cwd 下执行 Office 操作。
 *
 * 判据（§5.3b ④安全门）：`cwd` 不是「顺便换个目录」，宿主实现会把它当成**新的执行根**
 * （Desktop 的 `runInDirectory` 走 root override），下面所有路径包含判断随之以它为准。
 * 所以进宿主之前先按真实路径确认它仍在当前工作区内：只读工具从不请求授权，不挡这一下，
 * 一个根外的 `cwd` 就能让 `extract_pdf_text` / `preview_document` /
 * `convert_document_to_markdown` 读到工作区外的文件（2026-09-16 实测）。
 * 写工具的 `prepareMutation` 在这之前跑，宿主批准的「切换到外部目录」会先把根换过去，
 * 那时 `cwd` 自然落在新根内，合法流程不受影响。
 */
export async function runWithDirectory<T>(
  ctx: OfficeToolContext,
  cwd: LooseOptional<string>,
  action: () => Promise<T>
): Promise<T> {
  if (!cwd) return action()
  if (!(await isOfficePathInsideProject(ctx.office.project.getRootPath(), resolve(cwd))))
    throw new AppError(
      'PERMISSION',
      `工作目录超出工作区范围：${cwd}。去掉 cwd 让工具在当前工作区内执行，或先切换到该目录所属的工作区。`
    )
  // project 层负责临时切换目录并恢复。
  return ctx.office.project.runInDirectory(cwd, action)
}

/** 准备 Office 输出路径：校验扩展名、覆盖策略并创建父目录。 */
export async function prepareOfficeOutputPath(
  ctx: OfficeToolContext,
  outputPath: string,
  extension: string,
  overwrite?: boolean
): Promise<{ path: string; created: boolean }> {
  return prepareOutputPath(ctx.office.project.getRootPath(), outputPath, extension, overwrite)
}

/** 解析 Office 输入路径并限制允许扩展名。 */
export async function resolveOfficeInputPathWithExtensions(
  ctx: OfficeToolContext,
  inputPath: string,
  extensions: readonly string[]
): Promise<string> {
  return resolveInputPathWithExtensions(ctx.office.project.getRootPath(), inputPath, extensions)
}

/** 解析只允许单一扩展名的 Office 输入文件。 */
export async function resolveOfficeInputPath(
  ctx: OfficeToolContext,
  inputPath: string,
  extension: string
): Promise<string> {
  return resolveOfficeInputPathWithExtensions(ctx, inputPath, [extension])
}

// ─── System command helpers ────────────────────────────────────────────────────

/** 按顺序查找第一个可用系统命令。 */
export async function findAvailableCommand(
  ctx: OfficeToolContext,
  commands: string[]
): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  const inspection = await ctx.office.system.inspectEnvironment(commands)
  const byName = new Map(inspection.commands.map((command) => [command.name, command]))

  // 保持传入 commands 的优先级顺序，例如优先 libreoffice 再 soffice。
  for (const commandName of commands) {
    const command = byName.get(commandName)
    if (command?.available) return command
  }

  return null
}

/** 构建缺失系统工具的跳过结果，并附带可安装建议。 */
export function buildMissingSystemToolResult(input: {
  ctx: OfficeToolContext
  command: string
  reason: string
  message: string
  alternatives?: OfficeSystemToolInstallAlternative[]
}): {
  changed: false
  skipped: true
  missingCommand: string
  message: string
  systemToolSuggestion: Nullable<OfficeSystemToolInstallSuggestion>
} {
  // 安装建议由 system 层根据平台和 scope 生成。
  const suggestion = input.ctx.office.system.createSystemToolInstallSuggestion({
    command: input.command,
    reason: input.reason,
    scope: input.ctx.office.hasProjectRoot() ? 'project' : 'system',
  })

  return {
    changed: false,
    skipped: true,
    missingCommand: input.command,
    message: input.message,
    systemToolSuggestion: suggestion ? { ...suggestion, alternatives: input.alternatives } : null,
  }
}

/** 运行 Office 相关外部系统命令；只经原生 argv 交给宿主。 */
export async function runOfficeSystemCommand(
  ctx: OfficeToolContext,
  command: OfficeNativeCommand,
  cwd: string,
  timeoutMs: number = OfficeTuning.command.timeoutMs
): Promise<OfficeSystemCommandResult> {
  // Office 转换/编译通常输出较多，因此放宽 maxOutputChars。
  return ctx.office.system.runCommand(
    describeOfficeNativeCommand(command),
    { cwd, timeoutMs, maxOutputChars: OfficeTuning.command.outputChars, nativeCommand: command },
    false
  )
}

/**
 * 在 macOS 上给 LibreOffice 配一份真实可写的 Fontconfig 缓存再跑。
 * 可重定位/headless 的 LibreOffice 包否则会把占位缓存目录当字面路径解析，把中日韩文本换成不相干的字体。
 */
export async function runLibreOfficeSystemCommand(
  ctx: OfficeToolContext,
  command: OfficeNativeCommand,
  cwd: string,
  timeoutMs: number = OfficeTuning.command.libreOfficeTimeoutMs
): Promise<OfficeSystemCommandResult> {
  if (process.platform !== 'darwin') return runOfficeSystemCommand(ctx, command, cwd, timeoutMs)
  const runtimeDir = await mkdtemp(join(tmpdir(), 'velaros-office-fontconfig-'))
  const cacheDir = join(runtimeDir, 'cache')
  const configPath = join(runtimeDir, 'fonts.conf')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(configPath, buildMacLibreOfficeFontConfig({
    homeDir: homedir(),
    cacheDir,
  }), 'utf8')
  const configuredCommand: OfficeNativeCommand = {
    ...command,
    env: { ...command.env, FONTCONFIG_FILE: configPath },
  }
  try {
    return await runOfficeSystemCommand(ctx, configuredCommand, cwd, timeoutMs)
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 临时字体缓存尽力清理 */)
  }
}

// 依次查找常见 LibreOffice 命令名和 macOS App 内的 soffice 可执行文件。
export async function resolveLibreOfficeCommand(
  ctx: OfficeToolContext
): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  return findAvailableCommand(ctx, libreOfficeCommandCandidates())
}

/** 将旧版 .doc 输入归一化成临时 .docx，便于后续工具只处理 OOXML。 */
export async function normalizeWordInputToDocx(input: {
  ctx: OfficeToolContext
  inputPath: string
  libreOffice: OfficeEnvironmentCommandAvailability
  timeoutMs?: number
}): Promise<NormalizeWordInputResult> {
  const sourceExtension = extname(input.inputPath).toLowerCase()
  if (sourceExtension === '.docx') return {
      success: true,
      input: {
        path: input.inputPath,
        originalPath: input.inputPath,
        sourceExtension,
        convertedFromLegacyDoc: false,
        tempDir: null,
      },
    }

  if (sourceExtension !== '.doc') {
    throw new AppError('VALIDATION', 'Word 输入文件扩展名必须是 .docx 或 .doc。')
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'velaros-office-docx-normalize-'))
  const command: OfficeNativeCommand = {
    file: input.libreOffice.path || input.libreOffice.name,
    args: ['--headless', '--convert-to', 'docx', '--outdir', tempDir, input.inputPath],
  }
  const commandResult = await runLibreOfficeSystemCommand(
    input.ctx,
    command,
    dirname(input.inputPath),
    input.timeoutMs ?? OfficeTuning.command.libreOfficeTimeoutMs
  )
  if (!commandResult.success) return {
      success: false,
      originalPath: input.inputPath,
      tempDir,
      commandResult,
    }

  const generatedDocx = await findGeneratedOfficeFile(
    tempDir,
    `${basename(input.inputPath, extname(input.inputPath))}.docx`,
    '.docx'
  )
  if (!generatedDocx) {
    // 抛出去就没人认领这个临时目录了（调用方只在 success=false 的结构化返回里收拾），
    // 于是每失败一次就在系统临时目录留一个 velaros-office-docx-normalize-*。
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
    throw new AppError('EXECUTION_FAILED', 'DOC 转 DOCX 命令已结束，但没有生成 DOCX 文件。')
  }

  return {
    success: true,
    input: {
      path: generatedDocx,
      originalPath: input.inputPath,
      sourceExtension,
      convertedFromLegacyDoc: true,
      tempDir,
      converter: input.libreOffice.name,
      conversionCommandResult: commandResult,
    },
  }
}

/** 清理 normalizeWordInputToDocx 为旧版 .doc 创建的临时目录。 */
export async function cleanupNormalizedWordInput(input: NormalizedWordInput): Promise<void> {
  if (!input.tempDir) return
  await rm(input.tempDir, { recursive: true, force: true }).catch(() => undefined /* arch-guard:silent-catch-ok 尽力清理临时目录，删除失败非致命 */)
}
