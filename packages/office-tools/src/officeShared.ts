/**
 * 办公文档工具集的共享类型、基础 schema 和文件系统辅助函数。
 * 所有办公文档子模块均依赖此模块；本模块不依赖任何具体子模块。
 *
 * 分层：ToolTypes → officeShared → {wordTool, presentationTool, spreadsheetTool, pdfTools}
 */

import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

import { z } from 'zod'

import { isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import {
  defineToolRuntimeSpec,
  type DefineToolRuntimeSpecInput,
  type ToolContractRuntimeSpec,
} from '@velaros-ai/core/tool-contract'
import type {
  ToolCapabilitySchema,
} from '@velaros-ai/core/types'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import type {
  OfficeEnvironmentCommandAvailability,
  OfficeEnvironmentInspection,
  OfficeSystemCommandResult,
  OfficeSystemToolInstallAlternative,
  OfficeSystemToolInstallSuggestion,
  OfficeWorkspaceAuthorizationDecision,
  OfficeWorkspaceMutationAuthorizationInput,
} from './OfficeContracts'
import {
  getRelativePathInsideOfficeRoot,
  officePlatformCompatibility,
} from './OfficePlatformCompatibility'

// 集中再导出常用依赖，减少子模块重复导入。
export { AppError }
export { copyFile, mkdir, mkdtemp, readdir, rm, writeFile }
export { tmpdir }
export { basename, dirname, extname, isAbsolute, join, resolve, sep }
export { z }

export type OfficeToolPermission =
  | 'fs:read'
  | 'fs:write'
  | 'process:exec'
  | 'process:exec:unsafe'
  | 'system:open'
  | 'system:app'
  | 'workspace:root'
  | 'screen:capture'
  | 'window:track'
  | 'input:control'
  | 'network'
  | 'memory:read'
  | 'memory:write'

// Office 仅声明自己消费的结构端口；宿主可用 Workspace 决策实现该端口，但 Office 不依赖其包。
export interface OfficeWorkspaceApi {
  getRootPath: () => string
  runInDirectory: <T>(cwd: string, action: () => Promise<T>) => Promise<T>
  prepareMutationWorkspace: (
    input: OfficeWorkspaceMutationAuthorizationInput
  ) => Promise<OfficeWorkspaceAuthorizationDecision>
}

export interface OfficeSystemApi {
  inspectEnvironment: (commands?: string[]) => Promise<OfficeEnvironmentInspection>
  createSystemToolInstallSuggestion: (input: {
    command: string
    reason: string
    scope: 'workspace' | 'system'
  }) => Nullable<OfficeSystemToolInstallSuggestion>
  runCommand: (
    command: string,
    options?: {
      cwd?: string
      timeoutMs?: number
      maxOutputChars?: number
    },
    allowDangerous?: boolean
  ) => Promise<OfficeSystemCommandResult>
}

export interface OfficeToolContext {
  abortSignal: AbortSignal
  hasWorkspaceRoot: () => boolean
  workspace: OfficeWorkspaceApi
  system: OfficeSystemApi
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
  return defineToolRuntimeSpec({ ...input, category: 'office' })
}

export type OfficeToolCapabilitySchema = ToolCapabilitySchema & {
  metadata: Readonly<Record<string, unknown>>
}

export const OfficeDocumentWriteCapability = {
  effectKind: 'write',
  readScopes: ['workspace', 'system'],
  writeScopes: ['workspace'],
  filesystem: { read: 'workspace', write: 'workspace' },
  metadata: {
    workspace: {
      requiresActiveProject: true,
      requiresWorkspaceSwitchForExternalCwd: true,
      mutation: 'non-transactional',
      arbitraryRead: true,
    },
    canMutateWorkspace: true,
  },
  concurrency: 'unsafe',
  reason: 'office document creation or conversion',
} satisfies OfficeToolCapabilitySchema

export const OfficeDocumentProcessCapability = {
  ...OfficeDocumentWriteCapability,
  process: { execution: 'input-dependent' },
  reason: 'office document conversion with local process execution',
} satisfies OfficeToolCapabilitySchema

// ─── Internal types ────────────────────────────────────────────────────────────

/** Office 工具使用的上下文别名。 */
export type ToolContext = OfficeToolContext

/** 以当前模块为基准创建 require，用于加载 CJS 依赖。 */
export const requireFromOfficeModule = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
)

// ─── Shared result helpers ─────────────────────────────────────────────────────

/** Office 写操作被授权拒绝时的统一返回结构。 */
export function buildWorkspaceMutationSkippedResult(
  authorization: OfficeWorkspaceAuthorizationDecision
): Record<string, unknown> {
  return {
    approved: false,
    skipped: true,
    changed: false,
    rootPath: authorization.rootPath,
    rejectionMessage: authorization.rejectionMessage,
    message: authorization.message,
  }
}

