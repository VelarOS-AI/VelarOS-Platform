import nodePath from 'node:path'

import * as ts from 'typescript'

import { isTrue, optionalWhenLazy } from '@velaros-ai/core'

import type {
  JsTsExportRecord,
  JsTsImportRecord,
  JsTsSymbolRecord,
  KernelSymbol,
} from '../types/syntax.js'

import { compactStatement, normalizeSourcePath } from './source-files.js'

/** 按扩展名选 TypeScript 的脚本种类，jsx/tsx 要选对才解析得了 JSX。 */
function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.mjs') || path.endsWith('.cjs') || path.endsWith('.js'))
    return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** 把一份正文解析成语法树（带父指针，位置换算与取原文都要它）。 */
export function parseJsTsSource(path: string, content: string): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindForPath(path))
}

/** 节点起始处的行列，从 1 起。 */
export function nodePosition(
  sourceFile: ts.SourceFile,
  node: ts.Node
): { line: number; column: number } {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return { line: position.line + 1, column: position.character + 1 }
}

/** 取字符串字面量（含无插值模板串）的正文；不是字面量就给 null。 */
function stringLiteralText(node: LooseOptional<ts.Node>): LooseOptional<string> {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/** 节点上有没有某个修饰符。 */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
}

/** 这个声明带没带 `export`。 */
function isExportedNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword)
}

/** 这个声明带没带 `default`。 */
function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword)
}

/** 解构绑定里出现的全部名字。 */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
    return name.elements.flatMap((element) =>
      ts.isBindingElement(element) ? bindingNames(element.name) : []
    )
  return []
}

/** `import` 子句引进来的名字（默认导入、命名空间导入、命名导入）。 */
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

/** `export … from` 子句转出去的名字；`export * from` 给 `*`。 */
function exportClauseNames(clause: LooseOptional<ts.NamedExportBindings>): string[] {
  if (!clause) return ['*']
  if (ts.isNamespaceExport(clause)) return [clause.name.text]
  return [...new Set(clause.elements.map((element) => element.name.text))]
}

/** 把一条引入语句记进结果。 */
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

