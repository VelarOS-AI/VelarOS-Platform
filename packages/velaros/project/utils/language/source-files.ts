import { isEmpty, isPresent, optionalWhen, optionalWhenLazy } from '@velaros-ai/core'

import type { LanguageToolContext } from '../../contract/requires.js'
import type {
  FindImportersInput,
  FindReferencesInput,
  LanguageImporterResult,
  LanguageImportRecord,
  LanguageReferenceRecord,
  LanguageReferenceResult,
  SourceFileSelection,
  SourceFileSelectionResult,
} from '../../types/language.js'
import { DevelopmentTuning } from '../tuning.js'

import { normalizeSeparators } from './project-paths.js'

/** 路径归一：分隔符统一成 `/`，去掉开头的 `./`。 */
export function normalizeSourcePath(input: string): string {
  return normalizeSeparators(input)
}

/** 扩展名归一：去掉前导点、去掉空白、转小写。 */
export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\./u, '').toLowerCase()
}

/** 调用方给的扩展名归一去重；没给就用这个语言服务的缺省集合。 */
export function normalizeExtensionsWithDefault(
  input: LooseOptional<string[]>,
  defaults: readonly string[]
): string[] {
  const source = input && !isEmpty(input) ? input : [...defaults]
  return [...new Set(source.map(normalizeExtension).filter(Boolean))]
}

/** 取路径的扩展名（不带点、小写）；没有扩展名给空串。 */
export function sourceFileExtension(filePath: string): string {
  const normalized = normalizeSourcePath(filePath)
  const match = normalized.match(/\.([^.\\/]+)$/u)
  return match?.[1]?.toLowerCase() ?? ''
}

/** 这个文件的扩展名在不在给定集合里。 */
export function hasMatchingExtension(filePath: string, extensions: string[]): boolean {
  return extensions.includes(sourceFileExtension(filePath))
}

/** 语句原文压成一行，超过摘录上限就截断并用省略号收尾。 */
export function compactStatement(input: string): string {
  const compact = input.replace(/\s+/gu, ' ').trim()
  if (compact.length <= DevelopmentTuning.excerpt.maxChars) return compact
  const ellipsis = '...'
  return `${compact.slice(0, DevelopmentTuning.excerpt.maxChars - ellipsis.length)}${ellipsis}`
}

/** 取正文里第 line 行（从 1 起）；越界给空串。 */
export function lineAt(content: string, line: number): string {
  return content.split(/\r?\n/u)[Math.max(0, line - 1)] ?? ''
}

/** 按结果条数换算这次扫描最多选多少个源文件：倍数放大，再夹在下限与上限之间。 */
export function fileBudgetFor(limit: number, filesPerResult: number): number {
  return Math.min(
    DevelopmentTuning.fileBudget.maxFiles,
    Math.max(limit * filesPerResult, DevelopmentTuning.fileBudget.minFiles)
  )
}

/** 七个动作共用的缺省结果条数。 */
export function limitOf(limit: LooseOptional<number>): number {
  return limit ?? DevelopmentTuning.navigation.defaultLimit
}