/** Office 工具统一输出结构。 */
export type OfficeOutput = {
  path: string
  bytes: number
  created: boolean
  changed: boolean
  kind: 'docx' | 'pptx' | 'xlsx' | 'pdf'
}

export type NormalizedWordInput = {
  path: string
  originalPath: string
  sourceExtension: '.docx' | '.doc'
  convertedFromLegacyDoc: boolean
  tempDir: Nullable<string>
  converter?: string
  conversionCommandResult?: OfficeSystemCommandResult
}

export type NormalizeWordInputResult =
  | { success: true; input: NormalizedWordInput }
  | {
      success: false
      originalPath: string
      tempDir: Nullable<string>
      commandResult: OfficeSystemCommandResult
    }

// ─── Shared Zod schema helpers ─────────────────────────────────────────────────

/** Office 输出路径 schema；具体工具会再按扩展名校验。 */
export const outputPathSchema = z
  .string()
  .min(1)
  .max(1200)
  .describe(
    parameterDescription({
      description: '输出文件路径。',
      usage: ['支持相对当前工作区的路径。'],
      notes: ['无扩展名时会按工具类型自动补齐。'],
    })
  )

// ─── Markdown 表格原语 ──────────────────────────────────────────────────────────

/**
 * 解析单行 Markdown 表格，保留中间空单元格并去掉首尾管道。
 *
 * 单源判据（§3.7）：wordTool 与 spreadsheetTool 曾各留一份**逐字相同**的拷贝（spreadsheetTool
 * 文件头当年写着「从 wordTool 内联一份轻量版本」）。两份对"什么算表格行"的判定必须一致，
 * 否则同一段 Markdown 生成的 Word 表格与 Excel 表格会开始分叉。要改判定就改这里一处。
 */
export function parseMarkdownTableRow(line: string): Nullable<string[]> {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let cells = trimmed.split('|')
  if (trimmed.startsWith('|')) cells = cells.slice(1)
  if (trimmed.endsWith('|')) cells = cells.slice(0, -1)
  const normalized = cells.map((cell) => cell.trim())
  return normalized.length >= 2 ? normalized : null
}

