import nodePath from 'node:path'

import * as ts from 'typescript'

import { isFalse, isNumber, isPresent, isTrue, numberOrNull, toOptional } from '@velaros-ai/core'
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
  DefaultNavigationLimit,
  lineAt,
  normalizeSourcePath as normalizePath,
  readSourceFile,
  scanImporters,
  scanReferences,
  type SourceFileSelection as FileSelection,
} from './LanguageService'
import {
  acquireTypeScriptLanguageService,
  safeReadFile as safeReadTypeScriptProjectFile,
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

function resolveProjectFile(
  rootPath: string,
  inputPath: string
): {
  absolutePath: string
  relativePath: string
} {
  const absolutePath = nodePath.resolve(rootPath, inputPath)
  if (!isInsideRoot(rootPath, absolutePath)) {
    throw new AppError('VALIDATION', `path is outside project: ${inputPath}`)
  }
  return {
    absolutePath,
    relativePath: normalizePath(nodePath.relative(rootPath, absolutePath)),
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

async function collectDiagnostics(
  ctx: LanguageToolContext,
  input: LanguageDiagnosticsInput
): Promise<LanguageDiagnosticsResult> {
  ctx.abortSignal.throwIfAborted()
  const limit = input.limit ?? DefaultLimit
  const rootPath = ctx.project.getRootPath()
  const target = resolveProjectFile(rootPath, input.path)

  if (!TypeScriptExtensions.has(nodePath.extname(target.absolutePath).toLowerCase()))
    return { diagnostics: [], diagnosticCount: 0, scannedFiles: 0, truncated: false }

  const content = safeReadTypeScriptProjectFile(target.absolutePath)
  if (!isPresent(content))
    return { diagnostics: [], diagnosticCount: 0, scannedFiles: 0, truncated: false }

  const { service, files } = acquireTypeScriptLanguageService(
    rootPath,
    target.absolutePath,
    [target.absolutePath],
    new Map([[target.absolutePath, content]])
  )
  const diagnostics = [
    ...service.getSyntacticDiagnostics(target.absolutePath),
    ...service.getSemanticDiagnostics(target.absolutePath),
    ...service.getSuggestionDiagnostics(target.absolutePath),
  ]
    .map((diagnostic) => mapTypeScriptDiagnostic(rootPath, files, diagnostic))
    .filter((diagnostic): diagnostic is LanguageDiagnosticRecord => isPresent(diagnostic))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)

  return {
    diagnostics: diagnostics.slice(0, limit),
    diagnosticCount: diagnostics.length,
    scannedFiles: 1,
    truncated: diagnostics.length > limit,
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