/** include 规则区分大小写而扩展名匹配不区分，逐字母展开成字符类让两者一致。 */
function caseInsensitiveGlob(text: string): string {
  return text.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`)
}

/** 经只读内核选出这次要扫的源文件；指向单个源文件时直接用它，不再遍历目录。 */
export async function collectSourceFiles(
  ctx: LanguageToolContext,
  input: SourceFileSelection,
  defaultExtensions: readonly string[]
): Promise<SourceFileSelectionResult> {
  ctx.abortSignal.throwIfAborted()
  const kernel = await ctx.project.kernel()
  ctx.abortSignal.throwIfAborted()
  const extensions = normalizeExtensionsWithDefault(input.extensions, defaultExtensions)
  const selectedPath = optionalWhenLazy(input.path?.trim(), () =>
    normalizeSourcePath(input.path!.trim())
  )

  if (selectedPath && hasMatchingExtension(selectedPath, extensions))
    return { files: [selectedPath], truncated: false }

  const maxFiles = input.maxFiles ?? DevelopmentTuning.navigation.maxSelectedFiles
  // 内核按入列条数截断遍历；只让候选源文件入列，条数上限才等于源文件上限，
  // 目录与无关文件不会挤占名额，内核截断也能如实反映为 truncated。
  const entries = await kernel.listFiles({
    path: selectedPath ?? '.',
    recursive: true,
    maxDepth: input.maxDepth ?? DevelopmentTuning.navigation.maxDepth,
    maxFiles: maxFiles + 1,
    include: extensions.map((extension) => `**/*.${caseInsensitiveGlob(extension)}`),
    excludeGitignored: input.excludeGitignored,
    exclude: input.exclude,
  })
  ctx.abortSignal.throwIfAborted()
  const files = entries
    .filter((entry) => entry.type === 'file' && hasMatchingExtension(entry.path, extensions))
    .map((entry) => entry.path)
    .sort()

  return { files: files.slice(0, maxFiles), truncated: entries.length > maxFiles }
}

/** 经只读内核读一个源文件；二进制或超出读取上限时按缺席处理。 */
export async function readSourceFile(
  ctx: LanguageToolContext,
  path: string
): Promise<Nullable<string>> {
  ctx.abortSignal.throwIfAborted()
  const kernel = await ctx.project.kernel()
  ctx.abortSignal.throwIfAborted()
  const result = await kernel.read({
    path,
    maxBytes: DevelopmentTuning.navigation.maxReadableSourceBytes,
  })
  ctx.abortSignal.throwIfAborted()
  if (result.snapshot.isBinary || !result.content) return null
  return result.content
}

/**
 * 找引用方的共享外壳：选文件规模、逐个读文件、排序、截断与装配都在这里，
 * 语言差异（import 提取与目标匹配）走 `extractMatches` 回调。
 */
export async function scanImporters(
  ctx: LanguageToolContext,
  input: FindImportersInput,
  defaultExtensions: readonly string[],
  extractMatches: (file: string, content: string, fileSet: Set<string>) => LanguageImportRecord[]
): Promise<LanguageImporterResult> {
  const limit = limitOf(input.limit)
  const selection = await collectSourceFiles(
    ctx,
    {
      path: input.path,
      extensions: input.extensions,
      maxDepth: input.maxDepth,
      maxFiles: fileBudgetFor(limit, DevelopmentTuning.fileBudget.importersPerResult),
    },
    defaultExtensions
  )
  const fileSet = new Set(selection.files.map(normalizeSourcePath))
  const importers: LanguageImportRecord[] = []

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    importers.push(...extractMatches(file, content, fileSet))
  }

  importers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return {
    importers: importers.slice(0, limit),
    importerCount: importers.length,
    scannedFiles: selection.files.length,
    fileListTruncated: selection.truncated,
    truncated: importers.length > limit,
  }
}

/** 找引用的共享外壳；语言差异通过 AST 遍历回调注入。 */
export async function scanReferences(
  ctx: LanguageToolContext,
  input: FindReferencesInput,
  defaultExtensions: readonly string[],
  collectFileMatches: (
    file: string,
    content: string,
    isMatch: (text: string) => boolean,
    remaining: number
  ) => LanguageReferenceRecord[]
): Promise<LanguageReferenceResult> {
  const exactWord = input.exactWord ?? true
  const limit = limitOf(input.limit)
  const isMatch = (text: string): boolean =>
    exactWord ? text === input.symbol : text.includes(input.symbol)
  const selection = await collectSourceFiles(
    ctx,
    {
      path: input.path,
      extensions: input.extensions,
      maxDepth: input.maxDepth,
      maxFiles: fileBudgetFor(limit, DevelopmentTuning.fileBudget.importsPerResult),
    },
    defaultExtensions
  )
  const references: LanguageReferenceRecord[] = []
  let scannedFiles = 0
  let stoppedEarly = false

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    scannedFiles += 1
    references.push(...collectFileMatches(file, content, isMatch, limit + 1 - references.length))
    if (references.length > limit) {
      stoppedEarly = true
      break
    }
  }

  // 凑够 limit+1 条就不再往下扫，所以此时的 referenceCount 是下限而不是总数；
  // 它和真实总数的 importerCount 并排交给模型，不标出来模型会当成「全项目只有这么多处引用」。
  return {
    references: references.slice(0, limit),
    referenceCount: references.length,
    referenceCountIsLowerBound: optionalWhen(stoppedEarly, true),
    scannedFiles,
    note: optionalWhen(
      stoppedEarly,
      `引用数是下限：扫到 ${scannedFiles} 个文件、凑够 ${references.length} 处后就停了扫描（上限 ${limit}），项目里实际引用只会更多。`
    ),
    truncated: references.length > limit || selection.truncated,
  }
}