/** 解析一个文件里全部的 import / export-from / require / 动态 import。 */
export function extractImportsFromContent(path: string, content: string): JsTsImportRecord[] {
  const sourceFile = parseJsTsSource(path, content)
  const records: JsTsImportRecord[] = []

  const visit = (node: ts.Node): void => {
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

/** 把一条导出记进结果。 */
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

/** 带名字的声明（函数、类、接口、类型、枚举、命名空间）的名字。 */
function declarationExportName(node: ts.Node): Optional<string> {
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

/** 带名字的声明对应的导出种类词。 */
function declarationExportKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isModuleDeclaration(node)) return 'namespace'
  return 'export'
}

/** 解析一个文件里全部的导出（含转发与 `export =`）。 */
export function extractExportsFromContent(path: string, content: string): JsTsExportRecord[] {
  const sourceFile = parseJsTsSource(path, content)
  const records: JsTsExportRecord[] = []

  const visit = (node: ts.Node): void => {
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
        { localName }
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

/** 一批导出记录里所有对外可见的名字（含 `export { local as name }` 的本地名）。 */
export function exportedNamesOf(records: readonly JsTsExportRecord[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const record of records) {
    names.add(record.name)
    if (record.localName) names.add(record.localName)
  }
  return names
}

/**
 * 一个文件只解析一次导出名，解析结果记在闭包里按需取。
 *
 * 原先每个「内核没标 exported 的符号」都整文件重解析一次：900 行的文件单次解析约 1.3 ms、
 * 声明约 220 个，一个文件就要约 290 ms，而 find_symbols 缺省最多扫 2,500 个文件。
 */
export function createExportedNamesReader(
  path: string,
  content: string
): () => ReadonlySet<string> {
  let names: Nullable<ReadonlySet<string>> = null
  return () => {
    names ??= exportedNamesOf(extractExportsFromContent(path, content))
    return names
  }
}

/** 内核没标 exported 时，回落到语法层的导出名集合判断。 */
function isSymbolExported(
  symbol: KernelSymbol,
  readExportedNames: () => ReadonlySet<string>
): boolean {
  if (symbol.exported || isTrue(symbol.metadata?.exported)) return true
  if (symbol.kind === 'import') return false

  return readExportedNames().has(symbol.name)
}

/** 把内核符号表的一条补齐成 JS/TS 的符号记录。 */
export function toSymbolRecord(
  path: string,
  symbol: KernelSymbol,
  readExportedNames: () => ReadonlySet<string>
): JsTsSymbolRecord {
  return {
    path,
    name: symbol.name,
    kind: symbol.kind ?? 'unknown',
    container: symbol.container,
    line: symbol.range?.startLine ?? symbol.line ?? 1,
    column: symbol.range?.startColumn ?? symbol.column ?? 1,
    exported: isSymbolExported({ ...symbol, path }, readExportedNames),
    adapterId: symbol.adapterId,
  }
}

/** 符号是否命中 query：`exact` 时按名字或 `容器.名字` 全等，否则按名字、容器与路径的子串。 */
export function symbolMatchesQuery(
  symbol: { name: string; container?: string; path: string },
  query: string,
  exact: LooseOptional<boolean>
): boolean {
  if (exact) return symbol.name === query || `${symbol.container ?? ''}.${symbol.name}` === query
  const haystack = [symbol.name, symbol.container, symbol.path].filter(Boolean).join(' ')
  return haystack.toLowerCase().includes(query.toLowerCase())
}

/** 同一位置的同名符号合并成一条；只要有一处标了导出，合并后就算导出。 */
export function dedupeSymbols(symbols: readonly JsTsSymbolRecord[]): JsTsSymbolRecord[] {
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

/** 去掉 JS/TS 的扩展名（含 `.d.ts`），用来做「同一个模块的不同写法」比较。 */
export function stripJsTsExtension(path: string): string {
  return normalizeSourcePath(path).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/iu, '')
}

/** 一条相对说明符可能指向的全部文件写法（裸路径、各扩展名、目录 index）。 */
export function importTargetCandidates(
  importerPath: string,
  specifier: string,
  extensions: readonly string[]
): string[] {
  if (!specifier.startsWith('.')) return []
  const base = normalizeSourcePath(
    nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(importerPath), specifier))
  )
  const candidates = [
    base,
    ...extensions.map((extension) => `${base}.${extension}`),
    ...extensions.map((extension) => `${base}/index.${extension}`),
  ]
  return [...new Set(candidates.map(normalizeSourcePath))]
}

/** 在本次扫描的文件集合里把说明符解析成真实文件；解析不到给 null。 */
export function resolveImportedPath(
  importerPath: string,
  specifier: string,
  extensions: readonly string[],
  fileSet: Set<string>
): Nullable<string> {
  for (const candidate of importTargetCandidates(importerPath, specifier, extensions)) {
    if (fileSet.has(candidate)) return candidate
  }
  return null
}

/** 这条引入语句是不是指向调用方要找的目标（按说明符全等，或按解析出来的路径）。 */
export function importMatchesTarget(
  record: JsTsImportRecord,
  input: { specifier?: string; targetPath?: string },
  extensions: readonly string[],
  fileSet: Set<string>
): boolean {
  if (input.specifier && record.specifier === input.specifier) return true
  if (!input.targetPath || !record.isRelative) return false

  const target = normalizeSourcePath(input.targetPath)
  const resolved = resolveImportedPath(record.path, record.specifier, extensions, fileSet)
  if (resolved)
    return resolved === target || stripJsTsExtension(resolved) === stripJsTsExtension(target)

  return importTargetCandidates(record.path, record.specifier, extensions).some(
    (candidate) =>
      candidate === target || stripJsTsExtension(candidate) === stripJsTsExtension(target)
  )
}
