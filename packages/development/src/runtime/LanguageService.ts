import { isEmpty, isPresent, optionalWhenLazy, toNullable } from '@velaros-ai/core'
import type { AgentProjectKernelPort } from '@velaros-ai/project/agent'

/** Source inspection consumes no project mutation, execution, or approval capability. */
export type LanguageReadPort = Pick<AgentProjectKernelPort, 'listFiles' | 'read' | 'listSymbols'>

export interface LanguageToolContext {
  abortSignal: AbortSignal
  project: {
    getRootPath(): string
    runInDirectory<T>(path: string, action: () => Promise<T>): Promise<T>
    kernel(): Promise<LanguageReadPort>
  }
}

export interface LanguageQueryInput extends Record<string, any> {
  path?: string
  limit?: number
  extensions?: string[]
  maxDepth?: number
}

export interface LanguageSymbolRecord {
  path: string
  name: string
  kind: string
  language: string
  container?: string
  line: number
  column: number
  exported: boolean
  adapterId?: string
}

export interface LanguageImportRecord {
  path: string
  line: number
  column: number
  language: string
  kind: string
  specifier: string
  isRelative: boolean
  isTypeOnly: boolean
  importedNames: string[]
  raw: string
  resolvedPath?: LooseOptional<string>
}

export interface LanguageExportRecord {
  path: string
  line: number
  column: number
  language: string
  name: string
  kind: string
  localName?: string
  source?: string
  reExport: boolean
}

export interface LanguageReferenceRecord {
  path: string
  line: number
  column: number
  language: string
  excerpt: string
}

export interface LanguageDiagnosticRecord {
  path: string
  line: number
  column: number
  endLine: number
  endColumn: number
  language: string
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string
  code?: number
}

export interface LanguageSymbolResult {
  symbols: LanguageSymbolRecord[]
  symbolCount: number
  scannedFiles: number
  scannedSymbols: number
  fileListTruncated: boolean
  truncated: boolean
}

export interface LanguageExportResult {
  exports: LanguageExportRecord[]
  exportCount: number
  scannedFiles: number
  fileListTruncated: boolean
  truncated: boolean
}

export interface LanguageImportResult {
  imports: LanguageImportRecord[]
  importCount: number
  scannedFiles: number
  fileListTruncated: boolean
  truncated: boolean
}

export interface LanguageImporterResult {
  importers: LanguageImportRecord[]
  importerCount: number
  scannedFiles: number
  fileListTruncated: boolean
  truncated: boolean
}

export interface LanguageReferenceResult {
  references: LanguageReferenceRecord[]
  referenceCount: number
  scannedFiles: number
  truncated?: boolean
}

export interface LanguageDiagnosticsResult {
  diagnostics: LanguageDiagnosticRecord[]
  diagnosticCount: number
  scannedFiles: number
  fileListTruncated?: boolean
  truncated?: boolean
  /** 诊断能力降级的原因（例如类型检查不可用）；存在时结果不完整，空列表不代表代码没有问题。 */
  degraded?: string
  /** 没有扫描到文件、文件数被截断等调用方必须知道的说明。 */
  note?: string
}

const DiagnosticSeverityRank: Record<LanguageDiagnosticRecord['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
}

/** 错误排在警告与提示之前：结果按 limit 截断时，大量提示不会把真错误挤出返回窗口。 */
export function compareDiagnostics(
  left: LanguageDiagnosticRecord,
  right: LanguageDiagnosticRecord
): number {
  return (
    DiagnosticSeverityRank[left.severity] - DiagnosticSeverityRank[right.severity] ||
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column
  )
}

export interface FindSymbolsInput extends LanguageQueryInput {
  query?: string
  exportedOnly?: boolean
  kinds?: string[]
  exact?: boolean
}

export interface ListExportsInput extends LanguageQueryInput {
  query?: string
  includeReExports?: boolean
}

export interface FindImportsInput extends LanguageQueryInput {
  specifier?: string
  kind?: string
  includeExternal?: boolean
}

export interface FindReferencesInput extends LanguageQueryInput {
  symbol: string
  exactWord?: boolean
}

export interface FindImportersInput extends LanguageQueryInput {
  targetPath?: string
  specifier?: string
  includeReExports?: boolean
}

export interface LanguageDiagnosticsInput extends LanguageQueryInput {
  path: string
}

export interface LanguageNavigationService {
  id: string
  label: string
  extensions: readonly string[]
  findSymbols(ctx: LanguageToolContext, input: FindSymbolsInput): Promise<LanguageSymbolResult>
  listExports(ctx: LanguageToolContext, input: ListExportsInput): Promise<LanguageExportResult>
  findImports(ctx: LanguageToolContext, input: FindImportsInput): Promise<LanguageImportResult>
  findReferences(
    ctx: LanguageToolContext,
    input: FindReferencesInput
  ): Promise<LanguageReferenceResult>
  findImporters(
    ctx: LanguageToolContext,
    input: FindImportersInput
  ): Promise<LanguageImporterResult>
  getDiagnostics?(
    ctx: LanguageToolContext,
    input: LanguageDiagnosticsInput
  ): Promise<LanguageDiagnosticsResult>
}

export interface LanguageToolsPlugin {
  id: string
  label: string
  services: readonly LanguageNavigationService[]
}

class LanguageServiceRegistry {
  private readonly plugins = new Map<string, LanguageToolsPlugin>()
  private readonly services = new Map<string, LanguageNavigationService>()

  public install(plugin: LanguageToolsPlugin): void {
    this.plugins.set(plugin.id, plugin)
    for (const service of plugin.services) {
      this.services.set(service.id, service)
    }
  }

