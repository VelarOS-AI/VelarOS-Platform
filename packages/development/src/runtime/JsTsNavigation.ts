import { statSync } from 'node:fs'
import nodePath from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import * as ts from 'typescript'

import {
  isEmpty,
  isFalse,
  isNumber,
  isPresent,
  isTrue,
  numberOrNull,
  optionalWhen,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { optionalWhenLazy } from '@velaros-ai/core/utils/optionalWhen'

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
  LanguageSymbolRecord,
  LanguageSymbolResult,
  LanguageToolContext,
  ListExportsInput,
} from './LanguageService'
// 语言服务共享文件发现、读取与扫描基础设施；本模块只实现 JavaScript/TypeScript 语义。
import {
  collectSourceFiles,
  compactStatement,
  compareDiagnostics,
  DefaultNavigationLimit,
  DefaultNavigationMaxDepth,
  lineAt,
  normalizeExtensionsWithDefault,
  normalizeSourcePath as normalizePath,
  readSourceFile,
  scanImporters,
  scanReferences,
  type SourceFileSelection as FileSelection,
} from './LanguageService'
import {
  acquireTypeScriptLanguageService,
  groupFilesByTypeScriptProject,
  safeReadFile as safeReadTypeScriptProjectFile,
  SkippedDirectoryNames,
  TypeScriptExtensions,
} from './TypeScriptProjectHost'

const DefaultJsTsExtensions = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs'] as const

function collectJsTsFiles(
  ctx: LanguageToolContext,
  input: FileSelection
): Promise<{ files: string[]; truncated: boolean }> {
  return collectSourceFiles(ctx, input, DefaultJsTsExtensions)
}
const DefaultLimit = DefaultNavigationLimit

interface KernelSymbol {
  name: string
  kind?: string
  container?: string
  exported?: boolean
  path?: string
  line?: number
  column?: number
  range?: {
    startLine?: number
    endLine?: number
    startColumn?: number
    endColumn?: number
  }
  adapterId?: string
  metadata?: Record<string, any>
}

interface JsTsSymbolRecord extends Omit<LanguageSymbolRecord, 'language'> {
  path: string
  name: string
  kind: string
  container?: string
  line: number
  column: number
  exported: boolean
  adapterId?: string
}

interface JsTsImportRecord extends Omit<LanguageImportRecord, 'language'> {
  path: string
  line: number
  column: number
  kind: 'import' | 'export-from' | 'require' | 'dynamic-import'
  specifier: string
  isRelative: boolean
  isTypeOnly: boolean
  importedNames: string[]
  raw: string
}

interface JsTsExportRecord extends Omit<LanguageExportRecord, 'language'> {
  path: string
  line: number
  column: number
  name: string
  kind: string
  localName?: string
  source?: string
  reExport: boolean
}

function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.mjs') || path.endsWith('.cjs') || path.endsWith('.js'))
    return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function parseJsTsSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
}

function nodePosition(sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: position.line + 1, column: position.character + 1 }
}

function isInsideRoot(rootPath: string, absolutePath: string): boolean {
  const relative = nodePath.relative(rootPath, absolutePath)
  return !!relative && !relative.startsWith('..') && !nodePath.isAbsolute(relative)
}

/** 解析项目内的文件或目录；项目根本身合法，相对路径以 `.` 表示。 */
function resolveProjectPath(
  rootPath: string,
  inputPath: string
): {
  absolutePath: string
  relativePath: string
} {
  const absolutePath = nodePath.resolve(rootPath, inputPath)
  if (absolutePath !== nodePath.resolve(rootPath) && !isInsideRoot(rootPath, absolutePath)) {
    throw new AppError('VALIDATION', `path is outside project: ${inputPath}`)
  }
  return {
    absolutePath,
    relativePath: normalizePath(nodePath.relative(rootPath, absolutePath)) || '.',
  }
}

function rangeFromTypeScriptDiagnostic(
  fileName: string,
  content: string,
  start: number,
  length: number
): Pick<LanguageDiagnosticRecord, 'line' | 'column' | 'endLine' | 'endColumn'> {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start)
  const endPosition = sourceFile.getLineAndCharacterOfPosition(start + length)
  return {
    line: startPosition.line + 1,
    column: startPosition.character + 1,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character + 1,
  }
}