/** 判断 Markdown 表格分隔行，例如 | --- | :---: |。 */
export function isMarkdownTableSeparator(line: string): boolean {
  const row = parseMarkdownTableRow(line)
  return !!row?.length && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

// ─── Path & workspace helpers ──────────────────────────────────────────────────

/**
 * Office 工具必须有可解析的执行根，因为产物只能写入根内。
 * 能力范围由 toolSpacePolicy 限制在日常工作区；这里继续按执行根判断，允许日常会话
 * 使用自己的 scratch 根，同时防止没有任何可用根时进入具体工具实现。
 */
export function toolRequiresWorkspace(ctx: ToolContext): boolean {
  try {
    return !!ctx.workspace.getRootPath()
  } catch {
    // arch-guard:silent-catch-ok 无任何可用根（未激活工作区）时执行根解析会抛错，等价于"工具不可用"，不是故障。
    return false
  }
}

/** 在可选 cwd 下执行 Office 操作。 */
export async function runWithDirectory<T>(
  ctx: OfficeToolContext,
  cwd: string | undefined,
  action: () => Promise<T>
): Promise<T> {
  if (!cwd) return action()
  // workspace 层负责临时切换目录并恢复。
  return ctx.workspace.runInDirectory(cwd, action)
}

/** 解析输出路径并强制扩展名，最终保证路径仍在工作区内。 */
export function normalizeExtensionPath(
  rootPath: string,
  outputPath: string,
  extension: string
): string {
  const trimmedPath = outputPath.trim()
  if (!trimmedPath) throw new AppError('VALIDATION', '输出路径不能为空。')

  // 相对路径以工作区 root 为基准，绝对路径也必须最终落在 root 内。
  const basePath = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(rootPath, trimmedPath)
  const currentExtension = extname(basePath).toLowerCase()

  // 用户显式给了错误扩展名时直接拒绝，避免生成文件类型和路径不一致。
  if (currentExtension && currentExtension !== extension) {
    throw new AppError('VALIDATION', `输出文件扩展名必须是 ${extension}。`)
  }

  const resolvedPath = currentExtension ? basePath : `${basePath}${extension}`
  // 最后统一做工作区包含关系和内部目录保护。
  assertOfficePathInsideWorkspace(rootPath, resolvedPath, outputPath)

  return resolvedPath
}

/**
 * 确认 Office 输入/输出路径位于工作区内。
 *
 * 判据（§5.3b ④安全门）——这是整个 office 能力**唯一**的路径包含门：所有工具的读写路径
 * 都必须先经 `normalizeExtensionPath` / `resolveOfficeInputPathWithExtensions` 落到这里。
 * 挡的是 `../` 穿越与绝对路径逃逸——注意入参允许绝对路径（用户经常直接粘），所以不能靠
 * "是否相对路径"判断，必须 **resolve 之后再算相对关系**（`getRelativePathInsideOfficeRoot`）。
 * 绕过它写盘 = 模型可以往用户主目录任意位置落文件，因此新增写入路径的工具一律走上面两个入口，
 * 不要自己 `resolve` 完就用。
 */
export function assertOfficePathInsideWorkspace(
  rootPath: string,
  resolvedPath: string,
  originalPath: string
): void {
  const relativePath = getRelativePathInsideOfficeRoot(rootPath, resolvedPath)
  if (!relativePath) {
    throw new AppError('PERMISSION', `路径超出工作区范围：${originalPath}`)
  }
}

/** 准备 Office 输出路径：校验扩展名、覆盖策略并创建父目录。 */
export async function prepareOfficeOutputPath(
  ctx: OfficeToolContext,
  outputPath: string,
  extension: string,
  overwrite?: boolean
): Promise<{ path: string; created: boolean }> {
  const resolvedPath = normalizeExtensionPath(ctx.workspace.getRootPath(), outputPath, extension)
  const existing = await getFileStats(resolvedPath)
  // 目标存在但不是普通文件时拒绝，避免覆盖目录或特殊文件。
  if (existing && !existing.isFile()) {
    throw new AppError('VALIDATION', `目标路径不是文件：${outputPath}`)
  }
  // 覆盖必须显式声明。
  if (existing && !overwrite) {
    throw new AppError(
      'VALIDATION',
      `文件已存在，覆盖写入需要显式设置 overwrite=true：${outputPath}`
    )
  }
  // 父目录不存在时自动创建。
  await mkdir(dirname(resolvedPath), { recursive: true })
  return { path: resolvedPath, created: !existing }
}

/** 解析 Office 输入路径并限制允许扩展名。 */
export async function resolveOfficeInputPathWithExtensions(
  ctx: OfficeToolContext,
  inputPath: string,
  extensions: string[]
): Promise<string> {
  const trimmedPath = inputPath.trim()
  if (!trimmedPath) throw new AppError('VALIDATION', '输入路径不能为空。')

  // 输入文件同样必须在工作区内。
  const resolvedPath = isAbsolute(trimmedPath)
    ? resolve(trimmedPath)
    : resolve(ctx.workspace.getRootPath(), trimmedPath)
  const currentExtension = extname(resolvedPath).toLowerCase()
  // 多扩展名用于 PDF/Word 等转换场景。
  if (!extensions.includes(currentExtension)) {
    throw new AppError('VALIDATION', `输入文件扩展名必须是 ${extensions.join(' 或 ')}。`)
  }

  assertOfficePathInsideWorkspace(ctx.workspace.getRootPath(), resolvedPath, inputPath)
  const existing = await getFileStats(resolvedPath)

  // 转换/编辑前必须确认输入文件存在。
  if (!existing?.isFile()) {
    throw new AppError('VALIDATION', `输入文件不存在或不是文件：${inputPath}`)
  }

  return resolvedPath
}

/** 解析只允许单一扩展名的 Office 输入文件。 */
export async function resolveOfficeInputPath(
  ctx: OfficeToolContext,
  inputPath: string,
  extension: string
): Promise<string> {
  return resolveOfficeInputPathWithExtensions(ctx, inputPath, [extension])
}

/** stat 包装；文件不存在时不抛错，其他错误继续抛出。 */
export async function getFileStats(
  path: string
): Promise<Nullable<Awaited<ReturnType<typeof stat>>>> {
  try {
    return await stat(path)
  } catch (error) {
    if (isPlainObject(error) && error.code === 'ENOENT') return null
    throw error
  }
}

/** 写入 Office 二进制 Buffer 并返回统一输出结构。 */
export async function writeOfficeBuffer(
  prepared: { path: string; created: boolean },
  data: Buffer | Uint8Array,
  kind: OfficeOutput['kind']
): Promise<OfficeOutput> {
  await writeFile(prepared.path, data)
  const fileStats = await stat(prepared.path)
  return {
    path: prepared.path,
    bytes: fileStats.size,
    created: prepared.created,
    changed: true,
    kind,
  }
}

/** 复制临时产物到最终 Office 输出路径。 */
export async function copyOfficeOutput(
  prepared: { path: string; created: boolean },
  sourcePath: string,
  kind: OfficeOutput['kind']
): Promise<OfficeOutput> {
  await copyFile(sourcePath, prepared.path)
  const fileStats = await stat(prepared.path)
  return {
    path: prepared.path,
    bytes: fileStats.size,
    created: prepared.created,
    changed: true,
    kind,
  }
}

// ─── System command helpers ────────────────────────────────────────────────────
export function commandExecutable(command: OfficeEnvironmentCommandAvailability): string {
  return command.path ? officePlatformCompatibility.quoteShellArg(command.path) : command.name
}

/** 按顺序查找第一个可用系统命令。 */
export async function findAvailableCommand(
  ctx: OfficeToolContext,
  commands: string[]
): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  const inspection = await ctx.system.inspectEnvironment(commands)
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
  const suggestion = input.ctx.system.createSystemToolInstallSuggestion({
    command: input.command,
    reason: input.reason,
    scope: input.ctx.hasWorkspaceRoot() ? 'workspace' : 'system',
  })

  return {
    changed: false,
    skipped: true,
    missingCommand: input.command,
    message: input.message,
    systemToolSuggestion: suggestion ? { ...suggestion, alternatives: input.alternatives } : null,
  }
}

