import { statSync } from 'node:fs'
import nodePath from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import * as ts from 'typescript'

import { AppError, isEmpty, isFalse, isPresent, optionalWhen, optionalWhenLazy } from '@velaros-ai/core'

import { DevelopmentCodeLimits, LanguageServiceIds } from '../../contract/constants.js'
import type { LanguageToolContext } from '../../contract/requires.js'
import type {
  FindImportersInput,
  FindImportsInput,
  FindReferencesInput,
  FindSymbolsInput,
  LanguageDiagnosticRecord,
  LanguageDiagnosticsInput,
  LanguageDiagnosticsResult,
  LanguageExportRecord,
  LanguageExportResult,
  LanguageImporterResult,
  LanguageImportRecord,
  LanguageImportResult,
  LanguageNavigationService,
  LanguageReferenceRecord,
  LanguageReferenceResult,
  LanguageSymbolResult,
  ListExportsInput,
  SourceFileSelectionResult,
} from '../../types/language.js'
import type {
  JsTsExportRecord,
  JsTsImportRecord,
  JsTsSymbolRecord,
  KernelSymbol,
} from '../../types/syntax.js'
import {
  compareDiagnostics,
  emptyDiagnostics,
  ignoredExtensionsNote,
  mapTypeScriptDiagnostic,
  noJsTsExtensionNote,
  noSourceFileNote,
} from '../../utils/language/diagnostics.js'
import {
  createExportedNamesReader,
  dedupeSymbols,
  exportedNamesOf,
  extractExportsFromContent,
  extractImportsFromContent,
  importMatchesTarget,
  nodePosition,
  parseJsTsSource,
  resolveImportedPath,
  symbolMatchesQuery,
  toSymbolRecord,
} from '../../utils/language/jsts-syntax.js'
import { resolveProjectPath } from '../../utils/language/project-paths.js'
import {
  collectSourceFiles,
  fileBudgetFor,
  limitOf,
  lineAt,
  normalizeExtensionsWithDefault,
  readSourceFile,
  scanImporters,
  scanReferences,
} from '../../utils/language/source-files.js'
import {
  extensionWithDot,
  groupFilesByTypeScriptProject,
  safeReadFile,
  SkippedDirectoryGlobs,
  SkippedDirectoryNames,
  TypeScriptExtensions,
} from '../../utils/language/typescript-config.js'
import { DevelopmentTuning } from '../../utils/tuning.js'

import { typeScriptProjectPool } from './TypeScriptProjectPool.js'

/** 内置的 JavaScript / TypeScript 语言服务：六个导航动作加类型诊断，实例由注册表持有。 */
export interface JsTsLanguageServiceApi extends LanguageNavigationService {
  /** 本服务一定实现诊断（`LanguageNavigationService` 里它是可选的）。 */
  getDiagnostics(
    ctx: LanguageToolContext,
    input: LanguageDiagnosticsInput
  ): Promise<LanguageDiagnosticsResult>
}

/** 一次目录诊断选出的文件，连同「一个都没选中」与「扩展名被剔除」两种要交代的情况。 */
export interface JsTsLanguageServiceDiagnosticSelection extends SourceFileSelectionResult {
  /** 一个文件都没选中时的原因；非空选择不使用。 */
  emptyNote: string
  /** 调用方传入但本服务不诊断的扩展名说明，无论是否选中文件都随结果返回。 */
  extensionNote?: LooseOptional<string>
}

/**
 * JavaScript / TypeScript 的语言语义：符号、导入导出、引用都走语法树，诊断走池化的 `ts.LanguageService`。
 *
 * 文件发现、读取与扫描外壳是两个语言服务共用的（`utils/source-files.ts`），这里只实现 JS/TS 那一半。
 */
class JsTsLanguageService implements JsTsLanguageServiceApi {
  public readonly id: string = LanguageServiceIds.jsts
  public readonly label = 'JavaScript / TypeScript'
  public readonly extensions: readonly string[] = [
    'ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs',
  ]

  /** 标准库缺席时语义层与建议层会把 Record/Set 等全局名全部报成缺失，只保留语法层结果。 */
  private static readonly missingStandardLibraryReason =
    '未找到 TypeScript 标准库声明（lib.*.d.ts），类型诊断不可用，只返回了语法诊断。' +
    '这是运行环境缺少标准库，不代表代码存在类型错误。'