function diagnosticSeverity(category: ts.DiagnosticCategory): LanguageDiagnosticRecord['severity'] {
  if (category === ts.DiagnosticCategory.Error) return 'error'
  if (category === ts.DiagnosticCategory.Warning) return 'warning'
  return 'info'
}

function mapTypeScriptDiagnostic(
  rootPath: string,
  files: Map<string, string>,
  diagnostic: ts.Diagnostic
): Nullable<LanguageDiagnosticRecord> {
  if (!diagnostic.file || !isNumber(diagnostic.start)) return null
  const absolutePath = diagnostic.file.fileName
  if (!isInsideRoot(rootPath, absolutePath)) return null

  const content = files.get(absolutePath) ?? safeReadTypeScriptProjectFile(absolutePath)
  if (!isPresent(content)) return null

  return {
    path: normalizePath(nodePath.relative(rootPath, absolutePath)),
    language: jsTsLanguageService.id,
    severity: diagnosticSeverity(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    source: 'typescript',
    code: toOptional(numberOrNull(diagnostic.code)),
    ...rangeFromTypeScriptDiagnostic(
      absolutePath,
      content,
      diagnostic.start,
      diagnostic.length ?? 1
    ),
  }
}

function stringLiteralText(node: LooseOptional<ts.Node>): LooseOptional<string> {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
}

function isExportedNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword)
}

function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword)
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingNames(element.name) : []
    )
  return []
}

function importClauseNames(clause: LooseOptional<ts.ImportClause>): string[] {
  if (!clause) return []
  const names: string[] = []
  if (clause.name) names.push(clause.name.text)
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text)
    } else {
      names.push(...clause.namedBindings.elements.map((element) => element.name.text))
    }
  }
  return [...new Set(names)]
}

function exportClauseNames(clause: LooseOptional<ts.NamedExportBindings>): string[] {
  if (!clause) return ['*']
  if (ts.isNamespaceExport(clause)) return [clause.name.text]
  return [...new Set(clause.elements.map((element) => element.name.text))]
}

function pushImportRecord(
  records: JsTsImportRecord[],
  sourceFile: ts.SourceFile,
  path: string,
  node: ts.Node,
  kind: JsTsImportRecord['kind'],
  specifier: string,
  options: { isTypeOnly?: boolean; importedNames?: string[] } = {}
): void {
  const position = nodePosition(sourceFile, node)
  records.push({
    path,
    line: position.line,
    column: position.column,
    kind,
    specifier,
    isRelative: specifier.startsWith('.'),
    isTypeOnly: !!options.isTypeOnly,
    importedNames: options.importedNames ?? [],
    raw: compactStatement(node.getText(sourceFile)),
  })
}