  public listServices(): LanguageNavigationService[] {
    return [...this.services.values()]
  }

  public getService(id: string): Nullable<LanguageNavigationService> {
    return toNullable(this.services.get(id))
  }
}

export const languageServiceRegistry = new LanguageServiceRegistry()

// 语言导航共享基础设施。语言差异通过扩展名和解析回调注入，不复制文件扫描实现。

export const DefaultNavigationMaxDepth = 12
export const MaxReadableSourceBytes = 1_000_000

export interface SourceFileSelection {
  path?: string
  extensions?: string[]
  maxDepth?: number
  maxFiles?: number
  /** 缺省沿用内核规则：根目录跳过 .gitignore 忽略的文件，显式子目录不跳过。 */
  excludeGitignored?: boolean
}

export function normalizeSourcePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '')
}

export function normalizeExtension(input: string): string {
  return input.trim().replace(/^\./, '').toLowerCase()
}

export function normalizeExtensionsWithDefault(
  input: LooseOptional<string[]>,
  defaults: readonly string[]
): string[] {
  const source = input && !isEmpty(input) ? input : [...defaults]
  return [...new Set(source.map(normalizeExtension).filter(Boolean))]
}

export function sourceFileExtension(filePath: string): string {
  const normalized = normalizeSourcePath(filePath)
  const match = normalized.match(/\.([^.\\/]+)$/)
  return match?.[1]?.toLowerCase() ?? ''
}

export function hasMatchingExtension(filePath: string, extensions: string[]): boolean {
  return extensions.includes(sourceFileExtension(filePath))
}

export function compactStatement(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact
}

export function lineAt(content: string, line: number): string {
  return content.split(/\r?\n/)[Math.max(0, line - 1)] ?? ''
}

export async function collectSourceFiles(
  ctx: LanguageToolContext,
  input: SourceFileSelection,
  defaultExtensions: readonly string[]
): Promise<{ files: string[]; truncated: boolean }> {
  ctx.abortSignal.throwIfAborted()
  const kernel = await ctx.project.kernel()
  ctx.abortSignal.throwIfAborted()
  const extensions = normalizeExtensionsWithDefault(input.extensions, defaultExtensions)
  const selectedPath = optionalWhenLazy(input.path?.trim(), () =>
    normalizeSourcePath(input.path!.trim())
  )

  if (selectedPath && hasMatchingExtension(selectedPath, extensions))
    return { files: [selectedPath], truncated: false }

  const maxFiles = input.maxFiles ?? 2500
  // 内核按入列条数截断遍历；只让候选源文件入列，条数上限才等于源文件上限，
  // 目录与无关文件不会挤占名额，内核截断也能如实反映为 truncated。
  const entries = await kernel.listFiles({
    path: selectedPath ?? '.',
    recursive: true,
    maxDepth: input.maxDepth ?? DefaultNavigationMaxDepth,
    maxFiles: maxFiles + 1,
    include: extensions.map((extension) => `**/*.${caseInsensitiveGlob(extension)}`),
    excludeGitignored: input.excludeGitignored,
  })
  ctx.abortSignal.throwIfAborted()
  const files = entries
    .filter((entry) => entry.type === 'file' && hasMatchingExtension(entry.path, extensions))
    .map((entry) => entry.path)
    .sort()

  return { files: files.slice(0, maxFiles), truncated: entries.length > maxFiles }
}

/** include 规则区分大小写而扩展名匹配不区分，逐字母展开成字符类让两者一致。 */
function caseInsensitiveGlob(text: string): string {
  return text.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)
}

export async function readSourceFile(
  ctx: LanguageToolContext,
  path: string
): Promise<Nullable<string>> {
  ctx.abortSignal.throwIfAborted()
  const kernel = await ctx.project.kernel()
  ctx.abortSignal.throwIfAborted()
  const result = await kernel.read({ path, maxBytes: MaxReadableSourceBytes })
  ctx.abortSignal.throwIfAborted()
  if (result.snapshot.isBinary || !result.content) return null
  return result.content
}

export const DefaultNavigationLimit = 100

/**
 * importers 扫描共享外壳:选文件规模公式/循环读文件/排序/截断/装配单实现;
 * 语言差异(import 提取与目标匹配)走 extractMatches 回调。
 */
export async function scanImporters(
  ctx: LanguageToolContext,
  input: FindImportersInput,
  defaultExtensions: readonly string[],
  extractMatches: (file: string, content: string, fileSet: Set<string>) => LanguageImportRecord[]
): Promise<LanguageImporterResult> {
  const limit = input.limit ?? DefaultNavigationLimit
  const selection = await collectSourceFiles(
    ctx,
    {
      path: input.path,
      extensions: input.extensions,
      maxDepth: input.maxDepth,
      maxFiles: Math.min(5000, Math.max(limit * 50, 500)),
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

/**
 * references 扫描共享外壳；语言差异通过 AST 遍历回调注入。
 */
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
  const limit = input.limit ?? DefaultNavigationLimit
  const isMatch = (text: string): boolean =>
    exactWord ? text === input.symbol : text.includes(input.symbol)
  const selection = await collectSourceFiles(
    ctx,
    {
      path: input.path,
      extensions: input.extensions,
      maxDepth: input.maxDepth,
      maxFiles: Math.min(5000, Math.max(limit * 40, 500)),
    },
    defaultExtensions
  )
  const references: LanguageReferenceRecord[] = []

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    references.push(...collectFileMatches(file, content, isMatch, limit + 1 - references.length))
    if (references.length > limit) break
  }

  return {
    references: references.slice(0, limit),
    referenceCount: references.length,
    scannedFiles: selection.files.length,
    truncated: references.length > limit || selection.truncated,
  }
}