  public async findSymbols(
    ctx: LanguageToolContext,
    input: FindSymbolsInput
  ): Promise<LanguageSymbolResult> {
    const limit = limitOf(input.limit)
    const selection = await this.selectFiles(ctx, input, DevelopmentTuning.fileBudget.symbolsPerResult)
    const kernel = await ctx.project.kernel()
    const query = input.query?.trim()
    const kinds = new Set(input.kinds?.map((kind) => kind.toLowerCase()))
    const symbols: JsTsSymbolRecord[] = []
    let scannedSymbols = 0

    for (const file of selection.files) {
      const content = await readSourceFile(ctx, file)
      if (!isPresent(content)) continue
      const readExportedNames = createExportedNamesReader(file, content)
      const rawSymbols = (await kernel.listSymbols(file)) as KernelSymbol[]
      for (const raw of rawSymbols) {
        if (!raw.name) continue
        scannedSymbols += 1
        const symbol = toSymbolRecord(file, raw, readExportedNames)
        if (symbol.kind === 'import' && !kinds.has('import')) continue
        if (input.exportedOnly && !symbol.exported) continue
        if (kinds.size && !kinds.has(symbol.kind.toLowerCase())) continue
        if (query && !symbolMatchesQuery(symbol, query, input.exact)) continue
        symbols.push(symbol)
      }
    }

    const deduped = dedupeSymbols(symbols).sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line
    )
    return {
      symbols: deduped.slice(0, limit).map((symbol) => ({ ...symbol, language: this.id })),
      symbolCount: deduped.length,
      scannedFiles: selection.files.length,
      scannedSymbols,
      fileListTruncated: selection.truncated,
      truncated: deduped.length > limit,
    }
  }

  public async listExports(
    ctx: LanguageToolContext,
    input: ListExportsInput
  ): Promise<LanguageExportResult> {
    const limit = limitOf(input.limit)
    const selection = await this.selectFiles(ctx, input, DevelopmentTuning.fileBudget.exportsPerResult)
    const records: JsTsExportRecord[] = []
    const kernel = await ctx.project.kernel()

    for (const file of selection.files) {
      const content = await readSourceFile(ctx, file)
      if (!isPresent(content)) continue
      const syntaxExports = extractExportsFromContent(file, content)
      for (const record of syntaxExports) {
        if (isFalse(input.includeReExports) && record.reExport) continue
        if (input.query && !record.name.toLowerCase().includes(input.query.toLowerCase())) continue
        records.push(record)
      }

      // 内核的符号表补上语法层看不出来的导出（适配器标了 exported 的声明）。这里直接问内核要这个文件的
      // 符号：原先走的是「按单个文件再跑一遍 findSymbols」，那会为每个文件再列一次目录、再读一次文件，
      // 整份目录扫描因此被做了 N+1 遍。
      const exportedNames = exportedNamesOf(syntaxExports)
      const readExportedNames = (): ReadonlySet<string> => exportedNames
      const rawSymbols = (await kernel.listSymbols(file)) as KernelSymbol[]
      for (const raw of rawSymbols) {
        if (!raw.name) continue
        const symbol = toSymbolRecord(file, raw, readExportedNames)
        if (symbol.kind === 'import' || !symbol.exported) continue
        if (input.query && !symbol.name.toLowerCase().includes(input.query.toLowerCase())) continue
        records.push({
          path: symbol.path,
          line: symbol.line,
          column: symbol.column,
          name: symbol.name,
          kind: symbol.kind,
          reExport: false,
        })
      }
    }

    const seen = new Set<string>()
    const deduped = records
      .filter((record) => {
        const key = `${record.path}:${record.name}:${record.kind}:${record.line}:${record.source ?? ''}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)

    const exports: LanguageExportRecord[] = deduped
      .slice(0, limit)
      .map((record) => ({ ...record, language: this.id }))
    return {
      exports,
      exportCount: deduped.length,
      scannedFiles: selection.files.length,
      fileListTruncated: selection.truncated,
      truncated: deduped.length > limit,
    }
  }

  public async findImports(
    ctx: LanguageToolContext,
    input: FindImportsInput
  ): Promise<LanguageImportResult> {
    const limit = limitOf(input.limit)
    const selection = await this.selectFiles(ctx, input, DevelopmentTuning.fileBudget.importsPerResult)
    const records: JsTsImportRecord[] = []

    for (const file of selection.files) {
      const content = await readSourceFile(ctx, file)
      if (!isPresent(content)) continue
      for (const record of extractImportsFromContent(file, content)) {
        if (input.kind && record.kind !== input.kind) continue
        if (isFalse(input.includeExternal) && !record.isRelative) continue
        if (input.specifier && record.specifier !== input.specifier) continue
        records.push(record)
      }
    }

    records.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    return {
      imports: records.slice(0, limit).map((record) => ({ ...record, language: this.id })),
      importCount: records.length,
      scannedFiles: selection.files.length,
      fileListTruncated: selection.truncated,
      truncated: records.length > limit,
    }
  }

  public async findImporters(
    ctx: LanguageToolContext,
    input: FindImportersInput
  ): Promise<LanguageImporterResult> {
    return scanImporters(ctx, input, this.extensions, (file, content, fileSet) => {
      const matches: LanguageImportRecord[] = []
      for (const record of extractImportsFromContent(file, content)) {
        if (!input.includeReExports && record.kind === 'export-from') continue
        if (!importMatchesTarget(record, input, this.extensions, fileSet)) continue
        matches.push({
          ...record,
          resolvedPath: optionalWhenLazy(
            record.isRelative,
            () => resolveImportedPath(record.path, record.specifier, this.extensions, fileSet) || undefined
          ),
          language: this.id,
        })
      }
      return matches
    })
  }

  public async findReferences(
    ctx: LanguageToolContext,
    input: FindReferencesInput
  ): Promise<LanguageReferenceResult> {
    return scanReferences(ctx, input, this.extensions, (file, content, isMatch, remaining) => {
      const matches: LanguageReferenceRecord[] = []
      const sourceFile = parseJsTsSource(file, content)
      const visit = (node: ts.Node): void => {
        if (matches.length >= remaining) return
        if (ts.isIdentifier(node) && isMatch(node.getText(sourceFile))) {
          const position = nodePosition(sourceFile, node)
          matches.push({
            path: file,
            language: this.id,
            line: position.line,
            column: position.column,
            excerpt: lineAt(content, position.line).trim(),
          })
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
      return matches
    })
  }

  public async getDiagnostics(
    ctx: LanguageToolContext,
    input: LanguageDiagnosticsInput
  ): Promise<LanguageDiagnosticsResult> {
    ctx.abortSignal.throwIfAborted()
    const limit = limitOf(input.limit)
    const rootPath = ctx.project.getRootPath()
    const selection = await this.selectDiagnosticFiles(ctx, rootPath, input)
    if (isEmpty(selection.files)) return emptyDiagnostics(selection.emptyNote)

    const deadline = Date.now() + DevelopmentCodeLimits.diagnosticTimeBudgetMs
    const diagnostics: LanguageDiagnosticRecord[] = []
    let standardLibraryAvailable = true
    let scannedFiles = 0
    let unreadableFiles = 0
    let outOfTime = false
    const absolutePaths = selection.files.map((file) => nodePath.resolve(rootPath, file))
    for (const group of groupFilesByTypeScriptProject(rootPath, absolutePaths)) {
      const contents = new Map<string, string>()
      for (const absolutePath of group) {
        const content = safeReadFile(absolutePath)
        if (isPresent(content)) contents.set(absolutePath, content)
        else unreadableFiles += 1
      }
      const [requestPath] = contents.keys()
      if (!isPresent(requestPath)) continue

      // 整组文件作为根文件与 overlay 交给一次 acquire：程序只构建一次，
      // 不在任何配置 include 里的文件（如测试目录）也按所属配置诊断。
      const acquireGroup = (): ReturnType<typeof typeScriptProjectPool.acquire> =>
        typeScriptProjectPool.acquire(rootPath, requestPath, [...contents.keys()], contents)
      let acquired = acquireGroup()
      for (const absolutePath of contents.keys()) {
        // 文件之间让出事件循环：宿主主进程保持响应，中止信号也能在两个文件之间生效。
        await yieldToEventLoop()
        ctx.abortSignal.throwIfAborted()
        outOfTime = Date.now() > deadline
        if (outOfTime) break
        // 让出期间并发的查询可能 dispose 了该服务或回收了本组 overlay，失效就按原组重新 acquire。
        if (!acquired.isCurrent() || !acquired.files.has(absolutePath)) acquired = acquireGroup()

        const { service, files } = acquired
        const fileDiagnostics = acquired.standardLibraryAvailable
          ? [
              ...service.getSyntacticDiagnostics(absolutePath),
              ...service.getSemanticDiagnostics(absolutePath),
              ...service.getSuggestionDiagnostics(absolutePath),
            ]
          : service.getSyntacticDiagnostics(absolutePath)
        standardLibraryAvailable &&= acquired.standardLibraryAvailable
        scannedFiles += 1
        for (const diagnostic of fileDiagnostics) {
          const record = mapTypeScriptDiagnostic(rootPath, this.id, files, diagnostic)
          if (isPresent(record)) diagnostics.push(record)
        }
      }
      if (outOfTime) break
    }
    diagnostics.sort(compareDiagnostics)

    const notes = [
      selection.extensionNote,
      optionalWhen(
        selection.truncated,
        `源文件超过 ${DevelopmentCodeLimits.diagnosticFiles} 个，只选取了目录遍历先遇到的 ${DevelopmentCodeLimits.diagnosticFiles} 个。`
      ),
      optionalWhen(
        outOfTime,
        `诊断耗时超过 ${DevelopmentCodeLimits.diagnosticTimeBudgetMs / 1000} 秒，选中的 ${selection.files.length} ` +
          `个文件只诊断了 ${scannedFiles} 个。`
      ),
      optionalWhen(unreadableFiles > 0, `${unreadableFiles} 个源文件不可读，未做诊断。`),
      optionalWhen(scannedFiles === 0, '没有任何文件完成诊断，这不代表代码没有错误。'),
      optionalWhen(selection.truncated || outOfTime, '其余文件未诊断，缩小 path 可覆盖它们。'),
    ].filter(isPresent)
    return {
      diagnostics: diagnostics.slice(0, limit),
      diagnosticCount: diagnostics.length,
      scannedFiles,
      fileListTruncated: selection.truncated || outOfTime,
      truncated: diagnostics.length > limit,
      degraded: optionalWhen(
        !standardLibraryAvailable,
        JsTsLanguageService.missingStandardLibraryReason
      ),
      note: optionalWhen(!isEmpty(notes), notes.join('')),
    }
  }

  /** 按这次动作的结果条数换算扫描面，再交给共享的选文件外壳。 */
  private selectFiles(
    ctx: LanguageToolContext,
    input: { path?: string; extensions?: string[]; maxDepth?: number; limit?: number },
    filesPerResult: number
  ): Promise<SourceFileSelectionResult> {
    return collectSourceFiles(
      ctx,
      {
        path: input.path,
        extensions: input.extensions,
        maxDepth: input.maxDepth,
        maxFiles: fileBudgetFor(limitOf(input.limit), filesPerResult),
      },
      this.extensions
    )
  }

  /** 选出这次要诊断的文件：单文件直接用它，目录先收窄到 JS/TS 子集再遍历。 */
  private async selectDiagnosticFiles(
    ctx: LanguageToolContext,
    rootPath: string,
    input: LanguageDiagnosticsInput
  ): Promise<JsTsLanguageServiceDiagnosticSelection> {
    const target = await resolveProjectPath(rootPath, input.path)
    const stats = statSync(target.absolutePath, { throwIfNoEntry: false })
    if (!stats) throw new AppError('NOT_FOUND', `诊断路径不存在：${target.relativePath}`)

    if (!stats.isDirectory()) {
      const isSource = TypeScriptExtensions.has(extensionWithDot(target.absolutePath))
      return {
        files: isSource ? [target.relativePath] : [],
        truncated: false,
        emptyNote: `${target.relativePath} 不是 JavaScript/TypeScript 源文件，未做诊断。`,
      }
    }

    // 只有 JS/TS 扩展名的文件能进入 TS 程序；其它扩展名（vue、json…）的文件交给语言服务会直接
    // 抛错，所以选文件前就收窄到 JS/TS 子集，被剔除的扩展名在结果里说明。
    const requestedExtensions = normalizeExtensionsWithDefault(input.extensions, this.extensions)
    const isJsTsExtension = (extension: string): boolean => TypeScriptExtensions.has(`.${extension}`)
    const extensions = requestedExtensions.filter(isJsTsExtension)
    const ignoredExtensions = requestedExtensions.filter((extension) => !isJsTsExtension(extension))
    const extensionNote = optionalWhen(
      !isEmpty(ignoredExtensions),
      ignoredExtensionsNote(ignoredExtensions)
    )
    if (isEmpty(extensions))
      return { files: [], truncated: false, emptyNote: noJsTsExtensionNote(this.extensions) }

    const maxDepth = input.maxDepth ?? DevelopmentTuning.navigation.maxDepth
    const selection = await collectSourceFiles(
      ctx,
      {
        path: target.relativePath,
        extensions,
        maxDepth,
        maxFiles: DevelopmentCodeLimits.diagnosticFiles,
        // 构建产物（dist/*.js、*.d.ts）通常被 .gitignore 忽略；诊断它们只会挤占名额、制造噪音。
        excludeGitignored: true,
        exclude: SkippedDirectoryGlobs,
      },
      this.extensions
    )
    return {
      ...selection,
      extensionNote,
      emptyNote: noSourceFileNote({
        path: target.relativePath,
        maxDepth,
        extensions,
        skippedDirectories: [...SkippedDirectoryNames],
        extensionNote,
      }),
    }
  }
}

/** 进程内唯一的一份；由语言服务注册表持有。 */
export const jsTsLanguageService: JsTsLanguageServiceApi = new JsTsLanguageService()