function extractImportsFromContent(path: string, content: string): JsTsImportRecord[] {
  const sourceFile = parseJsTsSource(path, content)
  const records: JsTsImportRecord[] = []

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier)
      if (specifier) {
        pushImportRecord(records, sourceFile, path, node, 'import', specifier, {
          isTypeOnly: !!node.importClause?.isTypeOnly,
          importedNames: importClauseNames(node.importClause),
        })
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier)
      if (specifier) {
        pushImportRecord(records, sourceFile, path, node, 'export-from', specifier, {
          isTypeOnly: node.isTypeOnly,
          importedNames: exportClauseNames(node.exportClause),
        })
      }
    } else if (ts.isCallExpression(node)) {
      const specifier = stringLiteralText(node.arguments[0])
      if (specifier && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const declaration = ts.isVariableDeclaration(node.parent) ? node.parent : null
        pushImportRecord(records, sourceFile, path, node, 'require', specifier, {
          importedNames: declaration ? bindingNames(declaration.name) : [],
        })
      } else if (specifier && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        pushImportRecord(records, sourceFile, path, node, 'dynamic-import', specifier)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  const seen = new Set<string>()
  return records.filter((record) => {
    const key = `${record.path}:${record.line}:${record.column}:${record.kind}:${record.specifier}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pushExportRecord(
  records: JsTsExportRecord[],
  sourceFile: ts.SourceFile,
  path: string,
  node: ts.Node,
  name: string,
  kind: string,
  options: { localName?: string; source?: string; reExport?: boolean } = {}
): void {
  const position = nodePosition(sourceFile, node)
  records.push({
    path,
    line: position.line,
    column: position.column,
    name,
    kind,
    localName: options.localName,
    source: options.source,
    reExport: !!options.reExport,
  })
}

function declarationExportName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  )
    return node.name?.text
  return undefined
}

function declarationExportKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isModuleDeclaration(node)) return 'namespace'
  return 'export'
}

function extractExportsFromContent(path: string, content: string): JsTsExportRecord[] {
  const sourceFile = parseJsTsSource(path, content)
  const records: JsTsExportRecord[] = []

  function visit(node: ts.Node): void {
    if (isExportedNode(node)) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          const names = bindingNames(declaration.name)
          const kind =
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
              ? 'function'
              : 'variable'
          for (const name of names) {
            pushExportRecord(records, sourceFile, path, declaration, name, kind)
          }
        }
      } else {
        const name = declarationExportName(node)
        if (name) {
          pushExportRecord(records, sourceFile, path, node, name, declarationExportKind(node))
        } else if (hasDefaultModifier(node)) {
          pushExportRecord(records, sourceFile, path, node, 'default', 'default')
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const source = stringLiteralText(node.moduleSpecifier) || undefined
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          pushExportRecord(records, sourceFile, path, element, element.name.text, 'export', {
            localName: element.propertyName?.text ?? element.name.text,
            source,
            reExport: !!source,
          })
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause)) {
        pushExportRecord(
          records,
          sourceFile,
          path,
          node.exportClause,
          node.exportClause.name.text,
          'export',
          {
            localName: '*',
            source,
            reExport: !!source,
          }
        )
      } else if (source) {
        pushExportRecord(records, sourceFile, path, node, '*', 'export', {
          source,
          reExport: true,
        })
      }
    } else if (ts.isExportAssignment(node)) {
      const localName = optionalWhenLazy(
        ts.isIdentifier(node.expression),
        () => (node.expression as ts.Identifier).text
      )
      pushExportRecord(
        records,
        sourceFile,
        path,
        node,
        node.isExportEquals ? '=' : 'default',
        'default',
        {
          localName,
        }
      )
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  const seen = new Set<string>()
  return records.filter((record) => {
    const key = `${record.path}:${record.name}:${record.kind}:${record.line}:${record.source ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isSymbolExported(symbol: KernelSymbol, content: string): boolean {
  if (symbol.exported || isTrue(symbol.metadata?.exported)) return true
  if (symbol.kind === 'import') return false

  const exports = extractExportsFromContent(symbol.path ?? '', content)
  return exports.some((record) => record.name === symbol.name || record.localName === symbol.name)
}

function toSymbolRecord(path: string, symbol: KernelSymbol, content: string): JsTsSymbolRecord {
  return {
    path,
    name: symbol.name,
    kind: symbol.kind ?? 'unknown',
    container: symbol.container,
    line: symbol.range?.startLine ?? symbol.line ?? 1,
    column: symbol.range?.startColumn ?? symbol.column ?? 1,
    exported: isSymbolExported({ ...symbol, path }, content),
    adapterId: symbol.adapterId,
  }
}

function dedupeSymbols(symbols: JsTsSymbolRecord[]): JsTsSymbolRecord[] {
  const byKey = new Map<string, JsTsSymbolRecord>()
  for (const symbol of symbols) {
    const key = `${symbol.path}:${symbol.name}:${symbol.kind}:${symbol.container ?? ''}:${symbol.line}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, symbol)
      continue
    }
    if (!existing.exported && symbol.exported) {
      byKey.set(key, { ...existing, exported: true })
    }
  }
  return [...byKey.values()]
}

async function collectSymbolRecords(
  ctx: LanguageToolContext,
  input: FindSymbolsInput
): Promise<LanguageSymbolResult> {
  const limit = input.limit ?? DefaultLimit
  const selection = await collectJsTsFiles(ctx, {
    path: input.path,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    maxFiles: Math.min(5000, Math.max(limit * 25, 500)),
  })
  const kernel = await ctx.project.kernel()
  const query = input.query?.trim()
  const kinds = new Set(input.kinds?.map((kind) => kind.toLowerCase()))
  const symbols: JsTsSymbolRecord[] = []
  let scannedSymbols = 0

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    const rawSymbols = (await kernel.listSymbols(file)) as KernelSymbol[]
    for (const raw of rawSymbols) {
      if (!raw.name) continue
      scannedSymbols += 1
      const symbol = toSymbolRecord(file, raw, content)
      if (symbol.kind === 'import' && !kinds.has('import')) continue
      if (input.exportedOnly && !symbol.exported) continue
      if (kinds.size && !kinds.has(symbol.kind.toLowerCase())) continue
      if (query) {
        const haystack = [symbol.name, symbol.container, symbol.path].filter(Boolean).join(' ')
        const matched = input.exact
          ? symbol.name === query || `${symbol.container ?? ''}.${symbol.name}` === query
          : haystack.toLowerCase().includes(query.toLowerCase())
        if (!matched) continue
      }
      symbols.push(symbol)
    }
  }

  const deduped = dedupeSymbols(symbols).sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line
  )
  return {
    symbols: deduped
      .slice(0, limit)
      .map((symbol) => ({ ...symbol, language: jsTsLanguageService.id })),
    symbolCount: deduped.length,
    scannedFiles: selection.files.length,
    scannedSymbols,
    fileListTruncated: selection.truncated,
    truncated: deduped.length > limit,
  }
}

async function collectImportRecords(
  ctx: LanguageToolContext,
  input: FindImportsInput
): Promise<LanguageImportResult> {
  const limit = input.limit ?? DefaultLimit
  const selection = await collectJsTsFiles(ctx, {
    path: input.path,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    maxFiles: Math.min(5000, Math.max(limit * 40, 500)),
  })
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
    imports: records
      .slice(0, limit)
      .map((record) => ({ ...record, language: jsTsLanguageService.id })),
    importCount: records.length,
    scannedFiles: selection.files.length,
    fileListTruncated: selection.truncated,
    truncated: records.length > limit,
  }
}

async function collectExportRecords(
  ctx: LanguageToolContext,
  input: ListExportsInput
): Promise<LanguageExportResult> {
  const limit = input.limit ?? DefaultLimit
  const selection = await collectJsTsFiles(ctx, {
    path: input.path,
    extensions: input.extensions,
    maxDepth: input.maxDepth,
    maxFiles: Math.min(5000, Math.max(limit * 30, 500)),
  })
  const records: JsTsExportRecord[] = []

  for (const file of selection.files) {
    const content = await readSourceFile(ctx, file)
    if (!isPresent(content)) continue
    const syntaxExports = extractExportsFromContent(file, content)
    for (const record of syntaxExports) {
      if (isFalse(input.includeReExports) && record.reExport) continue
      if (input.query && !record.name.toLowerCase().includes(input.query.toLowerCase())) continue
      records.push(record)
    }

    const symbols = await collectSymbolRecords(ctx, {
      path: file,
      exportedOnly: true,
      limit: 1000,
      exact: false,
    })
    for (const symbol of symbols.symbols) {
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

  return {
    exports: deduped
      .slice(0, limit)
      .map((record) => ({ ...record, language: jsTsLanguageService.id })),
    exportCount: deduped.length,
    scannedFiles: selection.files.length,
    fileListTruncated: selection.truncated,
    truncated: deduped.length > limit,
  }
}

function stripJsTsExtension(path: string): string {
  return normalizePath(path).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i, '')
}

function importTargetCandidates(importerPath: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return []
  const base = normalizePath(
    nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(importerPath), specifier))
  )
  const candidates = [
    base,
    ...DefaultJsTsExtensions.map((extension) => `${base}.${extension}`),
    ...DefaultJsTsExtensions.map((extension) => `${base}/index.${extension}`),
  ]
  return [...new Set(candidates.map(normalizePath))]
}

function resolveImportedPath(
  importerPath: string,
  specifier: string,
  fileSet: Set<string>
): Nullable<string> {
  for (const candidate of importTargetCandidates(importerPath, specifier)) {
    if (fileSet.has(candidate)) return candidate
  }
  return null
}

function importMatchesTarget(
  record: JsTsImportRecord,
  input: { specifier?: string; targetPath?: string },
  fileSet: Set<string>
): boolean {
  if (input.specifier && record.specifier === input.specifier) return true
  if (!input.targetPath || !record.isRelative) return false

  const target = normalizePath(input.targetPath)
  const resolved = resolveImportedPath(record.path, record.specifier, fileSet)
  if (resolved)
    return resolved === target || stripJsTsExtension(resolved) === stripJsTsExtension(target)

  return importTargetCandidates(record.path, record.specifier).some(
    (candidate) =>
      candidate === target || stripJsTsExtension(candidate) === stripJsTsExtension(target)
  )
}

async function collectImporters(
  ctx: LanguageToolContext,
  input: FindImportersInput
): Promise<LanguageImporterResult> {
  return scanImporters(ctx, input, DefaultJsTsExtensions, (file, content, fileSet) => {
    const matches: Array<JsTsImportRecord & { resolvedPath?: string; language: string }> = []
    for (const record of extractImportsFromContent(file, content)) {
      if (!input.includeReExports && record.kind === 'export-from') continue
      if (!importMatchesTarget(record, input, fileSet)) continue
      matches.push({
        ...record,
        resolvedPath: optionalWhenLazy(
          record.isRelative,
          () => resolveImportedPath(record.path, record.specifier, fileSet) || undefined
        ),
        language: jsTsLanguageService.id,
      })
    }
    return matches
  })
}

async function collectReferences(
  ctx: LanguageToolContext,
  input: FindReferencesInput
): Promise<LanguageReferenceResult> {
  return scanReferences(ctx, input, DefaultJsTsExtensions, (file, content, isMatch, remaining) => {
    const matches: LanguageReferenceRecord[] = []
    const sourceFile = parseJsTsSource(file, content)
    const visit = (node: ts.Node): void => {
      if (matches.length >= remaining) return
      if (ts.isIdentifier(node) && isMatch(node.getText(sourceFile))) {
        const position = nodePosition(sourceFile, node)
        matches.push({
          path: file,
          language: jsTsLanguageService.id,
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

// 目录诊断的两道闸：文件数上限与耗时预算。同属一个程序的文件共用一次程序构建，常规目录远在
// 预算之内；预算兜住超大程序或慢盘，超出时带说明返回已完成的部分，由调用方缩小 path 续查。
const MaxDiagnosticFiles = 200
const DiagnosticTimeBudgetMs = 20_000
const MissingStandardLibraryReason =
  '未找到 TypeScript 标准库声明（lib.*.d.ts），类型诊断不可用，只返回了语法诊断。' +
  '这是运行环境缺少标准库，不代表代码存在类型错误。'
const NoJsTsExtensionNote =
  `extensions 里没有 JavaScript/TypeScript 扩展名（${DefaultJsTsExtensions.join('/')}），` +
  '未做诊断。这不代表代码没有错误。'
// 依赖与构建目录在遍历中直接剪枝，与 TypeScriptProjectHost 枚举磁盘源码的规则一致；
// 没有 .gitignore 的项目里 node_modules 否则会按目录序先占满文件名额。
const SkippedDirectoryGlobs = [...SkippedDirectoryNames].map((name) => `**/${name}`)

interface DiagnosticFileSelection {
  files: string[]
  truncated: boolean
  /** 一个文件都没选中时的原因；非空选择不使用。 */
  emptyNote: string
  /** 调用方传入但本服务不诊断的扩展名说明，无论是否选中文件都随结果返回。 */
  extensionNote?: string
}

function emptyDiagnostics(note: string): LanguageDiagnosticsResult {
  return { diagnostics: [], diagnosticCount: 0, scannedFiles: 0, truncated: false, note }
}

async function selectDiagnosticFiles(
  ctx: LanguageToolContext,
  rootPath: string,
  input: LanguageDiagnosticsInput
): Promise<DiagnosticFileSelection> {
  const target = resolveProjectPath(rootPath, input.path)
  const stats = statSync(target.absolutePath, { throwIfNoEntry: false })
  if (!stats) throw new AppError('NOT_FOUND', `诊断路径不存在：${target.relativePath}`)

  if (!stats.isDirectory()) {
    const isSource = TypeScriptExtensions.has(nodePath.extname(target.absolutePath).toLowerCase())
    return {
      files: isSource ? [target.relativePath] : [],
      truncated: false,
      emptyNote: `${target.relativePath} 不是 JavaScript/TypeScript 源文件，未做诊断。`,
    }
  }

  // 只有 JS/TS 扩展名的文件能进入 TS 程序；其它扩展名（vue、json…）的文件交给语言服务会直接
  // 抛错，所以选文件前就收窄到 JS/TS 子集，被剔除的扩展名在结果里说明。
  const requestedExtensions = normalizeExtensionsWithDefault(
    input.extensions,
    DefaultJsTsExtensions
  )
  const isJsTsExtension = (extension: string): boolean => TypeScriptExtensions.has(`.${extension}`)
  const extensions = requestedExtensions.filter(isJsTsExtension)
  const ignoredExtensions = requestedExtensions.filter((extension) => !isJsTsExtension(extension))
  const extensionNote = optionalWhen(
    !isEmpty(ignoredExtensions),
    `JavaScript/TypeScript 诊断不处理扩展名 ${ignoredExtensions.join('/')}，这些文件未做诊断。`
  )
  if (isEmpty(extensions)) return { files: [], truncated: false, emptyNote: NoJsTsExtensionNote }

  const maxDepth = input.maxDepth ?? DefaultNavigationMaxDepth
  const selection = await collectJsTsFiles(ctx, {
    path: target.relativePath,
    extensions,
    maxDepth,
    maxFiles: MaxDiagnosticFiles,
    // 构建产物（dist/*.js、*.d.ts）通常被 .gitignore 忽略；诊断它们只会挤占名额、制造噪音。
    excludeGitignored: true,
    exclude: SkippedDirectoryGlobs,
  })
  return {
    ...selection,
    extensionNote,
    emptyNote:
      `${extensionNote ?? ''}未找到可诊断的源文件：${target.relativePath} 下 ${maxDepth} 层以内` +
      `没有扩展名为 ${extensions.join('/')} 的文件（已跳过 .gitignore 忽略的文件与 ` +
      `${[...SkippedDirectoryNames].join('/')} 目录）。这不代表代码没有错误。`,
  }
}

async function collectDiagnostics(
  ctx: LanguageToolContext,
  input: LanguageDiagnosticsInput
): Promise<LanguageDiagnosticsResult> {
  ctx.abortSignal.throwIfAborted()
  const limit = input.limit ?? DefaultLimit
  const rootPath = ctx.project.getRootPath()
  const selection = await selectDiagnosticFiles(ctx, rootPath, input)
  if (isEmpty(selection.files)) return emptyDiagnostics(selection.emptyNote)

  const deadline = Date.now() + DiagnosticTimeBudgetMs
  const diagnostics: LanguageDiagnosticRecord[] = []
  let standardLibraryAvailable = true
  let scannedFiles = 0
  let unreadableFiles = 0
  let outOfTime = false
  const absolutePaths = selection.files.map((file) => nodePath.resolve(rootPath, file))
  for (const group of groupFilesByTypeScriptProject(rootPath, absolutePaths)) {
    const contents = new Map<string, string>()
    for (const absolutePath of group) {
      const content = safeReadTypeScriptProjectFile(absolutePath)
      if (isPresent(content)) contents.set(absolutePath, content)
      else unreadableFiles += 1
    }
    const [requestPath] = contents.keys()
    if (!isPresent(requestPath)) continue

    // 整组文件作为根文件与 overlay 交给一次 acquire：程序只构建一次，
    // 不在任何配置 include 里的文件（如测试目录）也按所属配置诊断。
    const acquireGroup = (): ReturnType<typeof acquireTypeScriptLanguageService> =>
      acquireTypeScriptLanguageService(rootPath, requestPath, [...contents.keys()], contents)
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
      // 标准库缺席时语义层与建议层会把 Record/Set 等全局名全部报成缺失，只保留语法层结果。
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
        const record = mapTypeScriptDiagnostic(rootPath, files, diagnostic)
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
      `源文件超过 ${MaxDiagnosticFiles} 个，只选取了目录遍历先遇到的 ${MaxDiagnosticFiles} 个。`
    ),
    optionalWhen(
      outOfTime,
      `诊断耗时超过 ${DiagnosticTimeBudgetMs / 1000} 秒，选中的 ${selection.files.length} ` +
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
    degraded: optionalWhen(!standardLibraryAvailable, MissingStandardLibraryReason),
    note: optionalWhen(!isEmpty(notes), notes.join('')),
  }
}

export const jsTsLanguageService: LanguageNavigationService = {
  id: 'jsts',
  label: 'JavaScript / TypeScript',
  extensions: DefaultJsTsExtensions,
  findSymbols: collectSymbolRecords,
  listExports: collectExportRecords,
  findImports: collectImportRecords,
  findReferences: collectReferences,
  findImporters: collectImporters,
  getDiagnostics: collectDiagnostics,
}