/** 构建“用浏览器线上处理”的替代方案。 */
export function createBrowserOnlineAlternative(input: {
  zhDescription: string
  enDescription: string
  zhDraft: string
  enDraft: string
}): OfficeSystemToolInstallAlternative {
  return {
    id: 'browser-online',
    label: {
      'zh-CN': '用浏览器线上处理',
      'en-US': 'Use browser online',
    },
    description: {
      'zh-CN': input.zhDescription,
      'en-US': input.enDescription,
    },
    draft: {
      'zh-CN': input.zhDraft,
      'en-US': input.enDraft,
    },
  }
}

/** 在临时目录里查找预期 PDF；找不到时回退任意 PDF 文件。 */
export async function findGeneratedPdf(
  tempDir: string,
  expectedName: string
): Promise<Nullable<string>> {
  return findGeneratedOfficeFile(tempDir, expectedName, '.pdf')
}

/** 在临时目录里查找某类 Office 转换产物；找不到预期文件名时回退任意同扩展名文件。 */
export async function findGeneratedOfficeFile(
  tempDir: string,
  expectedName: string,
  extension: string
): Promise<Nullable<string>> {
  const normalizedExtension = extension.startsWith('.') ? extension.toLowerCase() : `.${extension}`
  const expectedPath = join(tempDir, expectedName)
  const expectedStats = await getFileStats(expectedPath)
  if (expectedStats?.isFile()) return expectedPath

  // 有些外部工具会改变输出文件名，兜底找目录里的第一个同类产物。
  const entries = await readdir(tempDir).catch(() => [] /* arch-guard:silent-catch-ok 临时目录不可读等价于没有产物，由调用方按 null 处理 */)
  const generatedEntry = entries.find(
    (entry) => extname(entry).toLowerCase() === normalizedExtension
  )
  return generatedEntry ? join(tempDir, generatedEntry) : null
}

/** 运行 Office 相关外部系统命令。 */
export async function runOfficeSystemCommand(
  ctx: OfficeToolContext,
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<OfficeSystemCommandResult> {
  // Office 转换/编译通常输出较多，因此放宽 maxOutputChars。
  return ctx.system.runCommand(
    command,
    {
      cwd,
      timeoutMs,
      maxOutputChars: 20_000,
    },
    false
  )
}

// 依次查找常见 LibreOffice 命令名和 macOS App 内的 soffice 可执行文件。
export async function resolveLibreOfficeCommand(
  ctx: OfficeToolContext
): Promise<Nullable<OfficeEnvironmentCommandAvailability>> {
  return findAvailableCommand(ctx, [
    'soffice',
    'libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ])
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
  const command = [
    commandExecutable(input.libreOffice),
    '--headless',
    '--convert-to',
    'docx',
    '--outdir',
    officePlatformCompatibility.quoteShellArg(tempDir),
    officePlatformCompatibility.quoteShellArg(input.inputPath),
  ].join(' ')
  const commandResult = await runOfficeSystemCommand(
    input.ctx,
    command,
    dirname(input.inputPath),
    input.timeoutMs ?? 180_000
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

/** 外部命令失败时的统一返回结构。 */
export function createCommandFailureResult(input: {
  outputPath: string
  kind: OfficeOutput['kind']
  operation: string
  commandResult: OfficeSystemCommandResult
}): Record<string, unknown> {
  return {
    changed: false,
    kind: input.kind,
    outputPath: input.outputPath,
    commandResult: input.commandResult,
    message: `${input.operation}失败：外部命令退出码 ${input.commandResult.exitCode ?? 'unknown'}。请查看 stdout/stderr。`,
  }
}
